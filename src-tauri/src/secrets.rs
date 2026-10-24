//! API keys live in the OS credential store (macOS Keychain, Windows Credential
//! Manager) rather than in `settings.json`. Each secret is its own entry, which keeps
//! every value well under Windows' 2.5 KB credential size limit.

use keyring::Entry;

const SERVICE: &str = "app.sotto.desktop";

fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

/// Returns an empty string when nothing is stored under `name`.
#[tauri::command]
pub async fn get_secret(name: String) -> Result<String, String> {
    match entry(&name)?.get_password() {
        Ok(value) => Ok(value),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Stores `value` under `name`; an empty value deletes the entry.
#[tauri::command]
pub async fn set_secret(name: String, value: String) -> Result<(), String> {
    let entry = entry(&name)?;
    if value.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    entry.set_password(&value).map_err(|e| e.to_string())
}
