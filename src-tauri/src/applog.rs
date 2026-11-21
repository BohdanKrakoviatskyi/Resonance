//! Backend log file.
//!
//! The backend reports what it did through `log`, but a release build installs no logger, so every
//! `log::warn!` in the stream and auth paths went nowhere — exactly the runs that need a record.
//! This writes them beside the player timing log the frontend already keeps.

use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 2 << 20;
const BUFFER_BYTES: usize = 32 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_secs(2);
const FLUSH_RECORDS: usize = 64;

struct LogFile {
    writer: BufWriter<std::fs::File>,
    last_flush: Instant,
    unflushed: usize,
}

impl LogFile {
    fn flush_if_due(&mut self) {
        if self.unflushed >= FLUSH_RECORDS || self.last_flush.elapsed() >= FLUSH_INTERVAL {
            self.flush_now();
        }
    }

    fn flush_now(&mut self) {
        let _ = self.writer.flush();
        self.last_flush = Instant::now();
        self.unflushed = 0;
    }
}

struct FileLogger {
    file: Mutex<LogFile>,
}

impl FileLogger {
    fn flush_all(&self) {
        if let Ok(mut file) = self.file.lock() {
            file.flush_now();
        }
    }

    /// Never blocks: the panic hook runs before unwinding, while a panicking thread may still hold
    /// the lock, and a blocked hook would hang the process instead of unwinding.
    fn flush_from_panic(&self) {
        if let Ok(mut file) = self.file.try_lock() {
            file.flush_now();
        }
    }
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
            if writeln!(file.writer, "[{stamp}] {} {}: {}", record.level(), record.target(), record.args()).is_ok() {
                file.unflushed += 1;
            }
            file.flush_if_due();
        }
    }

    fn flush(&self) {
        self.flush_all();
    }
}

static LOGGER: OnceLock<&'static FileLogger> = OnceLock::new();

/// Flushes buffered records: called before the process exits and from the panic hook, so a crash
/// still leaves the last lines on disk.
pub fn flush() {
    if let Some(logger) = LOGGER.get() {
        logger.flush_all();
    }
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
    let logger: &'static FileLogger = Box::leak(Box::new(FileLogger {
        file: Mutex::new(LogFile {
            writer: BufWriter::with_capacity(BUFFER_BYTES, file),
            last_flush: Instant::now(),
            unflushed: 0,
        }),
    }));
    let _ = LOGGER.set(logger);
    if log::set_logger(logger).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(logger) = LOGGER.get() {
            logger.flush_from_panic();
        }
        previous_hook(info);
    }));
}
