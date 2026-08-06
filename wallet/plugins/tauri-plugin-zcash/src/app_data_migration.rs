//! One-way migration for ZUULI's pre-release application identifier cutover.
//!
//! Tauri's desktop and iOS application-data path includes the configured
//! identifier.  Moving `com.2zinc.zuuli` to `cash.free2z.zuuli` therefore has
//! to happen before [`crate::wallet::WalletState`] reads a manifest or opens a
//! SQLite database.  The two directories are siblings, so one directory rename
//! moves the manifest, databases, matching WAL/SHM files, and legacy `.seeds`
//! custody input as a single filesystem operation.
//!
//! Android is different: Tauri resolves `app_data_dir` directly to the current
//! package's private `dataDir`.  There is no identifier-named child to move and
//! Android does not let one application ID read another application's private
//! sandbox.  An in-place package update therefore needs no path migration; a
//! separately installed legacy package cannot be imported by filesystem code.

use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

const LEGACY_IDENTIFIER: &str = "com.2zinc.zuuli";
const CANONICAL_IDENTIFIER: &str = "cash.free2z.zuuli";
const JOURNAL_FILENAME: &str = ".zuuli-migration-com.2zinc.zuuli-to-cash.free2z.zuuli.json";
const JOURNAL_TEMP_PREFIX: &str = ".zuuli-migration-prepared-";
const PROTOCOL_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MigrationOutcome {
    NotZuuli,
    #[cfg(target_os = "android")]
    MobileSandboxScoped,
    Created,
    AlreadyCanonical,
    Migrated,
    Recovered,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum MigrationError {
    #[error("legacy app-data migration I/O failed: {0}")]
    Io(#[from] std::io::Error),

    #[error("legacy app-data migration state is invalid: {0}")]
    InvalidState(String),

    #[error(
        "legacy and canonical ZUULI app-data directories both exist; refusing to overwrite or mix wallet identities"
    )]
    Conflict,
}

pub(crate) fn is_zuuli_identifier(application_identifier: &str) -> bool {
    application_identifier == CANONICAL_IDENTIFIER
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct MigrationJournal {
    protocol_version: u8,
    from_identifier: String,
    to_identifier: String,
}

impl MigrationJournal {
    fn expected() -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            from_identifier: LEGACY_IDENTIFIER.to_owned(),
            to_identifier: CANONICAL_IDENTIFIER.to_owned(),
        }
    }
}

/// Prepare the plugin's data directory before wallet state is initialized.
///
/// Other consumers of this shared plugin (notably Zuuallet) are intentionally
/// untouched.  ZUULI desktop and iOS layouts use sibling identifier paths;
/// Android's package-private root is already the only reachable data directory.
pub(crate) fn prepare(
    data_dir: &Path,
    application_identifier: &str,
) -> Result<MigrationOutcome, MigrationError> {
    if !is_zuuli_identifier(application_identifier) {
        fs::create_dir_all(data_dir)?;
        return Ok(MigrationOutcome::NotZuuli);
    }

    #[cfg(target_os = "android")]
    {
        fs::create_dir_all(data_dir)?;
        return Ok(MigrationOutcome::MobileSandboxScoped);
    }

    #[cfg(not(target_os = "android"))]
    {
        let parent = data_dir.parent().ok_or_else(|| {
            MigrationError::InvalidState(
                "canonical app-data directory has no parent directory".to_owned(),
            )
        })?;
        let name = data_dir.file_name().and_then(|name| name.to_str());
        if name != Some(CANONICAL_IDENTIFIER) {
            return Err(MigrationError::InvalidState(format!(
                "Tauri resolved an unexpected canonical directory name: {name:?}"
            )));
        }

        let source = parent.join(LEGACY_IDENTIFIER);
        migrate_paths(&source, data_dir, parent, &mut |_| Ok(()))
    }
}

fn migrate_paths<F>(
    source: &Path,
    destination: &Path,
    parent: &Path,
    hook: &mut F,
) -> Result<MigrationOutcome, MigrationError>
where
    F: FnMut(MigrationStep) -> Result<(), MigrationError>,
{
    ensure_sibling(parent, source, LEGACY_IDENTIFIER)?;
    ensure_sibling(parent, destination, CANONICAL_IDENTIFIER)?;

    let journal_path = parent.join(JOURNAL_FILENAME);
    let had_journal = path_exists_no_follow(&journal_path)?;

    if had_journal {
        read_and_validate_journal(&journal_path)?;
    }

    let source_exists = path_exists_no_follow(source)?;
    let destination_exists = path_exists_no_follow(destination)?;

    match (source_exists, destination_exists) {
        (true, true) => return Err(MigrationError::Conflict),
        (false, false) if had_journal => {
            return Err(MigrationError::InvalidState(
                "prepared migration lost both source and destination".to_owned(),
            ));
        }
        (false, true) if had_journal => {
            validate_tree(destination)?;
            finish_journal(&journal_path, parent)?;
            hook(MigrationStep::JournalRemoved)?;
            return Ok(MigrationOutcome::Recovered);
        }
        (false, true) => {
            validate_tree(destination)?;
            return Ok(MigrationOutcome::AlreadyCanonical);
        }
        (false, false) => {
            fs::create_dir(destination)?;
            sync_directory(parent)?;
            return Ok(MigrationOutcome::Created);
        }
        (true, false) => {}
    }

    validate_tree(source)?;

    if !had_journal {
        install_journal(parent, &journal_path)?;
        hook(MigrationStep::JournalPrepared)?;
    }

    match rename_no_replace(source, destination) {
        Ok(()) => {}
        Err(error) => {
            // Another process may have completed the same atomic rename after
            // our initial observation.  Accept only the unambiguous final
            // state; every other failure preserves the source and journal.
            let source_remains = path_exists_no_follow(source)?;
            let destination_now_exists = path_exists_no_follow(destination)?;
            if source_remains && destination_now_exists {
                return Err(MigrationError::Conflict);
            }
            if source_remains || !destination_now_exists {
                return Err(error.into());
            }
        }
    }
    sync_directory(parent)?;
    hook(MigrationStep::DirectoryRenamed)?;

    if path_exists_no_follow(source)? || !path_exists_no_follow(destination)? {
        return Err(MigrationError::InvalidState(
            "directory rename did not produce the expected final state".to_owned(),
        ));
    }
    validate_tree(destination)?;

    finish_journal(&journal_path, parent)?;
    hook(MigrationStep::JournalRemoved)?;
    Ok(if had_journal {
        MigrationOutcome::Recovered
    } else {
        MigrationOutcome::Migrated
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MigrationStep {
    JournalPrepared,
    DirectoryRenamed,
    JournalRemoved,
}

fn ensure_sibling(parent: &Path, path: &Path, expected_name: &str) -> Result<(), MigrationError> {
    if path.parent() != Some(parent)
        || path.file_name().and_then(|name| name.to_str()) != Some(expected_name)
    {
        return Err(MigrationError::InvalidState(format!(
            "migration path is not the expected {expected_name} sibling"
        )));
    }
    Ok(())
}

fn path_exists_no_follow(path: &Path) -> Result<bool, MigrationError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn rename_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: Both C strings live for the call and point to valid NUL-terminated
    // path bytes. RENAME_NOREPLACE makes destination nonexistence part of the
    // atomic filesystem operation instead of a racy pre-check.
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn rename_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: Both C strings live for the call. RENAME_EXCL is Apple's atomic
    // no-clobber directory rename and is available on macOS and iOS.
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};

    let mut source: Vec<u16> = source.as_os_str().encode_wide().collect();
    source.push(0);
    let mut destination: Vec<u16> = destination.as_os_str().encode_wide().collect();
    destination.push(0);

    // SAFETY: Both UTF-16 buffers are NUL-terminated and live for the call.
    // Omitting MOVEFILE_REPLACE_EXISTING gives the same no-clobber contract as
    // the Unix variants; WRITE_THROUGH asks Windows not to return early from
    // any filesystem work needed to complete the move.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if result != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn install_journal(parent: &Path, journal_path: &Path) -> Result<(), MigrationError> {
    let bytes = serde_json::to_vec_pretty(&MigrationJournal::expected())
        .map_err(|error| MigrationError::InvalidState(error.to_string()))?;
    let temp_path = parent.join(format!("{JOURNAL_TEMP_PREFIX}{}.tmp", uuid::Uuid::new_v4()));

    let result = (|| {
        let mut temp = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        temp.write_all(&bytes)?;
        temp.sync_all()?;

        // A hard link gives this process an atomic create-if-absent operation
        // on Unix and Windows without ever exposing a partially written stable
        // journal.  If a peer won the race, its complete journal is validated.
        match fs::hard_link(&temp_path, journal_path) {
            Ok(()) => sync_directory(parent)?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                read_and_validate_journal(journal_path)?;
            }
            Err(error) => return Err(MigrationError::Io(error)),
        }
        Ok(())
    })();

    let _ = fs::remove_file(&temp_path);
    result
}

fn read_and_validate_journal(path: &Path) -> Result<(), MigrationError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(MigrationError::InvalidState(
            "migration journal is not a regular file".to_owned(),
        ));
    }
    let bytes = fs::read(path)?;
    let journal: MigrationJournal = serde_json::from_slice(&bytes).map_err(|error| {
        MigrationError::InvalidState(format!("migration journal is corrupt: {error}"))
    })?;
    if journal != MigrationJournal::expected() {
        return Err(MigrationError::InvalidState(
            "migration journal describes a different protocol or identity cutover".to_owned(),
        ));
    }
    Ok(())
}

fn finish_journal(path: &Path, parent: &Path) -> Result<(), MigrationError> {
    match fs::remove_file(path) {
        Ok(()) => sync_directory(parent)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

/// Reject links and special files before the directory is accepted as wallet
/// state.  A directory rename does not traverse links, but accepting one would
/// allow later manifest/database opens to escape the application sandbox.
fn validate_tree(root: &Path) -> Result<(), MigrationError> {
    let metadata = fs::symlink_metadata(root)?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(MigrationError::InvalidState(
            "app-data root is not a regular directory".to_owned(),
        ));
    }

    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            let file_type = metadata.file_type();
            if file_type.is_symlink() {
                return Err(MigrationError::InvalidState(
                    "app-data contains a symbolic link".to_owned(),
                ));
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if !file_type.is_file() {
                return Err(MigrationError::InvalidState(
                    "app-data contains a non-file filesystem object".to_owned(),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), MigrationError> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), MigrationError> {
    // Windows does not expose portable directory fsync through std.  The
    // journal file itself is synced before its link is installed, and both
    // directory renames remain atomic filesystem operations.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        destination: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "zuuli-app-data-migration-{label}-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&root).expect("create fixture root");
            Self {
                source: root.join(LEGACY_IDENTIFIER),
                destination: root.join(CANONICAL_IDENTIFIER),
                root,
            }
        }

        fn migrate<F>(&self, hook: &mut F) -> Result<MigrationOutcome, MigrationError>
        where
            F: FnMut(MigrationStep) -> Result<(), MigrationError>,
        {
            migrate_paths(&self.source, &self.destination, &self.root, hook)
        }

        fn write_wallet_payload(&self) {
            fs::create_dir_all(self.source.join(".seeds")).expect("create seed directory");
            fs::write(self.source.join("wallets.json"), b"manifest").expect("write manifest");
            fs::write(self.source.join("wallet_alpha.sqlite"), b"database")
                .expect("write database");
            fs::write(self.source.join("wallet_alpha.sqlite-wal"), b"wal").expect("write WAL");
            fs::write(self.source.join("wallet_alpha.sqlite-shm"), b"shm").expect("write SHM");
            fs::write(self.source.join(".seeds/salt"), b"legacy salt")
                .expect("write legacy seed salt");
            fs::write(self.source.join(".seeds/alpha.enc"), b"legacy ciphertext")
                .expect("write legacy seed ciphertext");
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn atomically_moves_manifest_database_sidecars_and_legacy_seed_input() {
        let fixture = Fixture::new("complete");
        fixture.write_wallet_payload();

        let outcome = fixture.migrate(&mut |_| Ok(())).expect("migrate");

        assert_eq!(outcome, MigrationOutcome::Migrated);
        assert!(!fixture.source.exists());
        for (relative, expected) in [
            ("wallets.json", b"manifest".as_slice()),
            ("wallet_alpha.sqlite", b"database".as_slice()),
            ("wallet_alpha.sqlite-wal", b"wal".as_slice()),
            ("wallet_alpha.sqlite-shm", b"shm".as_slice()),
            (".seeds/salt", b"legacy salt".as_slice()),
            (".seeds/alpha.enc", b"legacy ciphertext".as_slice()),
        ] {
            assert_eq!(
                fs::read(fixture.destination.join(relative)).expect("read migrated file"),
                expected
            );
        }
        assert!(!fixture.root.join(JOURNAL_FILENAME).exists());
    }

    #[test]
    fn populated_destination_conflict_preserves_both_identities_byte_for_byte() {
        let fixture = Fixture::new("conflict");
        fixture.write_wallet_payload();
        fs::create_dir(&fixture.destination).expect("create destination");
        fs::write(
            fixture.destination.join("wallets.json"),
            b"canonical manifest",
        )
        .expect("write canonical manifest");

        let error = fixture
            .migrate(&mut |_| Ok(()))
            .expect_err("reject conflict");

        assert!(matches!(error, MigrationError::Conflict));
        assert_eq!(
            fs::read(fixture.source.join("wallets.json")).expect("read source"),
            b"manifest"
        );
        assert_eq!(
            fs::read(fixture.destination.join("wallets.json")).expect("read destination"),
            b"canonical manifest"
        );
    }

    #[test]
    fn even_empty_destination_is_a_conflict_instead_of_an_overwrite_window() {
        let fixture = Fixture::new("empty-conflict");
        fixture.write_wallet_payload();
        fs::create_dir(&fixture.destination).expect("create empty destination");

        assert!(matches!(
            fixture.migrate(&mut |_| Ok(())),
            Err(MigrationError::Conflict)
        ));
        assert!(fixture.source.exists());
        assert!(fixture.destination.exists());
    }

    #[test]
    fn destination_created_after_preflight_is_never_replaced() {
        let fixture = Fixture::new("destination-race");
        fixture.write_wallet_payload();
        let destination = fixture.destination.clone();
        let mut create_racing_destination = move |step| {
            if step == MigrationStep::JournalPrepared {
                fs::create_dir(&destination).expect("create racing destination");
            }
            Ok(())
        };

        let error = fixture
            .migrate(&mut create_racing_destination)
            .expect_err("reject racing destination");

        assert!(matches!(error, MigrationError::Conflict));
        assert_eq!(
            fs::read(fixture.source.join("wallets.json")).expect("read legacy source"),
            b"manifest"
        );
        assert_eq!(
            fs::read_dir(&fixture.destination)
                .expect("read untouched destination")
                .count(),
            0
        );
        assert!(fixture.root.join(JOURNAL_FILENAME).exists());
    }

    #[test]
    fn interruption_after_prepared_journal_resumes_without_copying() {
        let fixture = Fixture::new("prepared");
        fixture.write_wallet_payload();
        let mut fail_once = |step| {
            if step == MigrationStep::JournalPrepared {
                Err(MigrationError::InvalidState("injected stop".to_owned()))
            } else {
                Ok(())
            }
        };

        assert!(fixture.migrate(&mut fail_once).is_err());
        assert!(fixture.source.exists());
        assert!(!fixture.destination.exists());
        assert!(fixture.root.join(JOURNAL_FILENAME).exists());

        let outcome = fixture.migrate(&mut |_| Ok(())).expect("resume");
        assert_eq!(outcome, MigrationOutcome::Recovered);
        assert!(!fixture.source.exists());
        assert_eq!(
            fs::read(fixture.destination.join("wallet_alpha.sqlite-wal"))
                .expect("read migrated WAL"),
            b"wal"
        );
        assert!(!fixture.root.join(JOURNAL_FILENAME).exists());
    }

    #[test]
    fn interruption_after_atomic_rename_is_completed_on_restart() {
        let fixture = Fixture::new("renamed");
        fixture.write_wallet_payload();
        let mut fail_once = |step| {
            if step == MigrationStep::DirectoryRenamed {
                Err(MigrationError::InvalidState("injected stop".to_owned()))
            } else {
                Ok(())
            }
        };

        assert!(fixture.migrate(&mut fail_once).is_err());
        assert!(!fixture.source.exists());
        assert!(fixture.destination.exists());
        assert!(fixture.root.join(JOURNAL_FILENAME).exists());

        let outcome = fixture
            .migrate(&mut |_| Ok(()))
            .expect("recover completion");
        assert_eq!(outcome, MigrationOutcome::Recovered);
        assert_eq!(
            fs::read(fixture.destination.join(".seeds/alpha.enc")).expect("read seed input"),
            b"legacy ciphertext"
        );
        assert!(!fixture.root.join(JOURNAL_FILENAME).exists());
    }

    #[test]
    fn corrupt_journal_fails_closed_and_preserves_source() {
        let fixture = Fixture::new("corrupt-journal");
        fixture.write_wallet_payload();
        fs::write(fixture.root.join(JOURNAL_FILENAME), b"not json").expect("write corrupt journal");

        let error = fixture
            .migrate(&mut |_| Ok(()))
            .expect_err("reject journal");
        assert!(matches!(error, MigrationError::InvalidState(_)));
        assert!(fixture.source.exists());
        assert!(!fixture.destination.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_in_source_fails_closed_without_moving_anything() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new("symlink");
        fixture.write_wallet_payload();
        symlink("wallet_alpha.sqlite", fixture.source.join("linked.sqlite"))
            .expect("create symlink");

        let error = fixture.migrate(&mut |_| Ok(())).expect_err("reject link");
        assert!(matches!(error, MigrationError::InvalidState(_)));
        assert!(fixture.source.exists());
        assert!(!fixture.destination.exists());
        assert!(!fixture.root.join(JOURNAL_FILENAME).exists());
    }

    #[cfg(unix)]
    #[test]
    fn broken_source_symlink_is_not_mistaken_for_an_absent_legacy_directory() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new("broken-root-link");
        symlink("missing-legacy-target", &fixture.source).expect("create broken root symlink");

        let error = fixture
            .migrate(&mut |_| Ok(()))
            .expect_err("reject broken root link");
        assert!(matches!(error, MigrationError::InvalidState(_)));
        assert!(fs::symlink_metadata(&fixture.source).is_ok());
        assert!(!fixture.destination.exists());
    }

    #[test]
    fn absent_legacy_data_creates_canonical_directory_idempotently() {
        let fixture = Fixture::new("new-install");

        assert_eq!(
            fixture.migrate(&mut |_| Ok(())).expect("create"),
            MigrationOutcome::Created
        );
        assert_eq!(
            fixture.migrate(&mut |_| Ok(())).expect("repeat"),
            MigrationOutcome::AlreadyCanonical
        );
    }

    #[test]
    fn wrong_path_identity_is_rejected_before_filesystem_changes() {
        let fixture = Fixture::new("wrong-identity");
        let wrong = fixture.root.join("cash.free2z.someone-else");

        let error = migrate_paths(&fixture.source, &wrong, &fixture.root, &mut |_| Ok(()))
            .expect_err("reject wrong identity");

        assert!(matches!(error, MigrationError::InvalidState(_)));
        assert!(!wrong.exists());
    }
}
