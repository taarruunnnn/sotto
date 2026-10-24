//! Window-level privacy for the overlay.
//!
//! When enabled:
//! - the window is excluded from screen sharing, recordings and screenshots
//!   (`NSWindowSharingNone` on macOS, `WDA_EXCLUDEFROMCAPTURE` on Windows);
//! - there is no Dock icon (macOS) and no taskbar button (Windows);
//! - the window floats above everything, on every Space, including fullscreen apps.
//!
//! Capture exclusion is honoured by the OS's own capture APIs, which is what Zoom,
//! Meet (in Chrome), Teams and OBS use, but test with the tools you care about.
//! A phone camera pointed at the screen will obviously still see it.

use tauri::{AppHandle, Manager};

pub fn apply(app: &AppHandle, enabled: bool) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else { return Ok(()) };

    window.set_content_protected(enabled)?;
    window.set_skip_taskbar(enabled)?;
    window.set_always_on_top(true)?;
    window.set_visible_on_all_workspaces(true)?;

    #[cfg(target_os = "macos")]
    {
        // Accessory apps have no Dock icon and don't appear in Cmd+Tab.
        let policy = if enabled {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        };
        app.set_activation_policy(policy)?;
    }
    Ok(())
}
