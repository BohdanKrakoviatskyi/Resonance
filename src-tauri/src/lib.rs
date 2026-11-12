pub mod yt_proxy;

use std::sync::Mutex;
use std::time::Duration;

use yt_proxy::{
    YtStreamProxy, fetch_yt_playlist_tracks, resolve_yt_stream_url, search_yt_tracks,
};
use tauri::webview::Cookie;
use tauri::{
    AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const SOUNDCLOUD_LOGIN_SCRIPT: &str = r#"(() => {
  let captured = false;
  let capturedClientId = '';
  let capturedToken = '';
  const inspect = (rawUrl, headers) => {
    if (captured) return;
    try {
      const url = new URL(rawUrl, location.href);
      if (url.hostname !== 'api-v2.soundcloud.com') return;
      capturedClientId ||= url.searchParams.get('client_id') || '';
      const auth = new Headers(headers).get('Authorization') || '';
      const match = auth.match(/^(?:OAuth|Bearer)\s+(.+)$/i);
      if (match) capturedToken ||= match[1];
      if (!capturedClientId || !capturedToken) return;
      captured = true;
      const callback = new URL('resonance://soundcloud-login');
      callback.searchParams.set('state', '__LOGIN_STATE__');
      callback.searchParams.set('client_id', capturedClientId);
      callback.searchParams.set('token', capturedToken);
      location.href = callback.toString();
    } catch (_) {}
  };
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    const rawUrl = input instanceof Request ? input.url : input;
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init && init.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    inspect(rawUrl, headers);
    return originalFetch.apply(this, arguments);
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__soundcloudLoginUrl = url;
    this.__soundcloudLoginHeaders = new Headers();
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    try { this.__soundcloudLoginHeaders.set(name, value); } catch (_) {}
    inspect(this.__soundcloudLoginUrl, this.__soundcloudLoginHeaders);
    return originalSetHeader.apply(this, arguments);
  };
})();"#;

#[derive(Default)]
struct YtMusicLoginState {
    nonce: Mutex<Option<String>>,
}

fn is_music_youtube_url(url: &tauri::Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("music.youtube.com")
}

fn is_music_youtube_library_url(url: &tauri::Url) -> bool {
    is_music_youtube_url(url) && (url.path() == "/library" || url.path().starts_with("/library/"))
}

fn build_cookie_header(cookies: &[Cookie<'static>]) -> String {
    cookies
        .iter()
        .filter(|cookie| !cookie.name().is_empty() && !cookie.value().is_empty())
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; ")
}

fn has_secure_papisid(cookie_header: &str) -> bool {
    cookie_header.split(';').any(|part| {
        part.trim()
            .split_once('=')
            .map(|(name, value)| {
                name.trim().eq_ignore_ascii_case("__Secure-3PAPISID") && !value.trim().is_empty()
            })
            .unwrap_or(false)
    })
}

#[tauri::command]
async fn start_soundcloud_login(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("soundcloud-login") {
        let _ = existing.close();
    }
    let state = uuid::Uuid::new_v4().to_string();
    let login_script = SOUNDCLOUD_LOGIN_SCRIPT.replace("__LOGIN_STATE__", &state);
    let callback_app = app.clone();
    let callback_state = state.clone();
    WebviewWindowBuilder::new(
        &app,
        "soundcloud-login",
        WebviewUrl::External(
            "https://soundcloud.com/signin"
                .parse()
                .map_err(|error| format!("invalid SoundCloud URL: {error}"))?,
        ),
    )
    .title("Sign in to SoundCloud")
    .inner_size(1000.0, 760.0)
    .center()
    .initialization_script(&login_script)
    .on_navigation(move |url| {
        if url.scheme() != "resonance" || url.host_str() != Some("soundcloud-login") {
            return true;
        }
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        if query.get("state") != Some(&callback_state) {
            return false;
        }
        let client_id = query.get("client_id").cloned().unwrap_or_default();
        let token = query.get("token").cloned().unwrap_or_default();
        if !client_id.is_empty() && !token.is_empty() {
            let _ = callback_app.emit(
                "soundcloud-auth-captured",
                serde_json::json!({ "clientId": client_id, "token": token }),
            );
        }
        if let Some(window) = callback_app.get_webview_window("soundcloud-login") {
            let _ = window.close();
        }
        false
    })
    .build()
    .map(|_| ())
    .map_err(|error| format!("could not open SoundCloud login: {error}"))
}

#[tauri::command]
async fn start_ytmusic_login(app: AppHandle, state: State<'_, YtMusicLoginState>) -> Result<(), String> {
    // Closing a previous attempt must not look like the user cancelled the new one.
    if let Ok(mut nonce) = state.nonce.lock() {
        *nonce = None;
    }
    if let Some(existing) = app.get_webview_window("ytmusic-login") {
        let _ = existing.close();
    }

    let nonce = uuid::Uuid::new_v4().to_string();
    state
        .nonce
        .lock()
        .map_err(|_| "could not start YouTube Music login".to_string())?
        .replace(nonce.clone());

    // Open the library page directly: it is the page we need for capture, and
    // signed-out visitors get a clear sign-in prompt there.
    let mut login_window = WebviewWindowBuilder::new(
        &app,
        "ytmusic-login",
        WebviewUrl::External(library_url()?),
    )
    .title("Sign in to YouTube Music")
    .inner_size(1040.0, 820.0)
    .center();

    // WebKit's macOS user agent makes YouTube Music serve its unsupported
    // browser page, which cannot be signed into.
    if let Some(user_agent) = ytmusic_login_user_agent() {
        login_window = login_window.user_agent(&user_agent);
    }

    login_window
        .build()
        .map_err(|error| format!("could not open YouTube Music login: {error}"))?;

    let watcher_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || watch_ytmusic_login(watcher_app, nonce));

    Ok(())
}

fn library_url() -> Result<Url, String> {
    Url::parse("https://music.youtube.com/library")
        .map_err(|error| format!("invalid YouTube Music URL: {error}"))
}

/// WebKit on macOS reports a user agent without the `Version/… Safari/…`
/// suffix every other engine includes, so YouTube Music cannot classify the
/// login webview and answers with its "browser not optimised" page instead of
/// the sign-in screen. The engine really is WebKit, so report it as Safari.
fn ytmusic_login_user_agent() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let version = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|version| version.trim().to_string())
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| "17.0".to_string());
    // Safari reports major.minor only, e.g. "17.4" for macOS 14.5.
    let version = version
        .split('.')
        .take(2)
        .collect::<Vec<_>>()
        .join(".");
    Some(format!(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{version} Safari/605.1.15"
    ))
}

const YTMUSIC_HOST: &str = "music.youtube.com";

/// Whether a cookie domain applies to `host`.
///
/// WebKit reports the domain of a `Domain=youtube.com` cookie as
/// `youtube.com`, without a leading dot, so the dot is not a reliable marker
/// for "domain cookie". A cookie therefore covers `host` when the domains
/// match or when `host` is a subdomain of the cookie's domain.
fn domain_applies_to(cookie_domain: &str, host: &str) -> bool {
    let domain = cookie_domain.trim_start_matches('.').to_ascii_lowercase();
    let host = host.to_ascii_lowercase();
    if domain.is_empty() {
        return false;
    }
    if host == domain {
        return true;
    }
    // A bare label such as "com" is a public suffix and must not match every
    // host below it.
    if !domain.contains('.') {
        return false;
    }
    host.ends_with(&format!(".{domain}"))
}

/// Whether a cookie path applies to `request_path`.
fn path_applies_to(cookie_path: Option<&str>, request_path: &str) -> bool {
    match cookie_path {
        None => true,
        Some(path) if path.is_empty() || path == "/" => true,
        Some(path) => {
            request_path == path
                || (request_path.starts_with(path)
                    && request_path.as_bytes().get(path.len()) == Some(&b'/'))
        }
    }
}

/// Collects the cookies that apply to YouTube Music.
///
/// `cookies_for_url` cannot be used here: wry filters by exact domain
/// equality, so the `youtube.com` domain cookies Google issues
/// (`__Secure-3PAPISID` and friends) never match `music.youtube.com`.
fn music_youtube_cookies(window: &WebviewWindow) -> Result<Vec<Cookie<'static>>, String> {
    let all = window.cookies().map_err(|error| error.to_string())?;
    Ok(all
        .into_iter()
        .filter(|cookie| {
            let domain_matches = cookie
                .domain()
                .map(|domain| domain_applies_to(domain, YTMUSIC_HOST))
                .unwrap_or(false);
            domain_matches && path_applies_to(cookie.path(), "/")
        })
        .collect())
}

/// Polls the login window instead of relying on an in-page script, so capture
/// also works when the session already exists and no navigation happens.
fn watch_ytmusic_login(app: AppHandle, nonce: String) {
    // Roughly ten minutes of sign-in attempts.
    for _ in 0..800 {
        std::thread::sleep(Duration::from_millis(750));

        if !nonce_is_active(&app, &nonce) {
            return;
        }
        let Some(window) = app.get_webview_window("ytmusic-login") else {
            return;
        };
        let Ok(url) = window.url() else {
            continue;
        };

        if is_music_youtube_library_url(&url) {
            if capture_ytmusic_session(&app, &window, &nonce) {
                return;
            }
        } else if is_music_youtube_url(&url) {
            // Sign-in can land on the home page; return to the library so the
            // session is captured on a page that requires it.
            if let Ok(target) = library_url() {
                let _ = window.navigate(target);
            }
        }
    }
}

fn nonce_is_active(app: &AppHandle, nonce: &str) -> bool {
    app.state::<YtMusicLoginState>()
        .nonce
        .lock()
        .map(|current| current.as_deref() == Some(nonce))
        .unwrap_or(false)
}

/// Reads the session from the native cookie store and hands it to the app.
/// Returns true when the attempt is finished (captured or already handled).
fn capture_ytmusic_session(app: &AppHandle, window: &WebviewWindow, nonce: &str) -> bool {
    // This runs on a blocking worker; cookie reads must stay off the UI thread.
    let cookies = match music_youtube_cookies(window) {
        Ok(cookies) => cookies,
        Err(error) => {
            eprintln!("could not read the YouTube Music cookie store: {error}");
            return false;
        }
    };
    let cookie_header = build_cookie_header(&cookies);
    if !has_secure_papisid(&cookie_header) {
        // Not signed in yet. Keep watching; the user can still sign in.
        return false;
    }
    if !nonce_is_active(app, nonce) {
        return true;
    }

    // Only the local app window needs the session; never surface credentials
    // inside the remote login page.
    let emitted = app.emit_to(
        "main",
        "ytmusic-auth-captured",
        serde_json::json!({
            "headers": {
                "Accept": "*/*",
                "Content-Type": "application/json",
                "X-Goog-AuthUser": "0",
                "x-origin": "https://music.youtube.com",
                "Cookie": cookie_header,
            }
        }),
    );
    if emitted.is_err() {
        return false;
    }

    let state = app.state::<YtMusicLoginState>();
    let mut current = state
        .nonce
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if current.as_deref() == Some(nonce) {
        *current = None;
    }
    if let Some(window) = app.get_webview_window("ytmusic-login") {
        let _ = window.close();
    }
    true
}

#[tauri::command]
async fn uninstall_app(app: AppHandle) -> Result<(), String> {
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
                            .map_err(|error| format!("could not launch uninstaller: {error}"))?;
                        app.exit(0);
                        return Ok(());
                    }
                }
            }
        }
        let ps_script = r#"
$paths = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$item = Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Resonance*' -and $_.UninstallString } | Select-Object -First 1
if ($item) {
  Start-Process cmd.exe -ArgumentList '/c', $item.UninstallString
} else {
  Start-Process 'ms-settings:appsfeatures'
}
"#;
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps_script])
            .spawn();
        app.exit(0);
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("Uninstaller is only supported on desktop builds.".to_string())
    }
}

/// Одноразовая зачистка устаревших токенов, куки и кэшей удалённой интеграции
fn purge_retired_spotify_storage(app: &AppHandle) {
    for account in ["oauth_tokens", "oauth_tokens_v1"] {
        if let Ok(entry) = keyring::Entry::new("com.resonance.spotify", account) {
            let _ = entry.delete_credential();
        }
    }
    if let Ok(config_dir) = app.path().app_config_dir() {
        for file_name in [
            "spotify_config.json",
            "spotify_imports.json",
            "spotify_profile_cache.json",
            "spotify.json",
        ] {
            let _ = std::fs::remove_file(config_dir.join(file_name));
        }
        let _ = std::fs::remove_dir_all(config_dir.join("spotify-webview"));
    }
    if let Ok(data_dir) = app.path().app_data_dir() {
        for file_name in [
            "spotify_config.json",
            "spotify_imports.json",
            "spotify_profile_cache.json",
            "spotify.json",
        ] {
            let _ = std::fs::remove_file(data_dir.join(file_name));
        }
        let _ = std::fs::remove_dir_all(data_dir.join("spotify-webview"));
    }
}

#[tauri::command]
pub async fn finish_splash(app: AppHandle) -> Result<(), String> {
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.show();
        let _ = main_window.set_focus();
    }
    if let Some(splash_window) = app.get_webview_window("splash") {
        let _ = splash_window.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn restart_app(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(exe) = std::env::current_exe() {
            let app_bundle = exe
                .ancestors()
                .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
                .map(|p| p.to_path_buf());

            if let Some(bundle_path) = app_bundle {
                let _ = std::process::Command::new("/bin/sh")
                    .arg("-c")
                    .arg("sleep 0.7 && open -a \"$1\"")
                    .arg("sh")
                    .arg(&bundle_path)
                    .spawn();
                app.exit(0);
                return Ok(());
            }
        }
    }

    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(YtMusicLoginState::default())
        .manage(YtStreamProxy::default())
        .setup(|app| {
            purge_retired_spotify_storage(app.handle());
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let proxy = app_handle.state::<YtStreamProxy>();
                let _ = proxy.ensure_server_port().await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "splash"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                if let Some(main_window) = window.app_handle().get_webview_window("main") {
                    let _ = main_window.show();
                    let _ = main_window.set_focus();
                }
            }
            if window.label() == "soundcloud-login"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                let _ = window.emit("soundcloud-login-cancelled", ());
            }
            if window.label() == "ytmusic-login"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                let state = window.state::<YtMusicLoginState>();
                let pending = state
                    .nonce
                    .lock()
                    .map(|mut nonce| nonce.take().is_some())
                    .unwrap_or(false);
                if pending {
                    let _ = window.emit("ytmusic-login-cancelled", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_soundcloud_login,
            start_ytmusic_login,
            uninstall_app,
            finish_splash,
            restart_app,
            resolve_yt_stream_url,
            search_yt_tracks,
            fetch_yt_playlist_tracks
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_music_youtube_https_urls() {
        assert!(is_music_youtube_url(
            &"https://music.youtube.com/library".parse().unwrap()
        ));
        assert!(!is_music_youtube_url(
            &"http://music.youtube.com/".parse().unwrap()
        ));
        assert!(!is_music_youtube_url(
            &"https://www.youtube.com/".parse().unwrap()
        ));
        assert!(!is_music_youtube_url(
            &"https://music.youtube.com.evil.test/".parse().unwrap()
        ));
    }

    #[test]
    fn accepts_only_the_music_youtube_library_page() {
        assert!(is_music_youtube_library_url(
            &"https://music.youtube.com/library".parse().unwrap()
        ));
        assert!(is_music_youtube_library_url(
            &"https://music.youtube.com/library/playlists"
                .parse()
                .unwrap()
        ));
        assert!(!is_music_youtube_library_url(
            &"https://music.youtube.com/".parse().unwrap()
        ));
        assert!(!is_music_youtube_library_url(
            &"https://music.youtube.com.evil.test/library"
                .parse()
                .unwrap()
        ));
        assert!(!is_music_youtube_library_url(
            &"http://music.youtube.com/library".parse().unwrap()
        ));
    }

    #[test]
    fn builds_a_cookie_header_and_requires_secure_papisid() {
        let cookies = vec![
            Cookie::new("SID", "session"),
            Cookie::new("__Secure-3PAPISID", "value"),
            Cookie::new("empty", ""),
        ];
        let header = build_cookie_header(&cookies);
        assert_eq!(header, "SID=session; __Secure-3PAPISID=value");
        assert!(has_secure_papisid(&header));
        assert!(has_secure_papisid(
            "SID=session; __Secure-3PAPISID=value; OTHER=1"
        ));
        assert!(!has_secure_papisid("SID=session"));
        assert!(!has_secure_papisid("__Secure-3PAPISID="));
    }

    #[test]
    fn matches_domain_cookies_against_the_youtube_music_host() {
        // WebKit reports the domain of a `Domain=youtube.com` cookie as
        // "youtube.com", without a leading dot.
        assert!(domain_applies_to("youtube.com", YTMUSIC_HOST));
        assert!(domain_applies_to(".youtube.com", YTMUSIC_HOST));
        assert!(domain_applies_to("music.youtube.com", YTMUSIC_HOST));
        assert!(domain_applies_to(".MUSIC.YouTube.com", YTMUSIC_HOST));

        // Cookies of other hosts must not leak into the header.
        assert!(!domain_applies_to("google.com", YTMUSIC_HOST));
        assert!(!domain_applies_to("accounts.google.com", YTMUSIC_HOST));
        assert!(!domain_applies_to("google.com.ua", YTMUSIC_HOST));
        assert!(!domain_applies_to("", YTMUSIC_HOST));

        // A public suffix must not match every host below it.
        assert!(!domain_applies_to("com", YTMUSIC_HOST));
    }

    #[test]
    fn matches_cookie_paths_against_the_request_path() {
        assert!(path_applies_to(None, "/"));
        assert!(path_applies_to(Some("/"), "/"));
        assert!(!path_applies_to(Some("/library"), "/"));
        assert!(path_applies_to(Some("/youtubei"), "/youtubei/v1/browse"));
        assert!(!path_applies_to(Some("/youtubei"), "/youtubeix/v1"));
    }
}
