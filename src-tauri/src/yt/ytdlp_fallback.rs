use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::Client;
use sha2::{Digest, Sha256};
use tokio::process::Command;

use super::clients::{
    GateTracker, ResolvedYtStream, app_data_root_dir, expire_ttl, extract_query_param_str,
    extract_query_param_u64, registry,
};
use super::identity::read_ytmusic_credentials;
use super::resolver::{is_bot_wall_reason, is_permanent_reason};

const YTDLP_UPDATE_INTERVAL_SECS: u64 = 24 * 60 * 60;
const YTDLP_WARMUP_VIDEO_ID: &str = "jNQXAC9IVRw";
const WEB_EMBEDDED_GATE_TTL: Duration = Duration::from_secs(10 * 60);

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub async fn resolve_via_ytdlp_fallback(
    http: &Client,
    ytdlp_cache_dir: &Path,
    bundle_provision_started: &AtomicBool,
    bin_lock: &tokio::sync::Mutex<bool>,
    gates: &GateTracker,
    video_id: &str,
) -> Result<ResolvedYtStream, String> {
    let (ytdlp_bin, env_path) =
        ensure_ytdlp_environment(http, bundle_provision_started, bin_lock).await?;
    let watch_url = format!("https://www.youtube.com/watch?v={video_id}");
    let cache_dir_str = ytdlp_cache_dir.to_string_lossy().to_string();

    let mut output = None;
    let mut level_label = "Fallback yt-dlp (default)".to_string();
    let skip_web_embedded = gates.is_gated("YTDLP_WEB_EMBEDDED");

    if !skip_web_embedded {
        let out = run_ytdlp_get_url(&ytdlp_bin, &env_path, &cache_dir_str, &watch_url, true, None).await?;
        let stderr = String::from_utf8_lossy(&out.stderr);
        if out.status.success() {
            level_label = "Fallback yt-dlp (web_embedded)".to_string();
            output = Some(out);
        } else if is_permanent_reason(&stderr) {
            output = Some(out);
        } else if is_bot_wall_reason(&stderr) {
            gates.record_player_gate("YTDLP_WEB_EMBEDDED", WEB_EMBEDDED_GATE_TTL);
        }
    }

    let output = match output {
        Some(out) => out,
        None => {
            let cookie = tokio::task::spawn_blocking(|| read_ytmusic_credentials().map(|c| c.cookie))
                .await
                .ok()
                .flatten();
            run_ytdlp_get_url(
                &ytdlp_bin,
                &env_path,
                &cache_dir_str,
                &watch_url,
                false,
                cookie.as_deref(),
            )
            .await?
        }
    };

    if !output.status.success() {
        return Err(format!(
            "yt-dlp failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let direct_url = stdout
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("http://") || l.starts_with("https://"))
        .ok_or_else(|| "yt-dlp returned no URL".to_string())?
        .to_string();

    let mime_param = extract_query_param_str(&direct_url, "mime").unwrap_or_default();
    let itag = extract_query_param_u64(&direct_url, "itag");
    let mime_type = if mime_param.contains("mp4") || matches!(itag, Some(139 | 140)) {
        "audio/mp4".to_string()
    } else {
        "audio/webm".to_string()
    };
    let expire_unix = extract_query_param_u64(&direct_url, "expire");
    let content_length = extract_query_param_u64(&direct_url, "clen");
    let ip_param = extract_query_param_str(&direct_url, "ip");
    let lmt = extract_query_param_u64(&direct_url, "lmt");
    let client_key = extract_query_param_str(&direct_url, "c").unwrap_or_default();
    let user_agent = registry().user_agent_for_url(
        &direct_url,
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );

    Ok(ResolvedYtStream {
        direct_url,
        user_agent,
        extra_headers: HashMap::new(),
        mime_type,
        content_length,
        itag,
        lmt,
        client_key,
        issued_at: Instant::now(),
        expires_at: Instant::now() + expire_ttl(expire_unix),
        expire_unix,
        ip_param,
        level_label,
    })
}

async fn run_ytdlp_get_url(
    ytdlp_bin: &Path,
    env_path: &str,
    cache_dir: &str,
    watch_url: &str,
    web_embedded: bool,
    cookie: Option<&str>,
) -> Result<std::process::Output, String> {
    let mut cmd = Command::new(ytdlp_bin);
    cmd.args(["-g", "-f", "251/140/bestaudio[protocol=https]/bestaudio"]);
    if web_embedded {
        cmd.args(["--extractor-args", "youtube:player_client=web_embedded"]);
    }
    cmd.args(["--cache-dir", cache_dir, "--no-playlist", "--no-warnings"]);
    if let Some(c) = cookie {
        cmd.args(["--add-header", &format!("Cookie:{c}")]);
    }
    cmd.arg(watch_url)
        .env("PATH", env_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    tokio::time::timeout(Duration::from_secs(20), cmd.output())
        .await
        .map_err(|_| "yt-dlp timed out (20s)".to_string())?
        .map_err(|e| format!("Failed to spawn yt-dlp: {e}"))
}

pub async fn ensure_ytdlp_environment(
    http: &Client,
    bundle_provision_started: &AtomicBool,
    bin_lock: &tokio::sync::Mutex<bool>,
) -> Result<(PathBuf, String), String> {
    let app_bin = app_data_root_dir().join("bin");
    let _ = std::fs::create_dir_all(&app_bin);

    #[cfg(target_os = "macos")]
    {
        let bundled = app_bin.join("yt-dlp-macos").join("yt-dlp_macos");
        if bundled.is_file() {
            return Ok((bundled, join_search_path(&collect_tool_directories(&app_bin))));
        }
    }

    let extra_dirs = collect_tool_directories(&app_bin);
    let combined_path = join_search_path(&extra_dirs);
    let ytdlp_name = if cfg!(target_os = "windows") { "yt-dlp.exe" } else { "yt-dlp" };

    if let Some(found) = extra_dirs.iter().map(|d| d.join(ytdlp_name)).find(|p| p.is_file()) {
        #[cfg(target_os = "macos")]
        if !bundle_provision_started.swap(true, Ordering::SeqCst) {
            let h = http.clone();
            tokio::spawn(async move {
                let _ = download_and_verify_ytdlp(&h).await;
            });
        }
        return Ok((found, combined_path));
    }

    let mut lock = bin_lock.lock().await;
    if let Some(found) = extra_dirs.iter().map(|d| d.join(ytdlp_name)).find(|p| p.is_file()) {
        return Ok((found, combined_path));
    }
    let path = download_and_verify_ytdlp(http).await?;
    *lock = true;
    Ok((path, combined_path))
}

pub async fn check_daily_ytdlp_update(
    http: &Client,
    bundle_provision_started: &AtomicBool,
    bin_lock: &tokio::sync::Mutex<bool>,
) {
    let app_bin = app_data_root_dir().join("bin");
    let _ = std::fs::create_dir_all(&app_bin);
    let stamp = app_bin.join("ytdlp_last_update.txt");
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    if let Ok(raw) = std::fs::read_to_string(&stamp) {
        if raw.trim().parse::<u64>().is_ok_and(|last| now.saturating_sub(last) < YTDLP_UPDATE_INTERVAL_SECS) {
            return;
        }
    }
    let _ = std::fs::write(&stamp, now.to_string());
    if let Ok((bin, env_path)) = ensure_ytdlp_environment(http, bundle_provision_started, bin_lock).await {
        let mut cmd = Command::new(bin);
        cmd.arg("-U")
            .env("PATH", env_path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.status().await;
    }
}

pub fn warmup_cache_needed(ytdlp_cache_dir: &Path) -> Option<&'static str> {
    let dir = ytdlp_cache_dir.join("youtube-sigfuncs");
    let has = std::fs::read_dir(dir).ok().and_then(|mut it| it.next()).is_some();
    if has { None } else { Some(YTDLP_WARMUP_VIDEO_ID) }
}

fn collect_tool_directories(app_bin: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let sep = if cfg!(target_os = "windows") { ';' } else { ':' };
    if cfg!(target_os = "macos") {
        if let Ok(p) = std::env::var("PATH") {
            dirs.extend(p.split(sep).filter(|s| !s.trim().is_empty()).map(PathBuf::from));
        }
    }
    dirs.push(app_bin.to_path_buf());
    if !cfg!(target_os = "macos") {
        if let Ok(p) = std::env::var("PATH") {
            dirs.extend(p.split(sep).filter(|s| !s.trim().is_empty()).map(PathBuf::from));
        }
    }
    dirs
}

fn join_search_path(dirs: &[PathBuf]) -> String {
    let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
    let mut parts: Vec<String> = dirs.iter().map(|p| p.to_string_lossy().to_string()).collect();
    if let Ok(cur) = std::env::var("PATH") {
        if !cur.is_empty() {
            parts.push(cur);
        }
    }
    parts.join(sep)
}

async fn download_and_verify_ytdlp(http: &Client) -> Result<PathBuf, String> {
    let app_bin = app_data_root_dir().join("bin");
    let _ = std::fs::create_dir_all(&app_bin);
    #[cfg(target_os = "macos")]
    let asset_name = "yt-dlp_macos.zip";
    #[cfg(target_os = "windows")]
    let asset_name = "yt-dlp.exe";
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let asset_name = "yt-dlp_linux";

    let sums = http
        .get("https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Failed to fetch yt-dlp checksums: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Failed to read yt-dlp checksums: {e}"))?;

    let expected = sums
        .lines()
        .find_map(|line| {
            let mut p = line.split_whitespace();
            let h = p.next()?;
            let f = p.next()?;
            (f.trim_start_matches('*') == asset_name).then(|| h.to_lowercase())
        })
        .ok_or_else(|| format!("SHA-256 not found for {asset_name}"))?;

    let bytes = http
        .get(format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{asset_name}"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Failed to download {asset_name}: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("Failed to read {asset_name}: {e}"))?;

    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != expected {
        return Err(format!("SHA-256 mismatch for {asset_name}"));
    }

    #[cfg(target_os = "macos")]
    {
        let zip_path = app_bin.join(asset_name);
        tokio::fs::write(&zip_path, &bytes).await.map_err(|e| e.to_string())?;
        let extract_dir = app_bin.join("yt-dlp-macos");
        let _ = std::fs::remove_dir_all(&extract_dir);
        std::fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;
        let out = Command::new("/usr/bin/unzip")
            .args(["-o", "-q"])
            .arg(&zip_path)
            .arg("-d")
            .arg(&extract_dir)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        let _ = tokio::fs::remove_file(&zip_path).await;
        if !out.status.success() {
            return Err("Failed to unzip yt-dlp_macos.zip".to_string());
        }
        let bin = extract_dir.join("yt-dlp_macos");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&bin) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = std::fs::set_permissions(&bin, perms);
            }
        }
        return Ok(bin);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let target = app_bin.join(asset_name);
        tokio::fs::write(&target, &bytes).await.map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&target) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = std::fs::set_permissions(&target, perms);
            }
        }
        Ok(target)
    }
}
