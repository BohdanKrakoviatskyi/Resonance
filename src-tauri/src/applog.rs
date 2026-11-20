//! Backend log file.
//!
//! The backend reports what it did through `log`, but a release build installs no logger, so every
//! `log::warn!` in the stream and auth paths went nowhere — exactly the runs that need a record.
//! This writes them beside the player timing log the frontend already keeps.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 2 << 20;

struct FileLogger {
    file: Mutex<std::fs::File>,
}

impl log::Log for FileLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default();
        if let Ok(mut file) = self.file.lock() {
            let _ = writeln!(file, "[{stamp}] {} {}: {}", record.level(), record.target(), record.args());
        }
    }

    fn flush(&self) {}
}

fn log_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".resonance"))
}

/// Installs the file logger. Best effort: a build without a writable home still runs.
pub fn init() {
    let Some(dir) = log_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("backend.log");
    if std::fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("backend.log.1"));
    }
    let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else { return };
    let logger: &'static FileLogger = Box::leak(Box::new(FileLogger { file: Mutex::new(file) }));
    if log::set_logger(logger).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}
