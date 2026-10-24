//! Streams PCM audio to Deepgram's live transcription WebSocket and forwards the
//! results to the frontend as `transcript` events.
//!
//! Each audio source gets its own connection, so "me" and "them" are labelled
//! without needing diarization.

use crate::audio::{Source, TARGET_RATE};
use anyhow::Context;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEvent {
    pub source: Source,
    pub text: String,
    /// The text for this span of audio won't change any more.
    pub is_final: bool,
    /// The speaker paused, so this is the end of a sentence or turn.
    pub speech_final: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub source: Source,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Deserialize)]
struct DgMessage {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    is_final: bool,
    #[serde(default)]
    speech_final: bool,
    channel: Option<DgChannel>,
}

#[derive(Deserialize)]
struct DgChannel {
    alternatives: Vec<DgAlternative>,
}

#[derive(Deserialize)]
struct DgAlternative {
    transcript: String,
}

pub async fn run(
    app: AppHandle,
    source: Source,
    api_key: String,
    language: String,
    mut audio: UnboundedReceiver<Vec<u8>>,
) {
    emit_status(&app, source, "connecting", None);
    let result = async {
        let url = format!(
            "wss://api.deepgram.com/v1/listen?model=nova-3&language={language}\
             &encoding=linear16&sample_rate={TARGET_RATE}&channels=1\
             &interim_results=true&smart_format=true&punctuate=true\
             &endpointing=300&utterance_end_ms=1000"
        );
        let mut request = url.into_client_request()?;
        request
            .headers_mut()
            .insert("Authorization", format!("Token {api_key}").parse()?);

        let (ws, _) = tokio_tungstenite::connect_async(request)
            .await
            .context("could not connect to Deepgram (check your API key)")?;
        let (mut tx, mut rx) = ws.split();
        emit_status(&app, source, "listening", None);

        // Deepgram closes idle sockets after ~10s. Loopback audio can go silent
        // (nothing playing), so keep the connection alive explicitly.
        let mut keepalive = tokio::time::interval(Duration::from_secs(5));

        loop {
            tokio::select! {
                chunk = audio.recv() => match chunk {
                    Some(bytes) => tx.send(Message::Binary(bytes.into())).await?,
                    None => {
                        // Session stopped: ask Deepgram to flush and close.
                        tx.send(Message::Text(r#"{"type":"CloseStream"}"#.into())).await?;
                        break;
                    }
                },
                _ = keepalive.tick() => {
                    tx.send(Message::Text(r#"{"type":"KeepAlive"}"#.into())).await?;
                }
                msg = rx.next() => match msg {
                    Some(Ok(Message::Text(text))) => handle_message(&app, source, &text),
                    Some(Ok(Message::Close(frame))) => {
                        anyhow::bail!("Deepgram closed the connection: {frame:?}")
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e.into()),
                    None => break,
                },
            }
        }

        // Drain whatever Deepgram sends back after CloseStream.
        while let Ok(Some(Ok(msg))) = tokio::time::timeout(Duration::from_secs(3), rx.next()).await {
            if let Message::Text(text) = msg {
                handle_message(&app, source, &text);
            }
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;

    match result {
        Ok(()) => emit_status(&app, source, "stopped", None),
        Err(e) => emit_status(&app, source, "error", Some(format!("{e:#}"))),
    }
}

fn handle_message(app: &AppHandle, source: Source, text: &str) {
    let Ok(msg) = serde_json::from_str::<DgMessage>(text) else { return };
    match msg.kind.as_str() {
        "Results" => {
            let Some(alt) = msg.channel.and_then(|c| c.alternatives.into_iter().next()) else {
                return;
            };
            if alt.transcript.is_empty() && !msg.speech_final {
                return;
            }
            let _ = app.emit(
                "transcript",
                TranscriptEvent {
                    source,
                    text: alt.transcript,
                    is_final: msg.is_final,
                    speech_final: msg.speech_final,
                },
            );
        }
        // Sent after `utterance_end_ms` of silence even when endpointing missed it.
        "UtteranceEnd" => {
            let _ = app.emit(
                "transcript",
                TranscriptEvent { source, text: String::new(), is_final: true, speech_final: true },
            );
        }
        _ => {}
    }
}

fn emit_status(app: &AppHandle, source: Source, status: &str, message: Option<String>) {
    let _ = app.emit(
        "transcriber-status",
        StatusEvent { source, status: status.into(), message },
    );
}
