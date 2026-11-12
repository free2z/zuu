//! Payload-free native panic capture. No network, caller text, or IPC authority.
//!
//! The host installs this once at process entry, then attaches its private app-data file.
//! The old hook is deliberately replaced, not chained: the default hook prints
//! the unredacted payload to stderr. Hooks installed later can replace this one.
//! Capture is best effort (try-lock, bounded file); it must never deadlock a
//! thread already unwinding or turn a storage failure into another panic.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Maximum persisted records, oldest evicted first.
pub const CAPACITY: usize = 40;
/// Maximum bytes accepted from disk. Oversized or malformed files are discarded.
pub const MAX_BYTES: u64 = 4096;
static INSTALLED: OnceLock<()> = OnceLock::new();

#[derive(Clone, Copy)]
struct Record {
    at: u64,
    line: u32,
    column: u32,
}

impl Record {
    fn encode(self) -> String {
        format!("native-panic {} {} {}\n", self.at, self.line, self.column)
    }

    fn decode(line: &str) -> Option<Self> {
        let mut words = line.split(' ');
        if words.next()? != "native-panic" {
            return None;
        }
        let record = Self {
            at: words.next()?.parse().ok()?,
            line: words.next()?.parse().ok()?,
            column: words.next()?.parse().ok()?,
        };
        if words.next().is_some() || record.encode().trim_end() != line {
            return None;
        }
        Some(record)
    }
}

struct Inner {
    file: Option<File>,
    records: VecDeque<Record>,
}

/// Thread-safe bounded store. Readers receive only validated numeric records.
pub struct Store(Mutex<Inner>);

impl Store {
    /// A bounded fallback when the app-data directory or file cannot be opened.
    pub fn memory() -> Self {
        Self(Mutex::new(Inner {
            file: None,
            records: VecDeque::new(),
        }))
    }

    /// Attach host-owned storage after installing the hook at process entry.
    /// Previous-launch records precede any panics already captured in memory.
    /// Failed attachment leaves the in-memory ring usable and the hook installed.
    pub fn attach_file(&self, path: &Path) -> io::Result<()> {
        let opened = Self::open(path)?;
        let mut restored = opened
            .0
            .into_inner()
            .map_err(|_| io::Error::other("diagnostics lock unavailable"))?;
        let mut current = self
            .0
            .lock()
            .map_err(|_| io::Error::other("diagnostics lock unavailable"))?;
        restored.records.append(&mut current.records);
        while restored.records.len() > CAPACITY {
            restored.records.pop_front();
        }
        *current = restored;
        Self::persist(&mut current)
    }

    /// Open a fixed host-owned file, validating previous-launch records.
    /// Parent directories must already exist; no renderer controls this path.
    pub fn open(path: &Path) -> io::Result<Self> {
        // Refuse obvious symlinks/devices/directories before opening a host-owned
        // path. This is not a sandbox against a local user racing filesystem changes.
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if !metadata.is_file() => {
                return Err(io::Error::other("diagnostics requires a regular file"));
            }
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(io::Error::other("diagnostics requires a regular file"));
        }
        let mut raw = String::new();
        let mut records = VecDeque::new();
        if metadata.len() <= MAX_BYTES
            && Read::by_ref(&mut file)
                .take(MAX_BYTES)
                .read_to_string(&mut raw)
                .is_ok()
            && (raw.is_empty() || raw.ends_with('\n'))
        {
            for line in raw.lines() {
                if let Some(record) = Record::decode(line) {
                    records.push_back(record);
                    if records.len() > CAPACITY {
                        records.pop_front();
                    }
                } else {
                    records.clear();
                    break;
                }
            }
        }
        // Remove malformed/oversized bytes before attaching this file.
        let mut inner = Inner {
            file: Some(file),
            records,
        };
        Self::persist(&mut inner)?;
        Ok(Self(Mutex::new(inner)))
    }

    fn persist(inner: &mut Inner) -> io::Result<()> {
        let Some(file) = inner.file.as_mut() else {
            return Ok(());
        };
        file.rewind()?;
        let text: String = inner.records.iter().map(|r| r.encode()).collect();
        file.set_len(0)?;
        file.write_all(text.as_bytes())?;
        file.flush()
    }

    fn record(&self, line: u32, column: u32) {
        let Ok(mut inner) = self.0.try_lock() else {
            return;
        };
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |t| t.as_secs());
        inner.records.push_back(Record { at, line, column });
        if inner.records.len() > CAPACITY {
            inner.records.pop_front();
        }
        // Failure leaves bounded in-memory evidence; no error or path escapes.
        let _ = Self::persist(&mut inner);
    }

    /// A bounded report with no payload, filename, function, or caller string.
    /// Refuses contention instead of waiting on an unwinding thread doing I/O.
    pub fn report(&self) -> Result<String, &'static str> {
        let inner = self
            .0
            .try_lock()
            .map_err(|_| "native diagnostics unavailable")?;
        Ok(inner.records.iter().map(|r| r.encode()).collect())
    }
}

/// Install once per process. Repeated installation fails without replacing it.
/// Payloads and source paths are never inspected, formatted, or passed onward.
pub fn install(store: Arc<Store>) -> Result<(), &'static str> {
    if INSTALLED.set(()).is_err() {
        return Err("native diagnostics already installed");
    }
    // Replace directly: take_hook() would briefly reinstall the payload-printing
    // default hook between two global mutations while another thread can panic.
    std::panic::set_hook(Box::new(move |info| {
        let (line, column) = info.location().map_or((0, 0), |l| (l.line(), l.column()));
        store.record(line, column);
    }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::panic)] // Deliberate panic payload probes through the shipping hook.
    fn production_hook_drops_payload_and_bounds_concurrent_crash_loop() -> io::Result<()> {
        let path = std::env::temp_dir().join(format!("f2z-diagnostics-{}", std::process::id()));
        let store = Arc::new(Store::memory());
        let previous_called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let previous_probe = Arc::clone(&previous_called);
        std::panic::set_hook(Box::new(move |_| {
            previous_probe.store(true, std::sync::atomic::Ordering::SeqCst);
        }));
        install(Arc::clone(&store)).map_err(io::Error::other)?;
        assert!(install(Arc::clone(&store)).is_err());
        // Startup/storage failure still uses the real payload-dropping hook.
        let _ = std::panic::catch_unwind(|| std::panic::panic_any("private startup payload"));
        assert!(!store.report().map_err(io::Error::other)?.is_empty());
        store.attach_file(&path)?;
        let guard = store
            .0
            .lock()
            .map_err(|_| io::Error::other("test lock unavailable"))?;
        let reader_store = Arc::clone(&store);
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let _ = sender.send(reader_store.report());
        });
        let observed = receiver.recv_timeout(std::time::Duration::from_secs(1));
        drop(guard);
        assert!(reader.join().is_ok());
        assert!(matches!(
            observed,
            Ok(Err("native diagnostics unavailable"))
        ));
        let mut workers = Vec::new();
        for _ in 0..8 {
            workers.push(std::thread::spawn(|| {
                for _ in 0..100 {
                    // Exercise the real hook with secrets and ordinary prose.
                    let _ = std::panic::catch_unwind(|| std::panic::panic_any(
                        "seed abandon abandon abandon; https://private.invalid; bring the blue folder",
                    ));
                }
            }));
        }
        for worker in workers {
            assert!(worker.join().is_ok());
        }
        assert!(!previous_called.load(std::sync::atomic::Ordering::SeqCst));
        let report = store.report().map_err(io::Error::other)?;
        assert!(!report.is_empty());
        assert!(report.lines().count() <= CAPACITY);
        assert!(report.lines().all(|l| Record::decode(l).is_some()));
        assert!(std::fs::metadata(&path)?.len() <= MAX_BYTES);
        assert_eq!(
            report,
            Store::open(&path)?.report().map_err(io::Error::other)?
        );
        // Bounded read rejects an entire hostile file, not just a safe prefix.
        std::fs::write(&path, "secret ".repeat(1000))?;
        assert_eq!(Store::open(&path)?.report().map_err(io::Error::other)?, "");
        std::fs::write(&path, "native-panic 1 2 3\nprivate plaintext\n")?;
        assert_eq!(Store::open(&path)?.report().map_err(io::Error::other)?, "");
        // Failed writes still leave bounded, readable evidence in memory.
        let unwritable = Store(Mutex::new(Inner {
            file: Some(File::open(&path)?),
            records: VecDeque::new(),
        }));
        for _ in 0..100 {
            unwritable.record(1, 2);
        }
        assert_eq!(
            unwritable
                .report()
                .map_err(io::Error::other)?
                .lines()
                .count(),
            CAPACITY
        );
        let memory = Store::memory();
        memory.record(9, 10);
        assert!(memory.attach_file(&path.join("missing-parent")).is_err());
        assert!(memory.report().map_err(io::Error::other)?.contains(" 9 10"));
        memory.attach_file(&path)?;
        assert!(std::fs::read_to_string(&path)?.contains(" 9 10"));
        assert!(Store::open(&std::env::temp_dir()).is_err());
        #[cfg(unix)]
        {
            let link = path.with_extension("symlink");
            std::os::unix::fs::symlink(&path, &link)?;
            assert!(Store::open(&link).is_err());
            std::fs::remove_file(link)?;
        }
        std::fs::remove_file(path)
    }
}
