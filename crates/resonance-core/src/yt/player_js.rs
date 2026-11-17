use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use reqwest::Client;
use rquickjs::{Context as QjsContext, Runtime as QjsRuntime};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::{Mutex as AsyncMutex, oneshot};

use super::clients::app_data_root_dir;

const LIB_MIN_JS: &str = include_str!("ejs/lib.min.js");
const CORE_MIN_JS: &str = include_str!("ejs/core.min.js");
const IFRAME_API_URL: &str = "https://www.youtube.com/iframe_api";
const PLAYER_CACHE_TTL: Duration = Duration::from_secs(6 * 3600);

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone, Debug)]
struct CachedPlayerBundle {
    player_id: String,
    sts: u64,
    preprocessed_js: String,
    fetched_at: Instant,
}

enum WorkerMsg {
    Warmup {
        player_id: String,
        preprocessed_js: String,
    },
    Solve {
        player_id: String,
        preprocessed_js: String,
        sig: Option<String>,
        n: Option<String>,
        reply: oneshot::Sender<SolveResult>,
    },
    Invalidate,
}

type SolveResult = Result<(Option<String>, Option<String>), String>;

struct LoadedQjsSolver {
    player_id: String,
    _rt: QjsRuntime,
    ctx: QjsContext,
}

pub struct PlayerJsSolver {
    cache_dir: PathBuf,
    bundle: Mutex<Option<CachedPlayerBundle>>,
    init_lock: AsyncMutex<()>,
    worker_tx: Mutex<Option<mpsc::Sender<WorkerMsg>>>,
}

impl Default for PlayerJsSolver {
    fn default() -> Self {
        Self::new()
    }
}

impl PlayerJsSolver {
    pub fn new() -> Self {
        let cache_dir = app_data_root_dir().join("yt-player-cache");
        let _ = std::fs::create_dir_all(&cache_dir);
        let initial_bundle = load_latest_disk_bundle(&cache_dir);
        let solver = Self {
            cache_dir,
            bundle: Mutex::new(initial_bundle.clone()),
            init_lock: AsyncMutex::new(()),
            worker_tx: Mutex::new(None),
        };
        if let Some(b) = initial_bundle {
            solver.warmup_worker(&b.player_id, &b.preprocessed_js);
        }
        solver
    }

    fn warmup_worker(&self, player_id: &str, preprocessed_js: &str) {
        if let Ok(tx) = self.ensure_worker() {
            let _ = tx.send(WorkerMsg::Warmup {
                player_id: player_id.to_string(),
                preprocessed_js: preprocessed_js.to_string(),
            });
        }
    }

    pub fn current_sts(&self) -> Option<u64> {
        let guard = self.bundle.lock().ok()?;
        let b = guard.as_ref()?;
        (b.fetched_at.elapsed() < PLAYER_CACHE_TTL).then_some(b.sts)
    }

    pub async fn ensure_ready(&self, http: &Client) -> Result<(String, u64), String> {
        if let Some((pid, sts)) = self.valid_cached_meta() {
            return Ok((pid, sts));
        }
        let _guard = self.init_lock.lock().await;
        if let Some((pid, sts)) = self.valid_cached_meta() {
            return Ok((pid, sts));
        }

        let (player_id, sts, base_js) = fetch_current_player_js(http).await?;
        if let Some(disk_bundle) = load_disk_bundle(&self.cache_dir, &player_id) {
            if let Ok(mut g) = self.bundle.lock() {
                *g = Some(disk_bundle.clone());
            }
            self.warmup_worker(&disk_bundle.player_id, &disk_bundle.preprocessed_js);
            return Ok((disk_bundle.player_id, disk_bundle.sts));
        }

        let preprocessed_js = preprocess_player_js(base_js).await?;
        save_disk_bundle(&self.cache_dir, &player_id, sts, &preprocessed_js);

        let bundle = CachedPlayerBundle {
            player_id: player_id.clone(),
            sts,
            preprocessed_js: preprocessed_js.clone(),
            fetched_at: Instant::now(),
        };
        if let Ok(mut g) = self.bundle.lock() {
            *g = Some(bundle);
        }
        self.warmup_worker(&player_id, &preprocessed_js);
        Ok((player_id, sts))
    }

    pub fn invalidate_player(&self) {
        if let Ok(mut g) = self.bundle.lock() {
            *g = None;
        }
        if let Ok(guard) = self.worker_tx.lock()
            && let Some(tx) = guard.as_ref() {
                let _ = tx.send(WorkerMsg::Invalidate);
            }
    }

    pub async fn solve_sig_and_n(
        self: &Arc<Self>,
        http: &Client,
        sig: Option<&str>,
        n: Option<&str>,
    ) -> Result<(Option<String>, Option<String>), String> {
        let (player_id, _) = self.ensure_ready(http).await?;
        let preprocessed_js = {
            let guard = self.bundle.lock().map_err(|_| "solver lock poisoned")?;
            let b = guard
                .as_ref()
                .ok_or_else(|| "player bundle missing".to_string())?;
            if b.player_id != player_id {
                return Err("player bundle rotated".to_string());
            }
            b.preprocessed_js.clone()
        };

        let tx = self.ensure_worker()?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerMsg::Solve {
            player_id,
            preprocessed_js,
            sig: sig.map(ToOwned::to_owned),
            n: n.map(ToOwned::to_owned),
            reply: reply_tx,
        })
        .map_err(|_| "QuickJS solver worker stopped".to_string())?;

        reply_rx
            .await
            .map_err(|_| "QuickJS solver worker dropped reply".to_string())?
    }

    fn ensure_worker(&self) -> Result<mpsc::Sender<WorkerMsg>, String> {
        let mut guard = self
            .worker_tx
            .lock()
            .map_err(|_| "worker lock poisoned".to_string())?;
        if let Some(tx) = guard.as_ref() {
            return Ok(tx.clone());
        }
        let (tx, rx) = mpsc::channel::<WorkerMsg>();
        std::thread::Builder::new()
            .name("yt-qjs-solver".to_string())
            .spawn(move || run_qjs_worker(rx))
            .map_err(|e| format!("Failed to spawn QuickJS worker thread: {e}"))?;
        *guard = Some(tx.clone());
        Ok(tx)
    }

    fn valid_cached_meta(&self) -> Option<(String, u64)> {
        let guard = self.bundle.lock().ok()?;
        let b = guard.as_ref()?;
        (b.fetched_at.elapsed() < PLAYER_CACHE_TTL).then(|| (b.player_id.clone(), b.sts))
    }
}

fn run_qjs_worker(rx: mpsc::Receiver<WorkerMsg>) {
    let mut loaded: Option<LoadedQjsSolver> = None;
    while let Ok(msg) = rx.recv() {
        match msg {
            WorkerMsg::Invalidate => {
                loaded = None;
            }
            WorkerMsg::Warmup {
                player_id,
                preprocessed_js,
            } => {
                let _ = ensure_loaded_qjs(&mut loaded, &player_id, &preprocessed_js);
            }
            WorkerMsg::Solve {
                player_id,
                preprocessed_js,
                sig,
                n,
                reply,
            } => {
                let res = solve_on_worker_thread(
                    &mut loaded,
                    &player_id,
                    &preprocessed_js,
                    sig.as_deref(),
                    n.as_deref(),
                );
                let _ = reply.send(res);
            }
        }
    }
}

fn ensure_loaded_qjs<'a>(
    loaded: &'a mut Option<LoadedQjsSolver>,
    player_id: &str,
    preprocessed_js: &str,
) -> Result<&'a LoadedQjsSolver, String> {
    if loaded
        .as_ref()
        .is_none_or(|state| state.player_id != player_id)
    {
        let rt = QjsRuntime::new().map_err(|e| format!("QuickJS runtime failed: {e}"))?;
        let ctx = QjsContext::full(&rt).map_err(|e| format!("QuickJS context failed: {e}"))?;
        ctx.with(|ctx| -> Result<(), String> {
            ctx.globals()
                .set("__PRE", preprocessed_js)
                .map_err(|e| format!("QuickJS set __PRE failed: {e}"))?;
            ctx.eval::<(), _>(
                "var __SOLVER = { n: null, sig: null }; Function('_result', __PRE)(__SOLVER);",
            )
            .map_err(|e| format!("QuickJS init solver failed: {e}"))?;
            Ok(())
        })?;
        *loaded = Some(LoadedQjsSolver {
            player_id: player_id.to_string(),
            _rt: rt,
            ctx,
        });
    }
    loaded
        .as_ref()
        .ok_or_else(|| "QuickJS solver missing".to_string())
}

fn solve_on_worker_thread(
    loaded: &mut Option<LoadedQjsSolver>,
    player_id: &str,
    preprocessed_js: &str,
    sig: Option<&str>,
    n: Option<&str>,
) -> Result<(Option<String>, Option<String>), String> {
    let state = ensure_loaded_qjs(loaded, player_id, preprocessed_js)?;

    state.ctx.with(|ctx| {
        let solved_sig = if let Some(s) = sig {
            ctx.globals()
                .set("__IN_SIG", s)
                .map_err(|e| format!("QuickJS set sig failed: {e}"))?;
            let out: String = ctx
                .eval("typeof __SOLVER.sig === 'function' ? String(__SOLVER.sig(__IN_SIG)) : ''")
                .map_err(|e| format!("QuickJS sig solve failed: {e}"))?;
            if out.is_empty() {
                return Err("QuickJS sig solver returned empty".to_string());
            }
            Some(out)
        } else {
            None
        };

        let solved_n = if let Some(nv) = n {
            ctx.globals()
                .set("__IN_N", nv)
                .map_err(|e| format!("QuickJS set n failed: {e}"))?;
            let out: String = ctx
                .eval("typeof __SOLVER.n === 'function' ? String(__SOLVER.n(__IN_N)) : ''")
                .map_err(|e| format!("QuickJS n solve failed: {e}"))?;
            if out.is_empty() {
                return Err("QuickJS n solver returned empty".to_string());
            }
            Some(out)
        } else {
            None
        };

        Ok((solved_sig, solved_n))
    })
}

async fn fetch_current_player_js(http: &Client) -> Result<(String, u64, String), String> {
    let iframe_js = http
        .get(IFRAME_API_URL)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Failed to fetch iframe_api: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Failed to read iframe_api: {e}"))?;

    let player_id = extract_player_id(&iframe_js)
        .ok_or_else(|| "Could not extract YouTube player ID from iframe_api".to_string())?;

    let base_url = format!("https://www.youtube.com/s/player/{player_id}/player_ias.vflset/en_US/base.js");
    let base_js = http
        .get(&base_url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Failed to fetch player base.js: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Failed to read player base.js: {e}"))?;

    let sts = extract_sts(&base_js)
        .ok_or_else(|| "Could not extract signatureTimestamp from base.js".to_string())?;
    Ok((player_id, sts, base_js))
}

fn extract_player_id(iframe_js: &str) -> Option<String> {
    for needle in ["player\\/", "player/"] {
        if let Some(idx) = iframe_js.find(needle) {
            let rest = &iframe_js[idx + needle.len()..];
            let id: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            if id.len() >= 6 {
                return Some(id);
            }
        }
    }
    None
}

fn extract_sts(base_js: &str) -> Option<u64> {
    let idx = base_js.find("signatureTimestamp:")?;
    let rest = &base_js[idx + "signatureTimestamp:".len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u64>().ok()
}

#[derive(Deserialize)]
struct PreprocessResult {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    preprocessed_player: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

async fn preprocess_player_js(base_js: String) -> Result<String, String> {
    if let Some(pre) = try_external_js_preprocess(&base_js).await {
        return Ok(pre);
    }

    tokio::task::spawn_blocking(move || preprocess_via_quickjs(&base_js))
        .await
        .map_err(|e| format!("QuickJS preprocess join failed: {e}"))?
}

async fn try_external_js_preprocess(base_js: &str) -> Option<String> {
    let payload = serde_json::json!({
        "type": "player",
        "player": base_js,
        "requests": [],
        "output_preprocessed": true,
    })
    .to_string();
    let script = format!(
        "{LIB_MIN_JS}\nconst {{ meriyah, astring }} = lib;\n{CORE_MIN_JS}\nconst __out = jsc({payload});\nconsole.log(JSON.stringify(__out));\n"
    );

    for (bin, args) in [
        ("node", vec!["-"]),
        ("deno", vec!["run", "--ext=js", "-"]),
    ] {
        let Some(exe) = find_bin_in_path(bin) else {
            continue;
        };
        let mut cmd = Command::new(exe);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let Ok(mut child) = cmd.spawn() else {
            continue;
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(script.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
        let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(12), child.wait_with_output()).await else {
            continue;
        };
        if !out.status.success() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_slice::<PreprocessResult>(&out.stdout)
            && parsed.kind == "result"
                && let Some(pre) = parsed.preprocessed_player.filter(|s| !s.is_empty()) {
                    return Some(pre);
                }
    }
    None
}

fn find_bin_in_path(name: &str) -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(path_var) = std::env::var("PATH") {
        let sep = if cfg!(target_os = "windows") { ';' } else { ':' };
        dirs.extend(path_var.split(sep).filter(|s| !s.is_empty()).map(PathBuf::from));
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    dirs.into_iter().map(|d| d.join(&exe_name)).find(|p| p.is_file())
}

fn preprocess_via_quickjs(base_js: &str) -> Result<String, String> {
    let rt = QjsRuntime::new().map_err(|e| format!("QuickJS runtime error: {e}"))?;
    let ctx = QjsContext::full(&rt).map_err(|e| format!("QuickJS context error: {e}"))?;
    ctx.with(|ctx| {
        ctx.eval::<(), _>(LIB_MIN_JS)
            .map_err(|e| format!("QuickJS lib eval error: {e}"))?;
        ctx.eval::<(), _>("const { meriyah, astring } = lib;")
            .map_err(|e| format!("QuickJS lib destructure error: {e}"))?;
        ctx.eval::<(), _>(CORE_MIN_JS)
            .map_err(|e| format!("QuickJS core eval error: {e}"))?;
        ctx.globals()
            .set("__BASE_JS", base_js)
            .map_err(|e| format!("QuickJS set base_js error: {e}"))?;
        let raw: String = ctx
            .eval("JSON.stringify(jsc({type: 'player', player: __BASE_JS, requests: [], output_preprocessed: true}))")
            .map_err(|e| format!("QuickJS preprocess failed: {e}"))?;
        let parsed: PreprocessResult =
            serde_json::from_str(&raw).map_err(|e| format!("QuickJS preprocess parse error: {e}"))?;
        if parsed.kind != "result" {
            return Err(parsed
                .error
                .unwrap_or_else(|| "QuickJS preprocess returned error".to_string()));
        }
        parsed
            .preprocessed_player
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "QuickJS preprocess returned empty output".to_string())
    })
}

fn bundle_paths(cache_dir: &Path, player_id: &str) -> (PathBuf, PathBuf) {
    (
        cache_dir.join(format!("{player_id}.sts")),
        cache_dir.join(format!("{player_id}.pre.js")),
    )
}

fn load_disk_bundle(cache_dir: &Path, player_id: &str) -> Option<CachedPlayerBundle> {
    let (sts_path, js_path) = bundle_paths(cache_dir, player_id);
    let sts = std::fs::read_to_string(sts_path).ok()?.trim().parse::<u64>().ok()?;
    let preprocessed_js = std::fs::read_to_string(js_path).ok()?;
    if preprocessed_js.is_empty() {
        return None;
    }
    Some(CachedPlayerBundle {
        player_id: player_id.to_string(),
        sts,
        preprocessed_js,
        fetched_at: Instant::now(),
    })
}

fn load_latest_disk_bundle(cache_dir: &Path) -> Option<CachedPlayerBundle> {
    let entries = std::fs::read_dir(cache_dir).ok()?;
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(pid) = name.strip_suffix(".pre.js") {
            let mtime = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            if best.as_ref().is_none_or(|(t, _)| mtime > *t) {
                best = Some((mtime, pid.to_string()));
            }
        }
    }
    let (_, pid) = best?;
    load_disk_bundle(cache_dir, &pid)
}

fn save_disk_bundle(cache_dir: &Path, player_id: &str, sts: u64, preprocessed_js: &str) {
    let (sts_path, js_path) = bundle_paths(cache_dir, player_id);
    let _ = std::fs::write(sts_path, sts.to_string());
    let tmp = js_path.with_extension("js.tmp");
    if std::fs::write(&tmp, preprocessed_js).is_ok() {
        let _ = std::fs::rename(tmp, js_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_player_id_and_sts() {
        let iframe = r#"var scriptUrl = 'https:\/\/www.youtube.com\/s\/player\/fad7e4e9\/www-widgetapi.vflset\/www-widgetapi.js';"#;
        assert_eq!(extract_player_id(iframe).as_deref(), Some("fad7e4e9"));
        let base = r#"foo({signatureTimestamp:20767,bar:1})"#;
        assert_eq!(extract_sts(base), Some(20767));
    }

    #[tokio::test]
    async fn live_web_remix_and_http_proxy_end_to_end() {
        if std::env::var("RUN_LIVE_YT_TEST").as_deref() != Ok("1") {
            return;
        }
        let proxy = crate::yt::proxy::YtStreamProxy::new();
        let port = proxy.ensure_server_port().await.unwrap();
        let t_init = Instant::now();
        let (_, sts) = proxy.player_js.ensure_ready(&proxy.playback_http).await.unwrap();
        println!("player_js ready in {:?}, sts={sts}", t_init.elapsed());

        for vid in ["qCyv1n7LP7U", "trHwYA4ZRg4", "6SM4s-Fy5FU", "2ouIZEuZUts"] {
            let t0 = Instant::now();
            let (resolved, hit, ms, attempts) = proxy.get_or_resolve_stream(vid, true, true, None).await.unwrap();
            let url = format!("http://127.0.0.1:{port}/yt-stream/{vid}?t={}", proxy.token);
            let resp = proxy
                .stream_http
                .get(&url)
                .header("Range", "bytes=0-2097151")
                .send()
                .await
                .unwrap();
            let status = resp.status().as_u16();
            let bytes = resp.bytes().await.unwrap();
            println!(
                "{vid}: total={:?} resolve_ms={ms} hit={hit} label={} http={status} bytes={} attempts={:?}",
                t0.elapsed(),
                resolved.level_label,
                bytes.len(),
                attempts.iter().map(|a| format!("{}:{}({}ms)", a.method, a.outcome, a.duration_ms)).collect::<Vec<_>>()
            );
            assert!(status == 200 || status == 206);
            assert!(bytes.len() >= 1_500_000);
        }
    }
}
