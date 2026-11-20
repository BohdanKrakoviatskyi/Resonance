use tauri::webview::Cookie;
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window};
use std::sync::Mutex;
use std::time::Duration;

const SOUNDCLOUD_LOGIN_SCRIPT: &str = r#"(() => {
  if (window !== window.top) return; // api-v2 calls are captured in the top frame only
  let captured = false;
  const state = '__LOGIN_STATE__';
  const deliver = (clientId, token) => {
    const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    // Close-signal navigation; must happen only AFTER the IPC call finished,
    // otherwise navigating away can destroy the webview mid-call and the
    // token is lost (the window then closes as 'cancelled').
    const navigate = () => { location.href = 'resonance://soundcloud-login?state=' + state; };
    if (typeof invoke === 'function') {
      Promise.resolve()
        .then(() => invoke('soundcloud_auth_capture', { clientId, token }))
        .then(navigate, navigate);
    } else {
      navigate();
    }
  };
  const inspect = (rawUrl, headers) => {
    if (captured) return;
    try {
      const url = new URL(rawUrl, location.href);
      if (url.hostname !== 'api-v2.soundcloud.com') return;
      const clientId = url.searchParams.get('client_id') || '';
      const auth = new Headers(headers).get('Authorization') || '';
      const match = auth.match(/^(?:OAuth|Bearer)\s+(.+)$/i);
      const token = match ? match[1] : '';
      if (!clientId || !token) return;
      captured = true;
      deliver(clientId, token);
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

/// A SoundCloud session captured from a webview window.
#[derive(Debug, Clone)]
pub struct CapturedSession {
    pub client_id: String,
    pub token: String,
}

#[derive(Default)]
pub struct SoundCloudLoginState {
    pub pending: Mutex<bool>,
    /// A silent re-pull started by the backend; the hidden window hands its session back here.
    pub silent: Mutex<Option<tokio::sync::oneshot::Sender<CapturedSession>>>,
}

/// Label of the hidden window used to re-pull the web session without the user's involvement.
const SILENT_SESSION_WINDOW: &str = "soundcloud-silent";
/// The same window the manual sign-in flow uses, so the injected capture script is identical.
const LOGIN_WINDOW: &str = "soundcloud-login";
/// How long a silent window may take to make one API call with the user's cookies.
const SILENT_SESSION_TIMEOUT: Duration = Duration::from_secs(12);
/// A catalogue page: it fires api-v2 requests on load, and sending a signed-out visitor to the
/// sign-in page is exactly the answer we want from it (no token, so the attempt fails cleanly).
const SOUNDCLOUD_SILENT_URL: &str = "https://soundcloud.com/discover";

/// Set once in `run()`: the backend reaches the webview from a plain async task, not a command.
static APP_HANDLE: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

pub fn remember_app(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
}

/// Re-pulls the SoundCloud web session: a hidden window loads soundcloud.com, the very same
/// capture script reads the token from the page's own API calls, and the window closes itself.
/// Works without any interaction while the user's soundcloud.com cookies are still valid, which
/// is how the session was first obtained.
pub async fn pull_soundcloud_session() -> Result<CapturedSession, String> {
    let app = APP_HANDLE
        .get()
        .cloned()
        .ok_or_else(|| "SoundCloud session capture is not available yet".to_string())?;
    if let Some(existing) = app.get_webview_window(SILENT_SESSION_WINDOW) {
        let _ = existing.close();
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    {
        let state = app.state::<SoundCloudLoginState>();
        let mut slot = state.silent.lock().map_err(|_| "SoundCloud login state unavailable".to_string())?;
        *slot = Some(sender);
    }
    let url = Url::parse(SOUNDCLOUD_SILENT_URL).map_err(|e| format!("invalid SoundCloud URL: {e}"))?;
    let script = SOUNDCLOUD_LOGIN_SCRIPT.replace("__LOGIN_STATE__", &uuid::Uuid::new_v4().to_string());
    let navigation_app = app.clone();
    let built = WebviewWindowBuilder::new(&app, SILENT_SESSION_WINDOW, WebviewUrl::External(url))
        .title("SoundCloud")
        .inner_size(1000.0, 760.0)
        .visible(false)
        .skip_taskbar(true)
        .initialization_script(&script)
        .on_navigation(move |url| {
            // The capture script closes the window by navigating to its own scheme, which the
            // hidden window must never actually load.
            if url.scheme() == "resonance" {
                if let Some(window) = navigation_app.get_webview_window(SILENT_SESSION_WINDOW) {
                    let _ = window.close();
                }
                return false;
            }
            true
        })
        .build();
    let captured = match built {
        Ok(_) => match tokio::time::timeout(SILENT_SESSION_TIMEOUT, receiver).await {
            Ok(Ok(session)) => Ok(session),
            Ok(Err(_)) => Err("SoundCloud session window closed without a session".to_string()),
            Err(_) => Err("SoundCloud did not expose a session in time".to_string()),
        },
        Err(e) => Err(format!("could not open the SoundCloud session window: {e}")),
    };
    // Dropping the slot is what tells a late capture (if any) that nobody waits for it anymore.
    if let Ok(mut slot) = app.state::<SoundCloudLoginState>().silent.lock() {
        slot.take();
    }
    if let Some(window) = app.get_webview_window(SILENT_SESSION_WINDOW) {
        let _ = window.close();
    }
    captured
}

/// Receives the SoundCloud token captured by the login window's init script
/// over the IPC bridge. Only the login window (or its hidden sibling used for a
/// silent re-pull) may call this, and only while a sign-in or re-pull is pending;
/// the token never travels in a URL.
#[tauri::command]
pub async fn soundcloud_auth_capture(
    app: AppHandle,
    window: Window,
    state: State<'_, SoundCloudLoginState>,
    client_id: String,
    token: String,
) -> Result<(), String> {
    let label = window.label();
    if label != LOGIN_WINDOW && label != SILENT_SESSION_WINDOW {
        return Err("SoundCloud auth capture is only available from the sign-in window".to_string());
    }
    if client_id.trim().is_empty() || token.trim().is_empty() {
        return Err("SoundCloud sign-in did not return a complete session".to_string());
    }
    if label == SILENT_SESSION_WINDOW {
        let waiting = state
            .silent
            .lock()
            .map_err(|_| "SoundCloud login state unavailable".to_string())?
            .take();
        let Some(sender) = waiting else {
            return Err("No SoundCloud session re-pull is in progress".to_string());
        };
        let _ = sender.send(CapturedSession { client_id, token });
        if let Some(hidden) = app.get_webview_window(SILENT_SESSION_WINDOW) {
            let _ = hidden.close();
        }
        return Ok(());
    }
    {
        let pending = state.pending.lock().map_err(|_| "SoundCloud login state unavailable".to_string())?;
        if !*pending {
            return Err("No SoundCloud sign-in is in progress".to_string());
        }
    }
    if let Ok(mut pending) = state.pending.lock() {
        *pending = false;
    }
    app.emit(
        "soundcloud-auth-captured",
        serde_json::json!({ "clientId": client_id, "token": token }),
    )
    .map_err(|e| format!("Could not deliver SoundCloud session: {e}"))?;
    if let Some(login_window) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = login_window.close();
    }
    Ok(())
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
pub async fn start_soundcloud_login(app: AppHandle, login_state: State<'_, SoundCloudLoginState>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("soundcloud-login") {
        let _ = existing.close();
    }
    let mut pending = login_state
        .pending
        .lock()
        .map_err(|_| "SoundCloud login state unavailable".to_string())?;
    *pending = true;
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
        // The token arrives via the soundcloud_auth_capture command, not
        // the URL. This navigation is only a close signal.
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
        } else if is_music_youtube_url(&url)
            && let Ok(target) = library_url() {
                let _ = window.navigate(target);
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
