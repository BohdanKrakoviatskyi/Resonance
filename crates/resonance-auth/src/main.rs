use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use url::Url;
use wry::WebViewBuilder;

const YTMUSIC_HOST: &str = "music.youtube.com";
const YTMUSIC_LIBRARY_URL: &str = "https://music.youtube.com/library";

const SOUNDCLOUD_LOGIN_SCRIPT: &str = r#"(() => {
  if (window !== window.top) return;
  let captured = false;
  const deliver = (clientId, token) => {
    try {
      if (window.ipc && typeof window.ipc.postMessage === 'function') {
        window.ipc.postMessage(JSON.stringify({ clientId, token }));
      }
    } catch (_) {}
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Provider {
    SoundCloud,
    YtMusic,
}

#[derive(Debug)]
enum UserEvent {
    SoundCloudCaptured { client_id: String, token: String },
    PollYtMusic,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScIpcPayload {
    client_id: String,
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScOutputPayload {
    client_id: String,
    token: String,
    datadome: String,
}

pub fn is_music_youtube_url(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some(YTMUSIC_HOST)
}

pub fn is_music_youtube_library_url(url: &Url) -> bool {
    is_music_youtube_url(url) && (url.path() == "/library" || url.path().starts_with("/library/"))
}

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
        Some(path) => {
            request_path == path
                || (request_path.starts_with(path)
                    && request_path.as_bytes().get(path.len()) == Some(&b'/'))
        }
    }
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
    let short = version.split('.').take(2).collect::<Vec<_>>().join(".");
    Some(format!(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{short} Safari/605.1.15"
    ))
}

fn parse_provider_arg(args: &[String]) -> Option<Provider> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Usage: resonance-auth --provider <soundcloud|ytmusic>");
        std::process::exit(0);
    }
    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        if arg == "--provider" {
            return match iter.next().map(String::as_str) {
                Some("soundcloud") => Some(Provider::SoundCloud),
                Some("ytmusic") => Some(Provider::YtMusic),
                _ => None,
            };
        }
    }
    None
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(provider) = parse_provider_arg(&args) else {
        eprintln!("Usage: resonance-auth --provider <soundcloud|ytmusic>");
        std::process::exit(1);
    };

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let (title, w, h, url) = match provider {
        Provider::SoundCloud => ("Sign in to SoundCloud", 1000.0, 760.0, "https://soundcloud.com/signin"),
        Provider::YtMusic => ("Sign in to YouTube Music", 1040.0, 820.0, YTMUSIC_LIBRARY_URL),
    };

    let window = WindowBuilder::new()
        .with_title(title)
        .with_inner_size(LogicalSize::new(w, h))
        .build(&event_loop)
        .expect("create auth window");

    let sc_proxy = proxy.clone();
    let mut builder = WebViewBuilder::new().with_url(url);

    match provider {
        Provider::SoundCloud => {
            builder = builder
                .with_initialization_script(SOUNDCLOUD_LOGIN_SCRIPT)
                .with_ipc_handler(move |req| {
                    if let Ok(payload) = serde_json::from_str::<ScIpcPayload>(req.body())
                        && !payload.client_id.trim().is_empty() && !payload.token.trim().is_empty() {
                            let _ = sc_proxy.send_event(UserEvent::SoundCloudCaptured {
                                client_id: payload.client_id,
                                token: payload.token,
                            });
                        }
                });
        }
        Provider::YtMusic => {
            if let Some(ua) = ytmusic_login_user_agent() {
                builder = builder.with_user_agent(&ua);
            }
            let yt_proxy = proxy.clone();
            std::thread::spawn(move || {
                for _ in 0..800 {
                    std::thread::sleep(Duration::from_millis(750));
                    if yt_proxy.send_event(UserEvent::PollYtMusic).is_err() {
                        break;
                    }
                }
            });
        }
    }

    let webview = builder.build(&window).expect("build auth webview");

    let mut completed = false;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                *control_flow = ControlFlow::ExitWithCode(if completed { 0 } else { 2 });
            }
            Event::UserEvent(UserEvent::SoundCloudCaptured { client_id, token }) => {
                let datadome = webview
                    .cookies()
                    .ok()
                    .and_then(|cookies| {
                        cookies.into_iter().find(|c| {
                            c.name().eq_ignore_ascii_case("datadome")
                                && c.domain().is_some_and(|d| domain_applies_to(d, "soundcloud.com"))
                        })
                    })
                    .map(|c| c.value().to_string())
                    .unwrap_or_default();

                let out = ScOutputPayload {
                    client_id,
                    token,
                    datadome,
                };
                if let Ok(json) = serde_json::to_string(&out) {
                    println!("{json}");
                    completed = true;
                    *control_flow = ControlFlow::ExitWithCode(0);
                }
            }
            Event::UserEvent(UserEvent::PollYtMusic) => {
                if let Ok(raw_url) = webview.url()
                    && let Ok(parsed) = Url::parse(&raw_url) {
                        if is_music_youtube_library_url(&parsed) {
                            if let Ok(cookies) = webview.cookies() {
                                let cookie_header = cookies
                                    .into_iter()
                                    .filter(|c| {
                                        !c.name().is_empty()
                                            && !c.value().is_empty()
                                            && c.domain().is_some_and(|d| domain_applies_to(d, YTMUSIC_HOST))
                                            && path_applies_to(c.path(), "/")
                                    })
                                    .map(|c| format!("{}={}", c.name(), c.value()))
                                    .collect::<Vec<_>>()
                                    .join("; ");
                                if has_secure_papisid(&cookie_header) {
                                    let mut headers = HashMap::new();
                                    headers.insert("Accept", "*/*".to_string());
                                    headers.insert("Content-Type", "application/json".to_string());
                                    headers.insert("X-Goog-AuthUser", "0".to_string());
                                    headers.insert("x-origin", "https://music.youtube.com".to_string());
                                    headers.insert("Cookie", cookie_header);
                                    if let Ok(json) = serde_json::to_string(&headers) {
                                        println!("{json}");
                                        completed = true;
                                        *control_flow = ControlFlow::ExitWithCode(0);
                                    }
                                }
                            }
                        } else if is_music_youtube_url(&parsed) {
                            let _ = webview.load_url(YTMUSIC_LIBRARY_URL);
                        }
                    }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_music_youtube_https_urls() {
        assert!(is_music_youtube_url(&"https://music.youtube.com/library".parse().unwrap()));
        assert!(!is_music_youtube_url(&"http://music.youtube.com/".parse().unwrap()));
        assert!(!is_music_youtube_url(&"https://www.youtube.com/".parse().unwrap()));
        assert!(!is_music_youtube_url(&"https://music.youtube.com.evil.test/".parse().unwrap()));
    }

    #[test]
    fn accepts_only_the_music_youtube_library_page() {
        assert!(is_music_youtube_library_url(&"https://music.youtube.com/library".parse().unwrap()));
        assert!(is_music_youtube_library_url(&"https://music.youtube.com/library/playlists".parse().unwrap()));
        assert!(!is_music_youtube_library_url(&"https://music.youtube.com/".parse().unwrap()));
        assert!(!is_music_youtube_library_url(&"https://music.youtube.com.evil.test/library".parse().unwrap()));
        assert!(!is_music_youtube_library_url(&"http://music.youtube.com/library".parse().unwrap()));
    }

    #[test]
    fn cookie_domain_and_path_checks() {
        assert!(domain_applies_to("youtube.com", "music.youtube.com"));
        assert!(domain_applies_to(".youtube.com", "music.youtube.com"));
        assert!(!domain_applies_to("com", "music.youtube.com"));
        assert!(path_applies_to(Some("/"), "/library"));
        assert!(!path_applies_to(Some("/admin"), "/library"));
    }
}
