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
users sign in again. On Windows, failure to migrate the distinct local-data tree
preserves both copies and continues with a signed-out WebView; it never blocks a
successfully prepared wallet. Wallet recovery never depends on that session.

## Transaction protocol

1. Create a missing platform data parent, then validate the exact
   source/destination sibling names and reject symlinks,
   hard-linked payload files, Windows reparse points, or special files anywhere
   in the source tree.
2. Persist and sync a prepared journal in the common parent directory.
3. Rename the complete legacy directory to the absent canonical path.
4. Sync the parent directory (where the platform exposes directory `fsync`).
5. Validate the resulting tree, remove the journal, and sync again.

The rename is the only identity transition. If both directories exist and the
canonical tree contains any wallet marker, startup fails instead of overwriting
or mixing identities. A canonical tree created by the short-lived pre-migration
build that contains only WebView/session state is atomically preserved as
`.cash.free2z.zuuli-before-legacy-migration`; the complete legacy tree then
takes the canonical path. On restart, a prepared journal plus only a source
resumes the rename; a prepared journal plus only a destination completes
cleanup. A corrupt journal, two wallet identities, neither directory after a
prepared journal, a link, or a special file fails closed without deleting
either identity.

Legacy `.seeds` files are moved byte-for-byte and remain read-only migration
input for the native custody upgrade. This protocol never writes a new legacy
seed backup.

If the moved tree predates `wallets.json` and contains the original
`wallet.sqlite`, startup atomically commits a manifest that refers to that same
basename. It does not rename the database, so `wallet.sqlite`,
`wallet.sqlite-wal`, and `wallet.sqlite-shm` always remain a matched triplet. A
present but invalid manifest or a failed manifest commit aborts startup without
changing any of those files.

The recursive tree scan runs on the migration/recovery path, not on every
steady-state launch. It is an integrity check for app-private state and assumes an
attacker cannot concurrently rewrite that directory between validation and the
atomic rename; an attacker with that authority already has the wallet process's
filesystem access. Windows junctions and other reparse points are rejected by
attribute before traversal, and regular files with multiple hard links are
rejected on every supported desktop platform. Unix trees that cross onto a
different filesystem device are also rejected. A same-filesystem bind mount is
not distinguishable from an ordinary directory through portable file metadata;
creating one requires OS mount authority and is outside this app-private-state
threat boundary.
