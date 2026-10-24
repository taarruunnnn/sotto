//! Audio capture for the two sides of a call.
//!
//! - `Source::Me`   — the default microphone.
//! - `Source::Them` — system audio (whatever the meeting app is playing), captured via
//!   loopback on the default *output* device. cpal does this with WASAPI loopback on
//!   Windows and a Core Audio process tap on macOS 14.6+.
//!
//! Every stream is downmixed to mono, resampled to 16 kHz and sent out as
//! little-endian i16 PCM chunks, which is what Deepgram's `linear16` encoding expects.

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use serde::Serialize;
use tokio::sync::mpsc::UnboundedSender;

pub const TARGET_RATE: u32 = 16_000;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Me,
    Them,
}

#[derive(Serialize)]
pub struct DeviceInfo {
    id: String,
    name: String,
}

#[derive(Serialize)]
pub struct Devices {
    inputs: Vec<DeviceInfo>,
    outputs: Vec<DeviceInfo>,
}

pub fn list_devices() -> Result<Devices> {
    let host = cpal::default_host();
    let info = |d: cpal::Device| {
        Some(DeviceInfo { id: d.id().ok()?.to_string(), name: d.description().ok()?.name().to_string() })
    };
    Ok(Devices {
        inputs: host.input_devices()?.filter_map(info).collect(),
        outputs: host.output_devices()?.filter_map(info).collect(),
    })
}

/// Starts capturing `source` and pushes 16 kHz mono i16 PCM chunks into `tx`.
/// `on_level` receives the RMS level (0..1) about ten times a second, for meters.
/// `device_id` picks a device from [`list_devices`]; `None` means the system default.
/// Capture stops when the returned stream is dropped.
pub fn start_capture(
    source: Source,
    device_id: Option<&str>,
    tx: Option<UnboundedSender<Vec<u8>>>,
    on_level: impl Fn(f32) + Send + 'static,
) -> Result<cpal::Stream> {
    let host = cpal::default_host();
    let chosen = device_id
        .and_then(|id| id.parse::<cpal::DeviceId>().ok())
        .and_then(|id| host.device_by_id(&id));
    let device = match chosen {
        Some(d) => Some(d),
        None => match source {
            Source::Me => host.default_input_device(),
            // Building an *input* stream on an output device turns on loopback capture.
            Source::Them => host.default_output_device(),
        },
    }
    .ok_or_else(|| anyhow!("no {:?} audio device found", source))?;

    let config = if device.supports_input() {
        device.default_input_config()
    } else {
        device.default_output_config()
    }
    .context("failed to read the device's default audio config")?;

    let sample_format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();

    let stream = match sample_format {
        SampleFormat::F32 => build::<f32>(&device, stream_config, tx, on_level)?,
        SampleFormat::I16 => build::<i16>(&device, stream_config, tx, on_level)?,
        SampleFormat::I32 => build::<i32>(&device, stream_config, tx, on_level)?,
        SampleFormat::U16 => build::<u16>(&device, stream_config, tx, on_level)?,
        other => return Err(anyhow!("unsupported sample format {other}")),
    };
    stream.play().context("failed to start audio stream")?;
    Ok(stream)
}

fn build<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    tx: Option<UnboundedSender<Vec<u8>>>,
    on_level: impl Fn(f32) + Send + 'static,
) -> Result<cpal::Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let mut resampler = Resampler::new(config.sample_rate, TARGET_RATE);
    let mut mono = Vec::new();
    let level_every = (config.sample_rate / 10) as usize;
    let (mut level_sum, mut level_count) = (0.0f32, 0usize);

    let stream = device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            mono.clear();
            mono.extend(data.chunks(channels).map(|frame| {
                frame.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / channels as f32
            }));

            level_sum += mono.iter().map(|s| s * s).sum::<f32>();
            level_count += mono.len();
            if level_count >= level_every {
                on_level((level_sum / level_count as f32).sqrt());
                (level_sum, level_count) = (0.0, 0);
            }

            // Meter-only streams (the setup audio check) don't transcribe.
            let Some(tx) = &tx else { return };
            let pcm = resampler.process(&mono);
            if !pcm.is_empty() {
                let bytes = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
                // The receiver is gone once the session stops; nothing to do then.
                let _ = tx.send(bytes);
            }
        },
        |err| eprintln!("audio stream error: {err}"),
        None,
    )?;
    Ok(stream)
}

/// Streaming linear-interpolation resampler. Plenty for speech-to-text input.
struct Resampler {
    step: f64,
    pos: f64,
    pending: Vec<f32>,
}

impl Resampler {
    fn new(from: u32, to: u32) -> Self {
        Self { step: from as f64 / to as f64, pos: 0.0, pending: Vec::new() }
    }

    fn process(&mut self, input: &[f32]) -> Vec<i16> {
        self.pending.extend_from_slice(input);
        let mut out = Vec::with_capacity((input.len() as f64 / self.step) as usize + 1);
        while (self.pos as usize) + 1 < self.pending.len() {
            let i = self.pos as usize;
            let frac = (self.pos - i as f64) as f32;
            let s = self.pending[i] * (1.0 - frac) + self.pending[i + 1] * frac;
            out.push((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
            self.pos += self.step;
        }
        // Keep only the samples the next call still needs.
        let consumed = self.pos as usize;
        self.pending.drain(..consumed);
        self.pos -= consumed as f64;
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_48k_to_16k() {
        let mut r = Resampler::new(48_000, 16_000);
        let out: usize = (0..10).map(|_| r.process(&vec![0.5; 480]).len()).sum();
        // 4800 input samples at a 3:1 ratio, minus the one-sample lookahead.
        assert!((1599..=1600).contains(&out), "got {out}");
    }
}
