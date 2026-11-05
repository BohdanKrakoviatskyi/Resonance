use std::sync::Mutex;
use std::time::Duration;

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
    WebviewWindowBuilder::new(&app, "ytmusic-login", WebviewUrl::External(library_url()?))
        .title("Sign in to YouTube Music")
        .inner_size(1040.0, 820.0)
        .center()
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

fn session_cookie_url() -> Result<Url, String> {
    Url::parse("https://music.youtube.com/")
        .map_err(|error| format!("invalid YouTube Music URL: {error}"))
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
    let Ok(cookie_url) = session_cookie_url() else {
        return false;
    };
    // This runs on a blocking worker; cookie reads must stay off the UI thread.
    let Ok(cookies) = window.cookies_for_url(cookie_url) else {
        return false;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(YtMusicLoginState::default())
        .on_window_event(|window, event| {
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
            start_ytmusic_login
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
}
