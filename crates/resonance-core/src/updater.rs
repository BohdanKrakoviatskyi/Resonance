use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const GITHUB_RELEASES_URL: &str = "https://github.com/BohdanKrakoviatskyi/Resonance/releases/latest";
pub const GITHUB_LATEST_MANIFEST_URL: &str =
    "https://github.com/BohdanKrakoviatskyi/Resonance/releases/latest/download/latest.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub checking: bool,
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_url: String,
    pub download_url: String,
    pub notes: String,
    pub error: String,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            checking: false,
            available: false,
            current_version: APP_VERSION.to_string(),
            latest_version: APP_VERSION.to_string(),
            release_url: GITHUB_RELEASES_URL.to_string(),
            download_url: GITHUB_RELEASES_URL.to_string(),
            notes: String::new(),
            error: String::new(),
        }
    }
}

pub fn parse_version(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split(['.', '-'])
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

pub fn is_newer_version(latest: &str, current: &str) -> bool {
    let a = parse_version(latest);
    let b = parse_version(current);
    let len = a.len().max(b.len());
    for i in 0..len {
        let av = *a.get(i).unwrap_or(&0);
        let bv = *b.get(i).unwrap_or(&0);
        if av > bv {
            return true;
        }
        if av < bv {
            return false;
        }
    }
    false
}

#[derive(Deserialize)]
struct LatestManifest {
    #[serde(default)]
    version: String,
    #[serde(default)]
    notes: String,
}

#[derive(Deserialize)]
struct GitHubRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    body: String,
}

pub async fn check_for_updates(http: &reqwest::Client) -> UpdateState {
    let mut state = UpdateState::default();

    let manifest = http
        .get(GITHUB_LATEST_MANIFEST_URL)
        .timeout(Duration::from_secs(5))
        .header(reqwest::header::USER_AGENT, "Resonance-Updater")
        .send()
        .await;

    if let Ok(resp) = manifest
        && resp.status().is_success()
            && let Ok(parsed) = resp.json::<LatestManifest>().await {
                let latest = parsed.version.trim().trim_start_matches(['v', 'V']).to_string();
                if !latest.is_empty() && is_newer_version(&latest, APP_VERSION) {
                    state.available = true;
                    state.latest_version = latest;
                    state.notes = parsed.notes;
                }
                return state;
            }

    let api_res = http
        .get("https://api.github.com/repos/BohdanKrakoviatskyi/Resonance/releases/latest")
        .timeout(Duration::from_secs(5))
        .header(reqwest::header::USER_AGENT, "Resonance-Updater")
        .send()
        .await;

    if let Ok(resp) = api_res
        && resp.status().is_success()
            && let Ok(rel) = resp.json::<GitHubRelease>().await {
                let latest = rel.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
                if !latest.is_empty() && is_newer_version(&latest, APP_VERSION) {
                    state.available = true;
                    state.latest_version = latest;
                    if !rel.html_url.is_empty() {
                        state.release_url = rel.html_url.clone();
                        state.download_url = rel.html_url;
                    }
                    state.notes = rel.body;
                }
            }

    state
}

pub fn open_release_page(url: &str) {
    let target = if url.is_empty() { GITHUB_RELEASES_URL } else { url };
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(target).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd").args(["/C", "start", "", target]).spawn();
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(target).spawn();
    }
}

pub fn restart_app() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        if let Some(bundle) = exe
            .ancestors()
            .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
        {
            std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg("sleep 0.5 && open -a \"$1\"")
                .arg("sh")
                .arg(bundle)
                .spawn()
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    std::process::Command::new(exe)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn uninstall_app() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for candidate in ["uninstall.exe", "unins000.exe"] {
                    let uninstaller = dir.join(candidate);
                    if uninstaller.exists() {
                        std::process::Command::new(&uninstaller)
                            .current_dir(dir)
                            .spawn()
                            .map_err(|e| format!("could not launch uninstaller: {e}"))?;
                        return Ok(());
                    }
                }
            }
        }
        Err("No Windows uninstaller found.".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Uninstaller is only supported on Windows builds; drag Resonance.app to Trash on macOS.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_semver_cleanly() {
        assert!(is_newer_version("0.16.0", "0.15.0"));
        assert!(is_newer_version("v1.0.0", "0.99.9"));
        assert!(!is_newer_version("0.15.0", "0.15.0"));
        assert!(!is_newer_version("0.14.9", "0.15.0"));
    }
}
