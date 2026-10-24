mod audio;
mod deepgram;
mod net;
mod stealth;

use audio::Source;
use base64::Engine;
use serde::Serialize;
use std::io::Cursor;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

#[derive(Default)]
struct AppState {
    // Dropping a stream stops capture and closes its channel, which tells the
    // matching Deepgram task to flush and exit.
    session: Mutex<Vec<cpal::Stream>>,
    /// Meter-only capture for the setup screen's audio check.
    audio_test: Mutex<Vec<cpal::Stream>>,
    click_through: Mutex<bool>,
}

#[derive(Clone, Serialize)]
struct LevelEvent {
    source: Source,
    level: f32,
}

fn level_emitter(app: &AppHandle, source: Source) -> impl Fn(f32) + Send + 'static {
    let app = app.clone();
    move |level| {
        let _ = app.emit("audio-level", LevelEvent { source, level });
    }
}

fn sources(capture_mic: bool) -> Vec<Source> {
    if capture_mic { vec![Source::Them, Source::Me] } else { vec![Source::Them] }
}

fn device_for(source: Source, mic: &Option<String>, output: &Option<String>) -> Option<String> {
    match source {
        Source::Me => mic.clone(),
        Source::Them => output.clone(),
    }
}

#[tauri::command]
fn start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    deepgram_key: String,
    language: String,
    capture_mic: bool,
    mic_device: Option<String>,
    output_device: Option<String>,
) -> Result<(), String> {
    if deepgram_key.trim().is_empty() {
        return Err("Add your Deepgram API key in Settings first.".into());
    }
    let mut session = state.session.lock().unwrap();
    if !session.is_empty() {
        return Ok(());
    }
    // The audio check holds the same devices; a session replaces it.
    state.audio_test.lock().unwrap().clear();

    let mut streams = Vec::new();
    for source in sources(capture_mic) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let device = device_for(source, &mic_device, &output_device);
        let stream = audio::start_capture(source, device.as_deref(), Some(tx), level_emitter(&app, source))
            .map_err(|e| format!("Could not capture {source:?} audio: {e:#}"))?;
        streams.push(stream);
        tauri::async_runtime::spawn(deepgram::run(
            app.clone(),
            source,
            deepgram_key.trim().to_string(),
            language.clone(),
            rx,
        ));
    }

    *session = streams;
    Ok(())
}

#[tauri::command]
fn stop_session(state: State<'_, AppState>) {
    state.session.lock().unwrap().clear();
}

#[tauri::command]
fn start_audio_test(
    app: AppHandle,
    state: State<'_, AppState>,
    mic_device: Option<String>,
    output_device: Option<String>,
) -> Result<(), String> {
    let mut streams = Vec::new();
    for source in sources(true) {
        let device = device_for(source, &mic_device, &output_device);
        let stream = audio::start_capture(source, device.as_deref(), None, level_emitter(&app, source))
            .map_err(|e| format!("Could not capture {source:?} audio: {e:#}"))?;
        streams.push(stream);
    }
    *state.audio_test.lock().unwrap() = streams;
    Ok(())
}

#[tauri::command]
fn stop_audio_test(state: State<'_, AppState>) {
    state.audio_test.lock().unwrap().clear();
}

#[tauri::command]
fn list_audio_devices() -> Result<audio::Devices, String> {
    audio::list_devices().map_err(|e| e.to_string())
}

/// Screenshot of the monitor under the overlay, as a base64 PNG. The overlay itself
/// is content-protected, so it doesn't show up in its own screenshots.
#[tauri::command]
async fn capture_screen(app: AppHandle) -> Result<String, String> {
    let window = app.get_webview_window("main").ok_or("main window missing")?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let monitor = xcap::Monitor::from_point(pos.x, pos.y)
            .or_else(|_| {
                xcap::Monitor::all()?
                    .into_iter()
                    .find(|m| m.is_primary().unwrap_or(false))
                    .ok_or(xcap::XCapError::new("no monitor found"))
            })
            .map_err(|e| format!("Screen capture failed (grant Screen Recording permission?): {e}"))?;
        let mut image = monitor.capture_image().map_err(|e| e.to_string())?;

        // Retina screenshots are huge; vision models don't need more than this, and
        // smaller images upload and process faster.
        const MAX_WIDTH: u32 = 1440;
        if image.width() > MAX_WIDTH {
            let height = image.height() * MAX_WIDTH / image.width();
            image = image::imageops::resize(&image, MAX_WIDTH, height, image::imageops::FilterType::Triangle);
        }

        // JPEG is ~5x smaller than PNG for screenshots, at no cost to legibility.
        let rgb = image::DynamicImage::ImageRgba8(image).into_rgb8();
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut Cursor::new(&mut jpeg), 85)
            .encode_image(&rgb)
            .map_err(|e| e.to_string())?;
        Ok(base64::engine::general_purpose::STANDARD.encode(jpeg))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn set_stealth(app: AppHandle, enabled: bool) -> Result<(), String> {
    stealth::apply(&app, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_click_through(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main window missing")?;
    window.set_ignore_cursor_events(enabled).map_err(|e| e.to_string())?;
    *state.click_through.lock().unwrap() = enabled;
    let _ = app.emit("click-through", enabled);
    Ok(())
}

/// Cmd on macOS, Ctrl everywhere else.
const PRIMARY: Modifiers = if cfg!(target_os = "macos") { Modifiers::SUPER } else { Modifiers::CONTROL };

fn shortcuts() -> Vec<(Shortcut, &'static str)> {
    let s = |m: Modifiers, c: Code| Shortcut::new(Some(m), c);
    vec![
        (s(PRIMARY, Code::Enter), "answer"),
        (s(PRIMARY | Modifiers::SHIFT, Code::Enter), "suggest"),
        (s(PRIMARY | Modifiers::SHIFT, Code::KeyS), "screenshot"),
        (s(PRIMARY | Modifiers::SHIFT, Code::KeyA), "add-screenshot"),
        (s(PRIMARY, Code::Backslash), "toggle-visibility"),
        (s(PRIMARY | Modifiers::SHIFT, Code::KeyM), "click-through"),
        (s(PRIMARY | Modifiers::SHIFT, Code::BracketLeft), "previous-answer"),
        (s(PRIMARY | Modifiers::SHIFT, Code::BracketRight), "next-answer"),
        (s(PRIMARY, Code::ArrowUp), "move-up"),
        (s(PRIMARY, Code::ArrowDown), "move-down"),
        (s(PRIMARY, Code::ArrowLeft), "move-left"),
        (s(PRIMARY, Code::ArrowRight), "move-right"),
    ]
}

fn toggle_visibility(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = if window.is_visible().unwrap_or(true) { window.hide() } else { window.show() };
}

fn on_shortcut(app: &AppHandle, action: &str) {
    let Some(window) = app.get_webview_window("main") else { return };
    match action {
        "toggle-visibility" => toggle_visibility(app),
        "click-through" => {
            let state = app.state::<AppState>();
            let enabled = !*state.click_through.lock().unwrap();
            let _ = set_click_through(app.clone(), state, enabled);
        }
        a if a.starts_with("move-") => {
            const STEP: i32 = 60;
            if let Ok(pos) = window.outer_position() {
                let (dx, dy) = match a {
                    "move-up" => (0, -STEP),
                    "move-down" => (0, STEP),
                    "move-left" => (-STEP, 0),
                    _ => (STEP, 0),
                };
                let _ = window.set_position(tauri::PhysicalPosition::new(pos.x + dx, pos.y + dy));
            }
        }
        // Everything else is handled by the UI.
        other => {
            let _ = app.emit("shortcut", other);
        }
    }
}

/// With no Dock icon or taskbar button, the tray icon is how people find the app.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Sotto", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &settings, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main").menu(&menu).tooltip("Sotto");
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| match event.id.as_ref() {
        "toggle" => toggle_visibility(app),
        "settings" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
            }
            let _ = app.emit("open-view", "settings");
        }
        "quit" => app.exit(0),
        _ => {}
    })
    .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let bindings = shortcuts();
    let registered: Vec<Shortcut> = bindings.iter().map(|(s, _)| *s).collect();

    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(registered)
                .expect("invalid global shortcut")
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if let Some((_, action)) = bindings.iter().find(|(s, _)| s == shortcut) {
                        on_shortcut(app, action);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Stealth is on by default; the UI applies the saved preference on load.
            stealth::apply(app.handle(), true)?;
            build_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_session,
            stop_session,
            start_audio_test,
            stop_audio_test,
            list_audio_devices,
            capture_screen,
            set_stealth,
            set_click_through,
            net::proxy_fetch,
            net::proxy_abort,
            net::warm
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
