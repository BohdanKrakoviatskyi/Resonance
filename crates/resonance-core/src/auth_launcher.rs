use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundCloudAuthCapture {
    pub client_id: String,
    pub token: String,
    #[serde(default)]
    pub datadome: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthProvider {
    SoundCloud,
    YtMusic,
}

fn find_auth_binary() -> PathBuf {
    let bin_name = if cfg!(windows) {
        "resonance-auth.exe"
    } else {
        "resonance-auth"
    };

    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent() {
            let sibling = dir.join(bin_name);
            if sibling.exists() {
                return sibling;
            }
        }

    for candidate in [
        PathBuf::from("target/release").join(bin_name),
        PathBuf::from("target/debug").join(bin_name),
    ] {
        if candidate.exists() {
            return candidate;
        }
    }

    PathBuf::from(bin_name)
}

pub async fn launch_soundcloud_auth() -> Result<Option<SoundCloudAuthCapture>, String> {
    let bin = find_auth_binary();
    let out = Command::new(&bin)
        .args(["--provider", "soundcloud"])
        .output()
        .await
        .map_err(|e| format!("could not launch resonance-auth ({}): {e}", bin.display()))?;

    if !out.status.success() {
        if out.status.code() == Some(2) {
            return Ok(None);
        }
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("auth helper exited with {}", out.status)
        } else {
            err
        });
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().last().unwrap_or("").trim();
    if line.is_empty() {
        return Ok(None);
    }
    serde_json::from_str::<SoundCloudAuthCapture>(line)
        .map(Some)
        .map_err(|e| format!("invalid SoundCloud auth payload: {e}"))
}

pub async fn launch_ytmusic_auth() -> Result<Option<HashMap<String, String>>, String> {
    let bin = find_auth_binary();
    let out = Command::new(&bin)
        .args(["--provider", "ytmusic"])
        .output()
        .await
        .map_err(|e| format!("could not launch resonance-auth ({}): {e}", bin.display()))?;

    if !out.status.success() {
        if out.status.code() == Some(2) {
            return Ok(None);
        }
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("auth helper exited with {}", out.status)
        } else {
            err
        });
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().last().unwrap_or("").trim();
    if line.is_empty() {
        return Ok(None);
    }
    serde_json::from_str::<HashMap<String, String>>(line)
        .map(Some)
        .map_err(|e| format!("invalid YouTube Music auth payload: {e}"))
}
