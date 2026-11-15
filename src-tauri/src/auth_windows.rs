use tauri::webview::Cookie;
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use std::sync::Mutex;
use std::time::Duration;

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
pub struct YtMusicLoginState {
    pub nonce: Mutex<Option<String>>,
}

pub fn is_music_youtube_url(url: &tauri::Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("music.youtube.com")
}

pub fn is_music_youtube_library_url(url: &tauri::Url) -> bool {
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
            .map(|(name, value)| name.trim().eq_ignore_ascii_case("__Secure-3PAPISID") && !value.trim().is_empty())
            .unwrap_or(false)
    })
}

#[tauri::command]
pub async fn start_soundcloud_login(app: AppHandle) -> Result<(), String> {
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
        WebviewUrl::External("https://soundcloud.com/signin".parse().map_err(|e| format!("invalid SoundCloud URL: {e}"))?),
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
            let _ = callback_app.emit("soundcloud-auth-captured", serde_json::json!({ "clientId": client_id, "token": token }));
        }
        if let Some(window) = callback_app.get_webview_window("soundcloud-login") {
            let _ = window.close();
        }
        false
    })
    .build()
    .map(|_| ())
    .map_err(|e| format!("could not open SoundCloud login: {e}"))
}

#[tauri::command]
pub async fn start_ytmusic_login(app: AppHandle, state: State<'_, YtMusicLoginState>) -> Result<(), String> {
    if let Ok(mut nonce) = state.nonce.lock() {
        *nonce = None;
    }
    if let Some(existing) = app.get_webview_window("ytmusic-login") {
        let _ = existing.close();
    }
    let nonce = uuid::Uuid::new_v4().to_string();
    state.nonce.lock().map_err(|_| "could not start YouTube Music login".to_string())?.replace(nonce.clone());
    let mut login_window = WebviewWindowBuilder::new(
        &app,
        "ytmusic-login",
        WebviewUrl::External(library_url()?),
    )
    .title("Sign in to YouTube Music")
    .inner_size(1040.0, 820.0)
    .center();
    if let Some(user_agent) = ytmusic_login_user_agent() {
        login_window = login_window.user_agent(&user_agent);
    }
    login_window.build().map_err(|e| format!("could not open YouTube Music login: {e}"))?;
    let watcher_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || watch_ytmusic_login(watcher_app, nonce));
    Ok(())
}

fn library_url() -> Result<Url, String> {
    Url::parse("https://music.youtube.com/library").map_err(|e| format!("invalid YouTube Music URL: {e}"))
}

fn ytmusic_login_user_agent() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let version = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "17.0".to_string());
    let version = version.split('.').take(2).collect::<Vec<_>>().join(".");
    Some(format!(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{version} Safari/605.1.15"
    ))
}

const YTMUSIC_HOST: &str = "music.youtube.com";

pub fn domain_applies_to(cookie_domain: &str, host: &str) -> bool {
    let domain = cookie_domain.trim_start_matches('.').to_ascii_lowercase();
    let host = host.to_ascii_lowercase();
    if domain.is_empty() {
        return false;
    }
    if host == domain {
        return true;
    }
    if !domain.contains('.') {
        return false;
    }
    host.ends_with(&format!(".{domain}"))
}

pub fn path_applies_to(cookie_path: Option<&str>, request_path: &str) -> bool {
    match cookie_path {
        None => true,
        Some(path) if path.is_empty() || path == "/" => true,
        Some(path) => request_path == path || (request_path.starts_with(path) && request_path.as_bytes().get(path.len()) == Some(&b'/')),
    }
}

fn music_youtube_cookies(window: &WebviewWindow) -> Result<Vec<Cookie<'static>>, String> {
    let all = window.cookies().map_err(|e| e.to_string())?;
    Ok(all
        .into_iter()
        .filter(|cookie| cookie.domain().is_some_and(|d| domain_applies_to(d, YTMUSIC_HOST)) && path_applies_to(cookie.path(), "/"))
        .collect())
}

fn watch_ytmusic_login(app: AppHandle, nonce: String) {
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

fn capture_ytmusic_session(app: &AppHandle, window: &WebviewWindow, nonce: &str) -> bool {
    let cookies = match music_youtube_cookies(window) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let cookie_header = build_cookie_header(&cookies);
    if !has_secure_papisid(&cookie_header) {
        return false;
    }
    if !nonce_is_active(app, nonce) {
        return true;
    }
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
    let mut current = state.nonce.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if current.as_deref() == Some(nonce) {
        *current = None;
    }
    if let Some(window) = app.get_webview_window("ytmusic-login") {
        let _ = window.close();
    }
    true
}
