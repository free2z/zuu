//! Read-only inventory for the fixed pre-identifier-cutover ZUULI sibling.
//!
//! The source database is never passed to SQLite. Its database/WAL/SHM files
//! are copied into a private temporary directory, source identity and content
//! hashes are checked around that copy, and only the private snapshot is
//! queried. Seed custody is metadata-only: this module never opens `.seeds`
//! files and never calls `SeedStore`.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_protocol::consensus::Network;

use crate::app_data_migration::{
    CANONICAL_IDENTIFIER, LEGACY_IDENTIFIER, is_zuuli_identifier, validate_tree,
};
use crate::models::{
    LegacyImportPreview, LegacyImportPreviewState, LegacyWalletLayout, LegacyWalletPreview,
};
use crate::wallet::manifest::{WalletEntry, WalletManifest};

const REDACTED: &str = "[REDACTED]";

pub(crate) fn preview(data_dir: &Path, application_identifier: &str) -> LegacyImportPreview {
    if !is_zuuli_identifier(application_identifier) {
        return result(
            LegacyImportPreviewState::Unsupported,
            None,
            vec![],
            "Legacy preview is available only to ZUULI.",
        );
    }
    #[cfg(target_os = "android")]
    {
        let _ = data_dir;
        return result(
            LegacyImportPreviewState::Unsupported,
            None,
            vec![],
            "Android package sandboxes do not expose the legacy application data.",
        );
    }
    #[cfg(not(target_os = "android"))]
    {
        match preview_desktop(data_dir) {
            Ok(value) => value,
            Err(diagnostic) => result(LegacyImportPreviewState::Blocked, None, vec![], diagnostic),
        }
    }
}

fn result(
    state: LegacyImportPreviewState,
    layout: Option<LegacyWalletLayout>,
    wallets: Vec<LegacyWalletPreview>,
    diagnostic: &str,
) -> LegacyImportPreview {
    LegacyImportPreview {
        state,
        layout,
        wallets,
        diagnostics: vec![diagnostic.to_owned()],
    }
}

#[cfg(not(target_os = "android"))]
fn preview_desktop(data_dir: &Path) -> Result<LegacyImportPreview, &'static str> {
    let parent = data_dir
        .parent()
        .ok_or("The canonical application-data location is unsupported.")?;
    if data_dir.file_name().and_then(|value| value.to_str()) != Some(CANONICAL_IDENTIFIER) {
        return Err("The canonical application-data location is unsupported.");
    }
    let source = parent.join(LEGACY_IDENTIFIER);
    if source.parent() != Some(parent)
        || source.file_name().and_then(|value| value.to_str()) != Some(LEGACY_IDENTIFIER)
    {
        return Err("The legacy application-data location is unsupported.");
    }
    match fs::symlink_metadata(&source) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(result(
                LegacyImportPreviewState::Absent,
                None,
                vec![],
                "No legacy ZUULI application data was found.",
            ));
        }
        Err(_) => return Err("Legacy application data could not be inspected."),
        Ok(_) => {}
    }
    validate_tree(&source).map_err(|_| "Legacy application data is not a safe regular tree.")?;
    let source_metadata = tree_metadata(&source)?;

    let manifest_path = source.join("wallets.json");
    let manifest_present = path_is_file(&manifest_path)?;
    let (layout, entries, manifest_observation) = if manifest_present {
        let before = observe(&manifest_path)?;
        let bytes = read_observed(&manifest_path, &before)?;
        let manifest: WalletManifest =
            serde_json::from_slice(&bytes).map_err(|_| "The legacy wallet manifest is invalid.")?;
        manifest
            .validate()
            .map_err(|_| "The legacy wallet manifest is invalid.")?;
        if manifest.wallets.is_empty() {
            return Err("The legacy wallet manifest contains no wallets.");
        }
        (LegacyWalletLayout::Multi, manifest.wallets, Some(before))
    } else {
        if !path_is_file(&source.join("wallet.sqlite"))? {
            return Err("The legacy wallet layout has no supported database.");
        }
        (
            LegacyWalletLayout::Single,
            vec![WalletEntry {
                id: REDACTED.to_owned(),
                name: REDACTED.to_owned(),
                db_filename: "wallet.sqlite".to_owned(),
                birthday_height: None,
                created_at: String::new(),
                backup_required: false,
            }],
            None,
        )
    };

    validate_database_inventory(&source, &entries)?;
    let custody = inspect_custody(&source, layout, &entries)?;
    let mut wallets = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        wallets.push(inspect_wallet(
            &source,
            entry,
            custody.get(index).copied().unwrap_or(false),
        )?);
    }
    if let Some(before) = manifest_observation {
        verify(&manifest_path, &before)?;
    }
    validate_tree(&source).map_err(|_| "Legacy application data changed during preview.")?;
    if tree_metadata(&source)? != source_metadata {
        return Err("Legacy application data changed during preview.");
    }

    Ok(result(
        LegacyImportPreviewState::Ready,
        Some(layout),
        wallets,
        "Legacy wallet metadata is valid and ready for a future explicit import.",
    ))
}

fn validate_database_inventory(source: &Path, entries: &[WalletEntry]) -> Result<(), &'static str> {
    let expected: std::collections::HashSet<&str> = entries
        .iter()
        .map(|entry| entry.db_filename.as_str())
        .collect();
    for item in
        fs::read_dir(source).map_err(|_| "Legacy application data could not be inspected.")?
    {
        let item = item.map_err(|_| "Legacy application data could not be inspected.")?;
        let Some(name) = item.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name
            .strip_suffix("-journal")
            .is_some_and(|database| database.ends_with(".sqlite"))
        {
            return Err("The legacy wallet layout contains an unsupported SQLite sidecar.");
        }
        for database in &expected {
            if let Some(suffix) = name.strip_prefix(database)
                && suffix.starts_with('-')
                && !matches!(suffix, "-wal" | "-shm")
            {
                return Err("The legacy wallet layout contains an unsupported SQLite sidecar.");
            }
        }
        let database_name = name
            .strip_suffix("-wal")
            .or_else(|| name.strip_suffix("-shm"))
            .unwrap_or(&name);
        if database_name.ends_with(".sqlite") && !expected.contains(database_name) {
            return Err("The legacy wallet layout contains an unlisted database.");
        }
    }
    Ok(())
}

fn path_is_file(path: &Path) -> Result<bool, &'static str> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            reject_links(path, &metadata)?;
            Ok(true)
        }
        Ok(_) => Err("Legacy application data contains an unsafe file."),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("Legacy application data could not be inspected."),
    }
}

fn inspect_custody(
    source: &Path,
    layout: LegacyWalletLayout,
    entries: &[WalletEntry],
) -> Result<Vec<bool>, &'static str> {
    let seeds = source.join(".seeds");
    let metadata = match fs::symlink_metadata(&seeds) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(vec![false; entries.len()]);
        }
        Err(_) => return Err("Encrypted custody metadata could not be inspected."),
        Ok(metadata) => metadata,
    };
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err("Encrypted custody metadata is unsafe.");
    }
    let salt = path_is_file(&seeds.join("salt"))?;
    match layout {
        LegacyWalletLayout::Multi => {
            let mut expected = std::collections::HashSet::new();
            expected.insert("salt".to_owned());
            let mut present = Vec::with_capacity(entries.len());
            for entry in entries {
                if !single_normal_component(&entry.id) {
                    return Err("Encrypted custody metadata has an unsafe wallet identity.");
                }
                let filename = format!("{}.enc", entry.id);
                expected.insert(filename.clone());
                present.push(salt && path_is_file(&seeds.join(filename))?);
            }
            for item in fs::read_dir(&seeds)
                .map_err(|_| "Encrypted custody metadata could not be inspected.")?
            {
                let item =
                    item.map_err(|_| "Encrypted custody metadata could not be inspected.")?;
                let name = item
                    .file_name()
                    .into_string()
                    .map_err(|_| "Encrypted custody metadata has an unsupported layout.")?;
                if !expected.contains(&name) {
                    return Err("Encrypted custody metadata has an unsupported layout.");
                }
            }
            Ok(present)
        }
        LegacyWalletLayout::Single => {
            let mut encrypted = 0usize;
            for item in fs::read_dir(&seeds)
                .map_err(|_| "Encrypted custody metadata could not be inspected.")?
            {
                let item =
                    item.map_err(|_| "Encrypted custody metadata could not be inspected.")?;
                let name = item.file_name();
                if name == "salt" {
                    continue;
                }
                if name.to_str().is_some_and(|name| name.ends_with(".enc")) {
                    if !path_is_file(&item.path())? {
                        return Err("Encrypted custody metadata is unsafe.");
                    }
                    encrypted += 1;
                } else {
                    return Err("Encrypted custody metadata has an unsupported layout.");
                }
            }
            if encrypted > 1 {
                return Err("Encrypted custody metadata has an unsupported layout.");
            }
            Ok(vec![salt && encrypted == 1])
        }
    }
}

fn single_normal_component(value: &str) -> bool {
    matches!(
        Path::new(value).components().collect::<Vec<_>>().as_slice(),
        [std::path::Component::Normal(_)]
    )
}

fn inspect_wallet(
    source: &Path,
    entry: &WalletEntry,
    encrypted_custody_present: bool,
) -> Result<LegacyWalletPreview, &'static str> {
    inspect_wallet_with_hook(source, entry, encrypted_custody_present, || {})
}

fn inspect_wallet_with_hook<F>(
    source: &Path,
    entry: &WalletEntry,
    encrypted_custody_present: bool,
    mut after_copy: F,
) -> Result<LegacyWalletPreview, &'static str>
where
    F: FnMut(),
{
    let db = source.join(&entry.db_filename);
    if !path_is_file(&db)? {
        return Err("A legacy manifest database is missing.");
    }
    let mut files = vec![(db.clone(), entry.db_filename.clone())];
    let mut wal_present = false;
    let mut shm_present = false;
    for (suffix, present) in [("-wal", &mut wal_present), ("-shm", &mut shm_present)] {
        let path = source.join(format!("{}{suffix}", entry.db_filename));
        if path_is_file(&path)? {
            *present = true;
            files.push((path, format!("{}{suffix}", entry.db_filename)));
        }
    }
    let observations: Vec<_> = files
        .iter()
        .map(|(path, _)| observe(path))
        .collect::<Result<_, _>>()?;
    let snapshot =
        Snapshot::new().map_err(|_| "A private legacy preview snapshot could not be created.")?;
    for ((path, name), observation) in files.iter().zip(&observations) {
        snapshot.copy(path, name, observation)?;
    }
    after_copy();
    for ((path, _), observation) in files.iter().zip(&observations) {
        verify(path, observation)?;
    }

    let (account_count, ufvk_fingerprints) =
        inspect_snapshot(&snapshot.path.join(&entry.db_filename))?;
    Ok(LegacyWalletPreview {
        wallet_id: REDACTED.to_owned(),
        wallet_name: REDACTED.to_owned(),
        db_filename: entry.db_filename.clone(),
        account_count,
        ufvk_fingerprints,
        wal_present,
        shm_present,
        encrypted_custody_present,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Observation {
    len: u64,
    modified: Option<std::time::SystemTime>,
    identity: FileIdentity,
    hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileIdentity {
    first: u64,
    second: u64,
}

fn observe(path: &Path) -> Result<Observation, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Legacy data changed during preview.")?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("Legacy data changed during preview.");
    }
    reject_links(path, &metadata)?;
    let mut file = File::open(path).map_err(|_| "Legacy data could not be read for preview.")?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "Legacy data could not be read for preview.")?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(Observation {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        identity: file_identity(path, &metadata)?,
        hash: hasher.finalize().into(),
    })
}

fn read_observed(path: &Path, expected: &Observation) -> Result<Vec<u8>, &'static str> {
    let bytes = fs::read(path).map_err(|_| "Legacy data could not be read for preview.")?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    if bytes.len() as u64 != expected.len || <[u8; 32]>::from(hasher.finalize()) != expected.hash {
        return Err("Legacy data changed during preview.");
    }
    verify(path, expected)?;
    Ok(bytes)
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct TreeMetadata {
    relative_path: PathBuf,
    is_directory: bool,
    len: u64,
    modified: Option<std::time::SystemTime>,
    identity_first: u64,
    identity_second: u64,
}

fn tree_metadata(root: &Path) -> Result<Vec<TreeMetadata>, &'static str> {
    let mut output = Vec::new();
    let mut pending = vec![root.to_owned()];
    while let Some(path) = pending.pop() {
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "Legacy application data changed during preview.")?;
        let identity = file_identity(&path, &metadata)?;
        let relative_path = path
            .strip_prefix(root)
            .map_err(|_| "Legacy application data location is unsupported.")?
            .to_owned();
        let is_directory = metadata.file_type().is_dir();
        output.push(TreeMetadata {
            relative_path,
            is_directory,
            len: metadata.len(),
            modified: metadata.modified().ok(),
            identity_first: identity.first,
            identity_second: identity.second,
        });
        if is_directory {
            for entry in fs::read_dir(&path)
                .map_err(|_| "Legacy application data changed during preview.")?
            {
                pending.push(
                    entry
                        .map_err(|_| "Legacy application data changed during preview.")?
                        .path(),
                );
            }
        }
    }
    output.sort();
    Ok(output)
}

fn verify(path: &Path, expected: &Observation) -> Result<(), &'static str> {
    let actual = observe(path)?;
    if &actual == expected {
        Ok(())
    } else {
        Err("Legacy data changed during preview.")
    }
}

#[cfg(unix)]
fn file_identity(_path: &Path, metadata: &fs::Metadata) -> Result<FileIdentity, &'static str> {
    use std::os::unix::fs::MetadataExt;
    Ok(FileIdentity {
        first: metadata.dev(),
        second: metadata.ino(),
    })
}

#[cfg(windows)]
fn file_identity(path: &Path, metadata: &fs::Metadata) -> Result<FileIdentity, &'static str> {
    let (first, second) =
        crate::app_data_migration::windows_file_identity(path, metadata.file_type().is_dir())
            .map_err(|_| "Legacy data changed during preview.")?;
    Ok(FileIdentity { first, second })
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_path: &Path, _metadata: &fs::Metadata) -> Result<FileIdentity, &'static str> {
    Err("Legacy preview is unsupported on this platform.")
}

#[cfg(unix)]
fn reject_links(_path: &Path, metadata: &fs::Metadata) -> Result<(), &'static str> {
    use std::os::unix::fs::MetadataExt;
    if metadata.nlink() != 1 {
        Err("Legacy application data contains a linked file.")
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn reject_links(path: &Path, _metadata: &fs::Metadata) -> Result<(), &'static str> {
    match crate::app_data_migration::windows_link_count(path) {
        Ok(1) => Ok(()),
        Ok(_) | Err(_) => Err("Legacy application data contains a linked file."),
    }
}

#[cfg(not(any(unix, windows)))]
fn reject_links(_path: &Path, _metadata: &fs::Metadata) -> Result<(), &'static str> {
    Err("Legacy preview is unsupported on this platform.")
}

struct Snapshot {
    path: PathBuf,
}

impl Snapshot {
    fn new() -> std::io::Result<Self> {
        let path =
            std::env::temp_dir().join(format!("zuuli-legacy-preview-{}", uuid::Uuid::new_v4()));
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            builder
        };
        #[cfg(not(unix))]
        let builder = fs::DirBuilder::new();
        builder.create(&path)?;
        Ok(Self { path })
    }

    fn copy(&self, source: &Path, name: &str, expected: &Observation) -> Result<(), &'static str> {
        let destination = self.path.join(name);
        let mut input =
            File::open(source).map_err(|_| "Legacy data could not be copied for preview.")?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options
            .open(&destination)
            .map_err(|_| "A private legacy preview snapshot could not be created.")?;
        std::io::copy(&mut input, &mut output)
            .map_err(|_| "Legacy data could not be copied for preview.")?;
        output
            .flush()
            .map_err(|_| "Legacy data could not be copied for preview.")?;
        let copied = observe(&destination)?;
        if copied.len != expected.len || copied.hash != expected.hash {
            return Err("Legacy data changed during preview.");
        }
        verify(source, expected)
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        if let Ok(entries) = fs::read_dir(&self.path) {
            for entry in entries.flatten() {
                let _ = fs::remove_file(entry.path());
            }
        }
        let _ = fs::remove_dir(&self.path);
    }
}

fn inspect_snapshot(path: &Path) -> Result<(u32, Vec<String>), &'static str> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "A legacy wallet database is invalid.")?;
    connection
        .pragma_update(None, "query_only", true)
        .map_err(|_| "A legacy wallet database is invalid.")?;
    let integrity: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|_| "A legacy wallet database is invalid.")?;
    if integrity != "ok" {
        return Err("A legacy wallet database failed validation.");
    }
    let accounts_tables: u32 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'accounts'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "A legacy wallet has no supported accounts table.")?;
    if accounts_tables != 1 {
        return Err("A legacy wallet has no supported accounts table.");
    }
    let mut columns = connection
        .prepare("PRAGMA table_info(accounts)")
        .map_err(|_| "A legacy wallet has no supported accounts table.")?;
    let names: Vec<String> = columns
        .query_map([], |row| row.get(1))
        .map_err(|_| "A legacy wallet has no supported accounts table.")?
        .collect::<Result<_, _>>()
        .map_err(|_| "A legacy wallet has no supported accounts table.")?;
    if !names.iter().any(|name| name == "ufvk") {
        return Err("A legacy wallet has no supported viewing-key column.");
    }
    let account_column = if names.iter().any(|name| name == "id") {
        "id"
    } else if names.iter().any(|name| name == "account") {
        "account"
    } else {
        return Err("A legacy wallet has no supported account identity column.");
    };
    let mut statement = connection
        .prepare(&format!(
            "SELECT {account_column}, ufvk FROM accounts ORDER BY {account_column}"
        ))
        .map_err(|_| "Legacy wallet accounts could not be validated.")?;
    let values: Vec<(i64, Option<String>)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|_| "Legacy wallet accounts could not be validated.")?
        .collect::<Result<_, _>>()
        .map_err(|_| "Legacy wallet accounts could not be validated.")?;
    if values.is_empty() {
        return Err("A legacy wallet contains no accounts.");
    }
    let mut fingerprints = Vec::with_capacity(values.len());
    let mut account_ids = std::collections::HashSet::new();
    let mut fingerprint_set = std::collections::HashSet::new();
    for (account_id, encoded) in values {
        if account_id < 0 || !account_ids.insert(account_id) {
            return Err("A legacy wallet account identity is invalid.");
        }
        let encoded = encoded.ok_or("A legacy wallet account has no full viewing key.")?;
        UnifiedFullViewingKey::decode(&Network::MainNetwork, &encoded)
            .map_err(|_| "A legacy wallet account has an invalid full viewing key.")?;
        let mut hasher = Sha256::new();
        hasher.update(b"ZUULI legacy UFVK fingerprint v1\0");
        hasher.update(encoded.as_bytes());
        let fingerprint = to_hex(&hasher.finalize());
        if !fingerprint_set.insert(fingerprint.clone()) {
            return Err("A legacy wallet contains duplicate account viewing keys.");
        }
        fingerprints.push(fingerprint);
    }
    let account_count = u32::try_from(fingerprints.len())
        .map_err(|_| "A legacy wallet contains too many accounts.")?;
    Ok((account_count, fingerprints))
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use std::collections::BTreeMap;

    use bip0039::Mnemonic;

    use super::*;

    struct TestTree {
        root: PathBuf,
    }

    impl TestTree {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "zuuli-legacy-preview-test-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir(&root).expect("test root");
            Self { root }
        }

        fn canonical(&self) -> PathBuf {
            self.root.join(CANONICAL_IDENTIFIER)
        }

        fn legacy(&self) -> PathBuf {
            self.root.join(LEGACY_IDENTIFIER)
        }
    }

    impl Drop for TestTree {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).expect("remove isolated test tree");
        }
    }

    fn valid_ufvk(account: u32) -> String {
        let mnemonic: Mnemonic = Mnemonic::from_entropy(vec![7; 32]).expect("test mnemonic");
        let seed = mnemonic.to_seed("");
        crate::wallet::keys::derive_usk(&seed, &Network::MainNetwork, account)
            .expect("derive test key")
            .to_unified_full_viewing_key()
            .encode(&Network::MainNetwork)
    }

    fn create_db(path: &Path, ufvks: &[String]) {
        let connection = Connection::open(path).expect("create test DB");
        connection
            .execute_batch(
                "CREATE TABLE accounts (
                    id INTEGER PRIMARY KEY,
                    name TEXT,
                    ufvk TEXT
                );",
            )
            .expect("accounts schema");
        for (index, ufvk) in ufvks.iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO accounts (id, name, ufvk) VALUES (?1, ?2, ?3)",
                    rusqlite::params![index as u32, format!("secret account {index}"), ufvk],
                )
                .expect("account row");
        }
    }

    fn tree_bytes(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fn visit(base: &Path, path: &Path, output: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in fs::read_dir(path).expect("read test tree") {
                let entry = entry.expect("test entry");
                let path = entry.path();
                if entry.file_type().expect("test type").is_dir() {
                    visit(base, &path, output);
                } else {
                    output.insert(
                        path.strip_prefix(base)
                            .expect("relative test path")
                            .to_owned(),
                        fs::read(path).expect("test bytes"),
                    );
                }
            }
        }
        let mut output = BTreeMap::new();
        visit(root, root, &mut output);
        output
    }

    #[test]
    fn absent_and_wrong_application_are_explicit() {
        let tree = TestTree::new();
        let absent = preview(&tree.canonical(), CANONICAL_IDENTIFIER);
        assert_eq!(absent.state, LegacyImportPreviewState::Absent);
        assert!(absent.wallets.is_empty());

        let unsupported = preview(&tree.canonical(), "cash.free2z.zuuallet");
        assert_eq!(unsupported.state, LegacyImportPreviewState::Unsupported);
        assert!(unsupported.wallets.is_empty());
    }

    #[test]
    fn single_layout_is_redacted_and_zero_mutation() {
        let tree = TestTree::new();
        fs::create_dir(tree.canonical()).expect("canonical");
        fs::create_dir(tree.legacy()).expect("legacy");
        let raw_ufvk = valid_ufvk(0);
        create_db(
            &tree.legacy().join("wallet.sqlite"),
            std::slice::from_ref(&raw_ufvk),
        );
        let seeds = tree.legacy().join(".seeds");
        fs::create_dir(&seeds).expect("seeds");
        fs::write(seeds.join("salt"), b"private salt").expect("salt");
        fs::write(
            seeds.join("unpublished-id.enc"),
            b"private encrypted phrase",
        )
        .expect("seed");
        let before = tree_bytes(&tree.root);

        let preview = preview(&tree.canonical(), CANONICAL_IDENTIFIER);
        let serialized = serde_json::to_string(&preview).expect("serialize preview");
        assert_eq!(preview.state, LegacyImportPreviewState::Ready);
        assert_eq!(preview.layout, Some(LegacyWalletLayout::Single));
        assert_eq!(preview.wallets.len(), 1);
        assert_eq!(preview.wallets[0].wallet_id, REDACTED);
        assert_eq!(preview.wallets[0].wallet_name, REDACTED);
        assert_eq!(preview.wallets[0].db_filename, "wallet.sqlite");
        assert_eq!(preview.wallets[0].account_count, 1);
        assert_eq!(preview.wallets[0].ufvk_fingerprints[0].len(), 64);
        assert!(preview.wallets[0].encrypted_custody_present);
        for secret in [
            raw_ufvk.as_str(),
            "secret account 0",
            "unpublished-id",
            "private encrypted phrase",
            "private salt",
        ] {
            assert!(!serialized.contains(secret), "preview leaked {secret}");
        }
        assert_eq!(
            tree_bytes(&tree.root),
            before,
            "preview mutated source state"
        );
    }

    #[test]
    fn multi_layout_preserves_exact_db_names_but_redacts_manifest_identity() {
        let tree = TestTree::new();
        fs::create_dir(tree.canonical()).expect("canonical");
        fs::create_dir(tree.legacy()).expect("legacy");
        let entries = vec![
            WalletEntry {
                id: "very-secret-wallet-a".into(),
                name: "Alice private wallet".into(),
                db_filename: "wallet_a.sqlite".into(),
                birthday_height: Some(1),
                created_at: "2026-01-01T00:00:00Z".into(),
                backup_required: false,
            },
            WalletEntry {
                id: "very-secret-wallet-b".into(),
                name: "Bob private wallet".into(),
                db_filename: "wallet_b.sqlite".into(),
                birthday_height: Some(2),
                created_at: "2026-01-02T00:00:00Z".into(),
                backup_required: false,
            },
        ];
        let manifest = WalletManifest {
            wallets: entries.clone(),
            active_wallet_id: Some(entries[0].id.clone()),
        };
        fs::write(
            tree.legacy().join("wallets.json"),
            serde_json::to_vec(&manifest).expect("manifest"),
        )
        .expect("write manifest");
        create_db(&tree.legacy().join("wallet_a.sqlite"), &[valid_ufvk(0)]);
        create_db(&tree.legacy().join("wallet_b.sqlite"), &[valid_ufvk(1)]);

        let preview = preview(&tree.canonical(), CANONICAL_IDENTIFIER);
        let serialized = serde_json::to_string(&preview).expect("serialize preview");
        assert_eq!(preview.state, LegacyImportPreviewState::Ready);
        assert_eq!(preview.layout, Some(LegacyWalletLayout::Multi));
        assert_eq!(
            preview
                .wallets
                .iter()
                .map(|wallet| wallet.db_filename.as_str())
                .collect::<Vec<_>>(),
            ["wallet_a.sqlite", "wallet_b.sqlite"]
        );
        for secret in [
            "very-secret-wallet-a",
            "very-secret-wallet-b",
            "Alice private wallet",
            "Bob private wallet",
        ] {
            assert!(!serialized.contains(secret));
        }
    }

    #[test]
    fn corrupt_and_unsupported_inputs_fail_closed() {
        for setup in [
            "corrupt_manifest",
            "unsafe_filename",
            "corrupt_sqlite",
            "missing_accounts",
            "missing_ufvk_column",
            "empty_accounts",
            "null_ufvk",
            "invalid_ufvk",
            "duplicate_ufvk",
            "unlisted_database",
            "rollback_journal",
        ] {
            let tree = TestTree::new();
            fs::create_dir(tree.canonical()).expect("canonical");
            fs::create_dir(tree.legacy()).expect("legacy");
            match setup {
                "corrupt_manifest" => {
                    fs::write(tree.legacy().join("wallets.json"), b"not json").expect("manifest");
                }
                "unsafe_filename" => {
                    let manifest = serde_json::json!({
                        "wallets": [{"id":"x","name":"n","db_filename":"../escape.sqlite","birthday_height":null,"created_at":"now"}],
                        "active_wallet_id":"x"
                    });
                    fs::write(tree.legacy().join("wallets.json"), manifest.to_string())
                        .expect("manifest");
                }
                "missing_accounts" => {
                    Connection::open(tree.legacy().join("wallet.sqlite")).expect("DB");
                }
                "corrupt_sqlite" => {
                    fs::write(tree.legacy().join("wallet.sqlite"), b"not sqlite")
                        .expect("corrupt DB");
                }
                "missing_ufvk_column" => {
                    let connection =
                        Connection::open(tree.legacy().join("wallet.sqlite")).expect("create DB");
                    connection
                        .execute_batch("CREATE TABLE accounts (id INTEGER PRIMARY KEY);")
                        .expect("accounts without UFVK");
                }
                "empty_accounts" => create_db(&tree.legacy().join("wallet.sqlite"), &[]),
                "null_ufvk" => {
                    create_db(&tree.legacy().join("wallet.sqlite"), &[]);
                    let connection =
                        Connection::open(tree.legacy().join("wallet.sqlite")).expect("open DB");
                    connection
                        .execute("INSERT INTO accounts (id, ufvk) VALUES (0, NULL)", [])
                        .expect("NULL UFVK");
                }
                "invalid_ufvk" => create_db(
                    &tree.legacy().join("wallet.sqlite"),
                    &["secret-invalid-ufvk".into()],
                ),
                "duplicate_ufvk" => {
                    let ufvk = valid_ufvk(0);
                    create_db(&tree.legacy().join("wallet.sqlite"), &[ufvk.clone(), ufvk]);
                }
                "unlisted_database" => {
                    create_db(&tree.legacy().join("wallet.sqlite"), &[valid_ufvk(0)]);
                    create_db(&tree.legacy().join("orphan.sqlite"), &[valid_ufvk(1)]);
                }
                "rollback_journal" => {
                    create_db(&tree.legacy().join("wallet.sqlite"), &[valid_ufvk(0)]);
                    fs::write(
                        tree.legacy().join("wallet.sqlite-journal"),
                        b"live rollback journal",
                    )
                    .expect("rollback journal");
                }
                _ => unreachable!(),
            }
            let preview = preview(&tree.canonical(), CANONICAL_IDENTIFIER);
            assert_eq!(preview.state, LegacyImportPreviewState::Blocked, "{setup}");
            assert!(preview.wallets.is_empty(), "{setup}");
            let serialized = serde_json::to_string(&preview).expect("serialize blocked");
            assert!(!serialized.contains("secret-invalid-ufvk"));
            assert!(!serialized.contains("../escape.sqlite"));
        }
    }

    #[test]
    fn source_content_or_identity_change_after_copy_is_rejected() {
        let tree = TestTree::new();
        fs::create_dir(tree.legacy()).expect("legacy");
        let db = tree.legacy().join("wallet.sqlite");
        create_db(&db, &[valid_ufvk(0)]);
        let entry = WalletEntry {
            id: REDACTED.into(),
            name: REDACTED.into(),
            db_filename: "wallet.sqlite".into(),
            birthday_height: None,
            created_at: String::new(),
            backup_required: false,
        };
        let replacement = tree.root.join("replacement.sqlite");
        create_db(&replacement, &[valid_ufvk(1)]);
        let rejected = inspect_wallet_with_hook(&tree.legacy(), &entry, false, || {
            fs::rename(&replacement, &db).expect("replace source after copy");
        });
        assert_eq!(rejected, Err("Legacy data changed during preview."));
    }

    #[test]
    fn wal_snapshot_includes_uncheckpointed_accounts_without_source_mutation() {
        let tree = TestTree::new();
        fs::create_dir(tree.canonical()).expect("canonical");
        fs::create_dir(tree.legacy()).expect("legacy");
        let db = tree.legacy().join("wallet.sqlite");
        let connection = Connection::open(&db).expect("create WAL DB");
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .expect("enable WAL");
        connection
            .pragma_update(None, "wal_autocheckpoint", 0)
            .expect("disable auto checkpoint");
        connection
            .execute_batch("CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT, ufvk TEXT);")
            .expect("accounts schema");
        connection
            .execute(
                "INSERT INTO accounts (id, name, ufvk) VALUES (0, 'private', ?1)",
                [valid_ufvk(0)],
            )
            .expect("uncheckpointed account");
        assert!(db.with_extension("sqlite-wal").exists());
        assert!(db.with_extension("sqlite-shm").exists());
        let before = tree_bytes(&tree.root);

        let preview = preview(&tree.canonical(), CANONICAL_IDENTIFIER);
        assert_eq!(preview.state, LegacyImportPreviewState::Ready);
        assert_eq!(preview.wallets[0].account_count, 1);
        assert!(preview.wallets[0].wal_present);
        assert!(preview.wallets[0].shm_present);
        assert_eq!(tree_bytes(&tree.root), before);
        drop(connection);
    }

    #[test]
    fn in_place_source_content_change_after_copy_is_rejected() {
        let tree = TestTree::new();
        fs::create_dir(tree.legacy()).expect("legacy");
        let db = tree.legacy().join("wallet.sqlite");
        create_db(&db, &[valid_ufvk(0)]);
        let entry = WalletEntry {
            id: REDACTED.into(),
            name: REDACTED.into(),
            db_filename: "wallet.sqlite".into(),
            birthday_height: None,
            created_at: String::new(),
            backup_required: false,
        };
        let rejected = inspect_wallet_with_hook(&tree.legacy(), &entry, false, || {
            fs::write(&db, b"changed in place").expect("mutate source after copy");
        });
        assert_eq!(rejected, Err("Legacy data changed during preview."));
    }

    #[test]
    fn private_snapshot_is_owner_only_and_removed() {
        let path;
        {
            let snapshot = Snapshot::new().expect("private snapshot");
            path = snapshot.path.clone();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(&path)
                        .expect("snapshot metadata")
                        .permissions()
                        .mode()
                        & 0o777,
                    0o700
                );
            }
        }
        assert!(!path.exists(), "snapshot directory must be removed on drop");
    }

    #[cfg(unix)]
    #[test]
    fn custody_presence_does_not_read_custody_files() {
        use std::os::unix::fs::PermissionsExt;

        let tree = TestTree::new();
        fs::create_dir(tree.canonical()).expect("canonical");
        fs::create_dir(tree.legacy()).expect("legacy");
        create_db(&tree.legacy().join("wallet.sqlite"), &[valid_ufvk(0)]);
        let seeds = tree.legacy().join(".seeds");
        fs::create_dir(&seeds).expect("seeds");
        let salt = seeds.join("salt");
        let encrypted = seeds.join("only.enc");
        fs::write(&salt, b"must not be read").expect("salt");
        fs::write(&encrypted, b"must not be read either").expect("encrypted");
        fs::set_permissions(&salt, fs::Permissions::from_mode(0o000)).expect("lock salt");
        fs::set_permissions(&encrypted, fs::Permissions::from_mode(0o000)).expect("lock encrypted");

        let preview = preview(&tree.canonical(), CANONICAL_IDENTIFIER);
        assert_eq!(preview.state, LegacyImportPreviewState::Ready);
        assert!(preview.wallets[0].encrypted_custody_present);

        fs::set_permissions(&salt, fs::Permissions::from_mode(0o600)).expect("unlock salt");
        fs::set_permissions(&encrypted, fs::Permissions::from_mode(0o600))
            .expect("unlock encrypted");
    }

    #[cfg(unix)]
    #[test]
    fn links_are_rejected_without_following_them() {
        use std::os::unix::fs::symlink;

        let tree = TestTree::new();
        fs::create_dir(tree.canonical()).expect("canonical");
        fs::create_dir(tree.legacy()).expect("legacy");
        let outside = tree.root.join("outside.sqlite");
        create_db(&outside, &[valid_ufvk(0)]);
        let before = fs::read(&outside).expect("outside before");
        symlink(&outside, tree.legacy().join("wallet.sqlite")).expect("source symlink");
        let preview = preview(&tree.canonical(), CANONICAL_IDENTIFIER);
        assert_eq!(preview.state, LegacyImportPreviewState::Blocked);
        assert_eq!(fs::read(&outside).expect("outside remains"), before);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn hard_linked_files_fail_the_preview_local_revalidation() {
        let tree = TestTree::new();
        let source = tree.root.join("source");
        let linked = tree.root.join("linked");
        fs::write(&source, b"linked private input").expect("source file");
        fs::hard_link(&source, &linked).expect("hard link");
        let metadata = fs::symlink_metadata(&linked).expect("linked metadata");

        assert_eq!(
            reject_links(&linked, &metadata),
            Err("Legacy application data contains a linked file.")
        );
    }

    #[test]
    fn windows_identity_is_bound_to_the_stable_no_follow_win32_helper() {
        let preview_source = include_str!("legacy_import_preview.rs");
        let migration_source = include_str!("app_data_migration.rs");

        assert!(preview_source.contains(
            "crate::app_data_migration::windows_file_identity(path, metadata.file_type().is_dir())"
        ));
        assert!(migration_source.contains("FILE_FLAG_OPEN_REPARSE_POINT"));
        assert!(migration_source.contains("GetFileInformationByHandle"));
    }
}
