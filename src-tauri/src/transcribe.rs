//! Local speech-to-text lyrics with whisper.cpp (the last-resort source when no service has the
//! lyrics). Models are downloaded on demand; transcription runs on one background worker, one
//! job at a time, with a user-chosen thread count and lowered OS priority so playback and the
//! rest of the system stay responsive. A newer job (track change) cancels the running one.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::Emitter;
use tokio::io::AsyncWriteExt;

use crate::lyrics_words::{Word, WordLine};

/// (id, file, approx MB). Quantized models: much smaller, nearly the same accuracy.
pub const MODELS: &[(&str, &str, u32)] = &[
    ("base", "ggml-base-q5_1.bin", 60),
    ("small", "ggml-small-q5_1.bin", 190),
    ("medium", "ggml-medium-q5_0.bin", 539),
];
const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

fn models_dir() -> PathBuf {
    let dir = crate::yt::clients::app_data_root_dir().join("whisper-models");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn model_file(id: &str) -> Option<&'static str> {
    MODELS.iter().find(|m| m.0 == id).map(|m| m.1)
}

fn model_path(id: &str) -> Option<PathBuf> {
    model_file(id).map(|f| models_dir().join(f))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub size_mb: u32,
    pub installed: bool,
}

#[tauri::command]
pub fn whisper_models() -> Vec<ModelInfo> {
    MODELS
        .iter()
        .map(|(id, file, mb)| ModelInfo {
            id: (*id).to_string(),
            size_mb: *mb,
            installed: models_dir().join(file).metadata().is_ok_and(|m| m.len() > 10 << 20),
        })
        .collect()
}

static DOWNLOAD_CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress<'a> {
    model: &'a str,
    received: u64,
    total: u64,
}

#[tauri::command]
pub async fn whisper_download(app: tauri::AppHandle, model: String) -> Result<(), String> {
    let file = model_file(&model).ok_or("unknown model")?;
    let dest = models_dir().join(file);
    let part = dest.with_extension("bin.part");
    DOWNLOAD_CANCEL.store(false, Ordering::SeqCst);
    let mut resp = reqwest::Client::new()
        .get(format!("{MODEL_BASE_URL}{file}"))
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status().as_u16()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut out = tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?;
    let mut received = 0u64;
    let mut last_emit = 0u64;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("download interrupted: {e}"))? {
        if DOWNLOAD_CANCEL.load(Ordering::SeqCst) {
            drop(out);
            let _ = tokio::fs::remove_file(&part).await;
            return Err("cancelled".into());
        }
        out.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if received - last_emit >= 512 * 1024 || received == total {
            last_emit = received;
            let _ = app.emit("whisper-download", DownloadProgress { model: &model, received, total });
        }
    }
    out.flush().await.map_err(|e| e.to_string())?;
    drop(out);
    if total > 0 && received != total {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("download incomplete".into());
    }
    tokio::fs::rename(&part, &dest).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn whisper_cancel_download() {
    DOWNLOAD_CANCEL.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn whisper_delete(state: tauri::State<'_, WhisperWorker>, model: String) -> Result<(), String> {
    let path = model_path(&model).ok_or("unknown model")?;
    // Unload first so Windows can delete the file.
    let _ = state.tx.lock().map(|tx| tx.send(Msg::Unload));
    std::thread::sleep(std::time::Duration::from_millis(150));
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/* ---------------- tokens → lyric lines (pure, tested) ---------------- */

pub struct RawToken {
    pub text: String,
    /// Centiseconds.
    pub t0: i64,
    pub t1: i64,
    /// DTW-aligned start (centiseconds), far more accurate than t0; -1 when unavailable.
    pub t_dtw: i64,
}

pub struct RawSegment {
    pub t0: i64,
    pub t1: i64,
    pub no_speech: f32,
    pub tokens: Vec<RawToken>,
}

fn is_noise_line(text: &str) -> bool {
    let t = text.trim().trim_matches(|c: char| "♪♫[]()*-.… ".contains(c)).to_lowercase();
    t.is_empty()
        || matches!(t.as_str(), "music" | "music playing" | "музыка" | "instrumental" | "applause" | "silence" | "blank_audio" | "no speech")
        || t.starts_with("субтитры")
        || t.contains("subtitles by")
}

/// Groups whisper tokens into words (a leading space starts a new word) and segments into lines.
pub fn build_lines(segments: Vec<RawSegment>) -> Vec<WordLine> {
    let mut out: Vec<WordLine> = Vec::new();
    for seg in segments {
        if seg.no_speech > 0.6 {
            continue;
        }
        let mut words: Vec<Word> = Vec::new();
        for tok in seg.tokens {
            if tok.text.starts_with("[_") || tok.text.starts_with("<|") || tok.text.is_empty() {
                continue;
            }
            let starts_word = tok.text.starts_with(' ') || words.is_empty();
            let start = if tok.t_dtw >= 0 { tok.t_dtw } else { tok.t0 };
            let (t0, t1) = (start.max(seg.t0) * 10, tok.t1.max(start).max(seg.t0) * 10);
            if starts_word {
                if let Some(prev) = words.last_mut() {
                    prev.text.push(' ');
                }
                words.push(Word { start_ms: t0, dur_ms: (t1 - t0).max(1), text: tok.text.trim_start().to_string() });
            } else if let Some(w) = words.last_mut() {
                w.text.push_str(&tok.text);
                w.dur_ms = (t1 - w.start_ms).max(w.dur_ms);
            }
        }
        let text: String = words.iter().map(|w| w.text.as_str()).collect();
        if words.is_empty() || is_noise_line(&text) {
            continue;
        }
        // Whisper sometimes loops on a phrase in silence: drop a third identical line in a row.
        let n = out.len();
        let same = |l: &WordLine| l.words.iter().map(|w| w.text.as_str()).collect::<String>().trim() == text.trim();
        if n >= 2 && same(&out[n - 1]) && same(&out[n - 2]) {
            continue;
        }
        // A word lasts until the next one starts (capped); a word "held" for seconds is really an
        // instrumental gap that alignment glued onto it, so it starts shortly before it ends.
        let seg_end = seg.t1 * 10;
        for i in 0..words.len() {
            let next = words.get(i + 1).map_or(seg_end, |n| n.start_ms);
            let w = &mut words[i];
            w.dur_ms = (next - w.start_ms).clamp(1, 2_000);
            if next - w.start_ms > 2_500 && i == 0 {
                w.start_ms = next - 600;
                w.dur_ms = 600;
            }
        }
        // Whisper segments can span several sung lines: break after sentence punctuation,
        // at a pause (next word starts > 1.8 s after this one), or after 9 words.
        let starts: Vec<i64> = words.iter().map(|w| w.start_ms).collect();
        let mut line: Vec<Word> = Vec::new();
        for (i, w) in words.into_iter().enumerate() {
            let ends_sentence = w.text.trim_end().ends_with(['.', '!', '?', '…']);
            let pause = starts.get(i + 1).is_some_and(|n| n - starts[i] > 1_800);
            line.push(w);
            if ends_sentence || line.len() >= 9 || (pause && line.len() >= 2) {
                push_line(&mut out, std::mem::take(&mut line));
            }
        }
        push_line(&mut out, line);
    }
    out
}

fn push_line(out: &mut Vec<WordLine>, mut words: Vec<Word>) {
    let Some(first) = words.first() else { return };
    let start_ms = first.start_ms;
    if let Some(last) = words.last_mut() {
        last.text = last.text.trim_end().to_string();
    }
    out.push(WordLine { start_ms, words });
}

/* ---------------- worker ---------------- */

struct Job {
    id: u64,
    app: Option<tauri::AppHandle>,
    request_id: String,
    track_id: String,
    model: PathBuf,
    threads: i32,
    /// ISO code ("en", "ru") or "auto".
    lang: String,
    pcm: Vec<f32>,
    reply: tokio::sync::oneshot::Sender<Result<Vec<WordLine>, String>>,
}

enum Msg {
    Run(Job),
    Unload,
}

pub struct WhisperWorker {
    tx: Mutex<Sender<Msg>>,
    next_id: AtomicU64,
    /// Jobs with id <= this are cancelled.
    cancel_upto: Arc<AtomicU64>,
}

impl Default for WhisperWorker {
    fn default() -> Self {
        let (tx, rx) = mpsc::channel();
        let cancel_upto = Arc::new(AtomicU64::new(0));
        let c = cancel_upto.clone();
        std::thread::Builder::new()
            .name("whisper".into())
            .spawn(move || worker(rx, c))
            .expect("spawn whisper worker");
        Self { tx: Mutex::new(tx), next_id: AtomicU64::new(1), cancel_upto }
    }
}

/// Lowers scheduling priority so transcription yields to playback, UI and other apps.
/// Returns a guard that restores the previous setting.
struct LowPriority;

#[cfg(windows)]
mod prio {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn SetPriorityClass(process: isize, class: u32) -> i32;
    }
    const NORMAL: u32 = 0x20;
    const BELOW_NORMAL: u32 = 0x4000;
    // The webview that plays audio is a separate process (WebView2), so it is unaffected.
    pub fn lower() {
        unsafe { SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL) };
    }
    pub fn restore() {
        unsafe { SetPriorityClass(GetCurrentProcess(), NORMAL) };
    }
}

#[cfg(unix)]
mod prio {
    unsafe extern "C" {
        fn setpriority(which: i32, who: u32, prio: i32) -> i32;
    }
    // Linux: per-thread nice, inherited by the ggml threads this worker spawns.
    pub fn lower() {
        unsafe { setpriority(0, 0, 10) };
    }
    pub fn restore() {}
}

impl LowPriority {
    fn enter() -> Self {
        prio::lower();
        LowPriority
    }
}

impl Drop for LowPriority {
    fn drop(&mut self) {
        prio::restore();
    }
}

struct AbortCtx {
    id: u64,
    cancel_upto: Arc<AtomicU64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SegmentUpdate {
    request_id: String,
    track_id: String,
    text: String,
}

struct SegmentCallbackCtx {
    app: Option<tauri::AppHandle>,
    request_id: String,
    track_id: String,
    next_segment: i32,
}

/// Emits segments after whisper.cpp has finalized their timestamps, including DTW alignment.
unsafe extern "C" fn segment_callback(
    _ctx: *mut whisper_rs::WhisperSysContext,
    state: *mut whisper_rs::WhisperSysState,
    _n_new: i32,
    user_data: *mut std::ffi::c_void,
) {
    use std::ffi::CStr;
    let callback = unsafe { &mut *(user_data as *mut SegmentCallbackCtx) };
    let count = unsafe { whisper_rs::whisper_rs_sys::whisper_full_n_segments_from_state(state) };
    while callback.next_segment < count {
        let index = callback.next_segment;
        callback.next_segment += 1;
        let text_ptr = unsafe {
            whisper_rs::whisper_rs_sys::whisper_full_get_segment_text_from_state(state, index)
        };
        if text_ptr.is_null() {
            continue;
        }
        let text = unsafe { CStr::from_ptr(text_ptr) }.to_string_lossy().trim().to_string();
        if text.is_empty() {
            continue;
        }
        if let Some(app) = &callback.app {
            let _ = app.emit("whisper-segment", SegmentUpdate {
                request_id: callback.request_id.clone(),
                track_id: callback.track_id.clone(),
                text,
            });
        }
    }
}

/// whisper.cpp polls this during encode/decode; returning true aborts the job.
unsafe extern "C" fn abort_cb(user_data: *mut std::ffi::c_void) -> bool {
    // SAFETY: user_data points at the AbortCtx owned by the worker for the duration of `full`.
    let ctx = unsafe { &*(user_data as *const AbortCtx) };
    ctx.id <= ctx.cancel_upto.load(Ordering::SeqCst)
}

fn worker(rx: Receiver<Msg>, cancel_upto: Arc<AtomicU64>) {
    use whisper_rs::{DtwMode, DtwModelPreset, DtwParameters, FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
    // Route whisper.cpp/ggml's chatty stderr/stdout logging away from the console.
    whisper_rs::install_logging_hooks();
    let mut loaded: Option<(PathBuf, WhisperContext)> = None;
    while let Ok(msg) = rx.recv() {
        let job = match msg {
            Msg::Unload => {
                loaded = None;
                continue;
            }
            Msg::Run(job) => job,
        };
        if job.id <= cancel_upto.load(Ordering::SeqCst) {
            let _ = job.reply.send(Err("cancelled".into()));
            continue;
        }
        let _prio = LowPriority::enter();
        let result = (|| -> Result<Vec<WordLine>, String> {
            if loaded.as_ref().is_none_or(|(p, _)| p != &job.model) {
                loaded = None;
                // DTW alignment heads give word timestamps that actually follow the vocals;
                // plain token timestamps drift badly over long instrumental intros.
                let name = job.model.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let preset = if name.contains("medium") {
                    Some(DtwModelPreset::Medium)
                } else if name.contains("small") {
                    Some(DtwModelPreset::Small)
                } else if name.contains("base") {
                    Some(DtwModelPreset::Base)
                } else {
                    None
                };
                let mut cparams = WhisperContextParameters::default();
                if let Some(model_preset) = preset {
                    cparams.dtw_parameters(DtwParameters { mode: DtwMode::ModelPreset { model_preset }, ..Default::default() });
                }
                let ctx = WhisperContext::new_with_params(&job.model, cparams).map_err(|e| format!("model load failed: {e}"))?;
                loaded = Some((job.model.clone(), ctx));
            }
            let ctx = &loaded.as_ref().ok_or("model not loaded")?.1;
            let mut state = ctx.create_state().map_err(|e| e.to_string())?;
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_n_threads(job.threads.max(1));
            params.set_language(Some(job.lang.as_str()));
            params.set_token_timestamps(true);
            params.set_suppress_blank(true);
            // Songs: without this Whisper happily answers "[Music]" for every sung segment.
            params.set_suppress_nst(true);
            params.set_print_special(false);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);
            // Not `set_abort_callback_safe`: in whisper-rs 0.16 it boxes the closure as
            // `Box<Box<dyn FnMut>>` but the trampoline reads it as the concrete closure type,
            // so the callback returns garbage and aborts at random. A plain C callback with an
            // explicit context is used instead; `abort_ctx` outlives `state.full`.
            let abort_ctx = AbortCtx { id: job.id, cancel_upto: cancel_upto.clone() };
            let mut segment_ctx = SegmentCallbackCtx {
                app: job.app.clone(),
                request_id: job.request_id.clone(),
                track_id: job.track_id.clone(),
                next_segment: 0,
            };
            unsafe {
                params.set_abort_callback(Some(abort_cb));
                params.set_abort_callback_user_data(&abort_ctx as *const AbortCtx as *mut std::ffi::c_void);
                params.set_new_segment_callback(Some(segment_callback));
                params.set_new_segment_callback_user_data(&mut segment_ctx as *mut SegmentCallbackCtx as *mut std::ffi::c_void);
            }
            let res = state.full(params, &job.pcm);
            drop(segment_ctx);
            drop(abort_ctx);
            res.map_err(|e| {
                if job.id <= cancel_upto.load(Ordering::SeqCst) { "cancelled".to_string() } else { format!("transcription failed: {e}") }
            })?;
            if job.id <= cancel_upto.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            let mut segments = Vec::new();
            for seg in state.as_iter() {
                let mut tokens = Vec::new();
                for i in 0..seg.n_tokens() {
                    let Some(tok) = seg.get_token(i) else { continue };
                    let d = tok.token_data();
                    tokens.push(RawToken { text: tok.to_str_lossy().map(|s| s.into_owned()).unwrap_or_default(), t0: d.t0, t1: d.t1, t_dtw: d.t_dtw });
                }
                if std::env::var_os("RESONANCE_WHISPER_DEBUG").is_some() {
                    eprintln!("seg {}..{} no_speech={:.2} {:?}", seg.start_timestamp(), seg.end_timestamp(), seg.no_speech_probability(), seg.to_str_lossy().unwrap_or_default());
                }
                segments.push(RawSegment { t0: seg.start_timestamp(), t1: seg.end_timestamp(), no_speech: seg.no_speech_probability(), tokens });
            }
            Ok(build_lines(segments))
        })();
        let _ = job.reply.send(result);
    }
}

/// Body: raw little-endian f32 PCM, 16 kHz mono. Headers: `x-model`, `x-threads`, `x-lang`.
#[tauri::command]
pub async fn whisper_transcribe(app: tauri::AppHandle, state: tauri::State<'_, WhisperWorker>, request: tauri::ipc::Request<'_>) -> Result<Vec<WordLine>, String> {
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    let request_id = header("x-request-id");
    let track_id = header("x-track-id");
    if request_id.is_empty() || track_id.is_empty() {
        return Err("missing transcription request metadata".into());
    }
    let model = model_path(&header("x-model")).filter(|p| p.is_file()).ok_or("model is not downloaded")?;
    let threads: i32 = header("x-threads").parse().unwrap_or(2);
    let lang = header("x-lang");
    let lang = if lang.len() == 2 && lang.bytes().all(|b| b.is_ascii_lowercase()) { lang } else { "auto".to_string() };
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw PCM body".into()) };
    if bytes.len() % 4 != 0 || bytes.len() < 16_000 * 4 {
        return Err("audio too short".into());
    }
    let pcm: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    // One job at a time: a new request supersedes whatever is running or queued.
    state.cancel_upto.store(id - 1, Ordering::SeqCst);
    let (reply, rx) = tokio::sync::oneshot::channel();
    state
        .tx
        .lock()
        .map_err(|e| e.to_string())?
        .send(Msg::Run(Job { id, app: Some(app), request_id, track_id, model, threads: threads.clamp(1, 64), lang, pcm, reply }))
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "worker stopped".to_string())?
}

#[tauri::command]
pub fn whisper_cancel(state: tauri::State<'_, WhisperWorker>) {
    let latest = state.next_id.load(Ordering::SeqCst).saturating_sub(1);
    state.cancel_upto.store(latest, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tok(text: &str, t0: i64, t1: i64) -> RawToken {
        RawToken { text: text.into(), t0, t1, t_dtw: -1 }
    }

    #[test]
    fn groups_subword_tokens_into_words() {
        let lines = build_lines(vec![RawSegment {
            t0: 100,
            t1: 300,
            no_speech: 0.1,
            tokens: vec![tok("[_BEG_]", 100, 100), tok(" Hel", 100, 120), tok("lo", 120, 150), tok(" world", 160, 220), tok("<|endoftext|>", 300, 300)],
        }]);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].start_ms, 1000);
        let w: Vec<_> = lines[0].words.iter().map(|w| (w.text.as_str(), w.start_ms, w.dur_ms)).collect();
        // A word lasts until the next starts; the last one until the segment ends.
        assert_eq!(w, vec![("Hello ", 1000, 600), ("world", 1600, 1400)]);
    }

    #[test]
    fn moves_a_first_word_stretched_over_an_intro() {
        let lines = build_lines(vec![RawSegment {
            t0: 0,
            t1: 2000,
            no_speech: 0.0,
            tokens: vec![RawToken { text: " We're".into(), t0: 0, t1: 10, t_dtw: 100 }, RawToken { text: " no".into(), t0: 10, t1: 20, t_dtw: 1890 }],
        }]);
        assert_eq!(lines[0].start_ms, 18_300, "starts 0.6 s before the next word, not at the intro");
    }

    #[test]
    fn splits_long_segments_into_lines() {
        let tokens = vec![tok(" One", 0, 10), tok(" more", 10, 20), tok(" time.", 20, 30), tok(" We're", 40, 50), tok(" gonna", 50, 60), tok(" go", 60, 70)];
        let lines = build_lines(vec![RawSegment { t0: 0, t1: 70, no_speech: 0.0, tokens }]);
        let texts: Vec<String> = lines.iter().map(|l| l.words.iter().map(|w| w.text.as_str()).collect()).collect();
        assert_eq!(texts, vec!["One more time.", "We're gonna go"]);
        assert_eq!(lines[1].start_ms, 400);
    }

    #[test]
    fn drops_music_markers_silence_and_loops() {
        let seg = |t0: i64, text: &str, ns: f32| RawSegment { t0, t1: t0 + 100, no_speech: ns, tokens: vec![tok(&format!(" {text}"), t0, t0 + 50)] };
        let lines = build_lines(vec![
            seg(0, "[Music]", 0.1),
            seg(100, "♪", 0.1),
            seg(200, "real line", 0.9),
            seg(300, "again", 0.1),
            seg(400, "again", 0.1),
            seg(500, "again", 0.1),
            seg(600, "end", 0.1),
        ]);
        let texts: Vec<String> = lines.iter().map(|l| l.words.iter().map(|w| w.text.as_str()).collect()).collect();
        assert_eq!(texts, vec!["again", "again", "end"]);
    }

    /// End-to-end: `WHISPER_TEST_WAV=<16 kHz mono 16-bit wav> cargo test --lib live_whisper -- --ignored --nocapture`
    /// (needs the model, default "small", downloaded into the app data folder).
    #[test]
    #[ignore]
    fn live_whisper() {
        let wav = std::fs::read(std::env::var("WHISPER_TEST_WAV").expect("WHISPER_TEST_WAV")).unwrap();
        let data = &wav[44..];
        let pcm: Vec<f32> = data.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
        let w = WhisperWorker::default();
        let (reply, rx) = tokio::sync::oneshot::channel();
        let threads: i32 = std::env::var("WHISPER_THREADS").ok().and_then(|s| s.parse().ok()).unwrap_or(2);
        let t = std::time::Instant::now();
        w.tx.lock().unwrap().send(Msg::Run(Job { id: 1, app: None, request_id: "test".into(), track_id: "test".into(), model: model_path(&std::env::var("WHISPER_MODEL").unwrap_or_else(|_| "small".into())).unwrap(), threads, lang: std::env::var("WHISPER_LANG").unwrap_or_else(|_| "auto".into()), pcm, reply })).unwrap();
        let lines = tauri::async_runtime::block_on(rx).unwrap().unwrap();
        println!("{} lines in {:?} with {threads} threads", lines.len(), t.elapsed());
        for l in &lines {
            println!("  [{}ms] {}", l.start_ms, l.words.iter().map(|w| w.text.as_str()).collect::<String>());
        }
        assert!(!lines.is_empty());
    }

    #[test]
    fn knows_the_model_files() {
        assert_eq!(model_file("small"), Some("ggml-small-q5_1.bin"));
        assert_eq!(model_file("../etc"), None);
    }
}
