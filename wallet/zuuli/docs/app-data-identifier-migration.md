# ZUULI application-data identifier migration

ZUULI's canonical identifier is `cash.free2z.zuuli`. Development builds before
the mobile scaffold used the unreleased identifier `com.2zinc.zuuli`.

The Zcash plugin prepares the canonical data directory before it constructs
wallet state, reads `wallets.json`, accesses seed custody, or opens SQLite. On
platforms where Tauri includes the identifier in `app_data_dir`, it moves the
entire legacy directory to the canonical sibling in one atomic rename. This
keeps each manifest, wallet database, `-wal`/`-shm` sidecar, and legacy `.seeds`
input on the same side of the cutover.

## Platform paths and boundaries

| Platform | Tauri application-data layout | Cutover behavior |
| --- | --- | --- |
| macOS | `~/Library/Application Support/<identifier>` | Atomic sibling migration. |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/<identifier>` | Atomic sibling migration. |
| Windows | Wallets: `%APPDATA%\<identifier>`; WebView/session state: `%LOCALAPPDATA%\<identifier>` | Each identifier sibling is migrated atomically before the WebView is created. Wallet identity is never merged with an existing destination. |
| iOS | `$HOME/Library/Application Support/<identifier>` inside the app sandbox | Atomic sibling migration when the legacy directory is reachable in the same sandbox. The canonical wallet directory is excluded from device/iCloud backup before a database opens. |
| Android | The package-private `dataDir` (Tauri does not append the identifier) | No path move is needed inside one package sandbox. Android backup and device transfer remain disabled by the native manifest/rules. |

iOS and Android isolate different bundle/application IDs in different private
sandboxes. A new app installed as `cash.free2z.zuuli` cannot enumerate or read a
separately installed `com.2zinc.zuuli` app's data. The old identifier was never
released, so there is no App Store or Play Store upgrade population to bridge.
Development users whose old and new apps are separate installs must restore
from their recovery phrase; code in the canonical app must never weaken mobile
sandboxing to scrape the old install. A future shipped bridge would require an
explicit export from an updated legacy-ID app, not a filesystem guess in the
new app.

The Free2Z Knox token is held in WebView `localStorage`, not the wallet
manifest. Linux/Windows WebView data lives under Tauri's identifier-scoped local
data tree and moves with that complete tree when reachable. It is intentionally
not treated as wallet identity or copied across isolated mobile apps; mobile
users sign in again. Wallet recovery never depends on that session.

## Transaction protocol

1. Validate the exact source/destination sibling names and reject symlinks or
   special files anywhere in the source tree.
2. Persist and sync a prepared journal in the common parent directory.
3. Rename the complete legacy directory to the absent canonical path.
4. Sync the parent directory (where the platform exposes directory `fsync`).
5. Validate the resulting tree, remove the journal, and sync again.

The rename is the only identity transition. If both directories exist—even if
the destination appears empty—startup fails instead of overwriting or mixing
them. On restart, a prepared journal plus only a source resumes the rename; a
prepared journal plus only a destination completes cleanup. A corrupt journal,
both directories, neither directory, a link, or a special file fails closed
without deleting either identity.

Legacy `.seeds` files are moved byte-for-byte and remain read-only migration
input for the native custody upgrade. This protocol never writes a new legacy
seed backup.
