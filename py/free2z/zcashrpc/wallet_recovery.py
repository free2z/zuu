"""Bounded explicit enhancement, serialized with sync by the operational lease.

Retry state is application-owned. Each invocation scans one durable keyset page;
scan exhaustion fails closed while committing its checkpoint for the next run.
No sidecar inventory traversal and no wallet queue writes are performed.
"""
import fcntl
import os
import selectors
import signal
import sqlite3
import stat
import subprocess
import time
from contextlib import closing, contextmanager
from pathlib import Path

from zcashrpc.wallet_hydration import bounded_sql, received_pools

MAX_ATTEMPTS = 3
BATCH = 5
COOLDOWN = 300
SCAN_ROWS = 256
OUTPUT_BYTES = 1024
COMMAND_SECONDS = 20
APPLICATION_ID = 0x5A524331
SCHEMA = (
    'CREATE TABLE recovery (txid BLOB PRIMARY KEY, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL)',
    'CREATE TABLE checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL, network TEXT NOT NULL, wallet_dev INTEGER NOT NULL, wallet_ino INTEGER NOT NULL)',
)


class ScanBudgetExceeded(ValueError):
    """Incomplete recovery traversal must never authorize a success heartbeat."""


def run_recovery_command(args, timeout):
    """Drain both pipes within one shared byte/time cap; kill and reap on error."""
    child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             stdin=subprocess.DEVNULL, start_new_session=True)
    deadline = time.monotonic() + timeout
    output = bytearray()
    total = 0
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            selector.register(child.stderr, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(args[0], timeout)
                for key, _ in selector.select(remaining):
                    chunk = os.read(key.fileobj.fileno(), min(4096, OUTPUT_BYTES - total + 1))
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    total += len(chunk)
                    if total > OUTPUT_BYTES:
                        raise ValueError('recovery output exceeds protocol cap')
                    if key.fileobj is child.stdout:
                        output.extend(chunk)
            code = child.wait(timeout=max(0.001, deadline - time.monotonic()))
            if code:
                raise subprocess.CalledProcessError(code, args[0])
        if bytes(output) not in (b'hydrated\n', b'unavailable\n'):
            raise ValueError('invalid recovery response')
        return bytes(output)
    except BaseException:
        # Includes a descendant retaining a pipe after its parent exited.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=2)
        raise
    finally:
        child.stdout.close()
        child.stderr.close()


def _identity(info):
    return info.st_dev, info.st_ino


def _private_regular(info):
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
        raise ValueError('sidecar requires a private owned regular file with one link')


def _check_wallet_path_ancestors(parent):
    current_path = Path(parent.anchor)
    current = current_path.stat()
    euid = os.geteuid()
    for component in parent.parts[1:]:
        next_path = current_path / component
        following = next_path.stat()
        if not stat.S_ISDIR(following.st_mode):
            raise ValueError('wallet path contains a non-directory component')
        mode = stat.S_IMODE(current.st_mode)
        trusted_owner = current.st_uid in (0, euid)
        writable_by_untrusted = bool(mode & 0o022) or (
            not trusted_owner and bool(mode & 0o200))
        if writable_by_untrusted and not (
                mode & stat.S_ISVTX and trusted_owner
                and following.st_uid in (0, euid)):
            raise ValueError('wallet path contains a directory writable by less-trusted users')
        current_path = next_path
        current = following


def _private_wallet(path):
    """Pin recovery to a wallet that less-trusted OS users cannot write.

    The isolated wallet-library graph still uses upstream rusqlite 0.37. Its
    SQLite WAL advisory is only reachable when a less-trusted user can write
    the wallet and sibling WAL, so the recovery boundary requires a non-
    replaceable owned 0700 directory and owned 0600 single-link database/
    companions.
    """
    supplied = Path(path)
    if supplied.is_symlink():
        raise ValueError('wallet symlink is not allowed')
    wallet = supplied.resolve(strict=True)
    directory = wallet.parent.stat()
    if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.geteuid()
            or stat.S_IMODE(directory.st_mode) != 0o700):
        raise ValueError('wallet directory must be owned and private (0700)')
    _check_wallet_path_ancestors(wallet.parent)
    for candidate in (wallet, *(Path(str(wallet) + suffix) for suffix in ('-wal', '-shm', '-journal'))):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            if candidate == wallet:
                raise
            continue
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            raise ValueError('wallet database and companions must be owned private regular files with one link')
    return wallet


def _check_schema(conn):
    if (conn.execute('PRAGMA application_id').fetchone()[0] != APPLICATION_ID
            or conn.execute('PRAGMA user_version').fetchone()[0] != 1):
        raise ValueError('unrecognized recovery sidecar')
    rows = conn.execute("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 4")
    actual = {row[0] for row in rows}
    if actual != set(SCHEMA):
        raise ValueError('unrecognized recovery schema')


@contextmanager
def _sidecar(state_path, wallet_db, network, deadline):
    """Pin a no-symlink private parent and file before any SQLite write.

    The final directory must be owned and mode 0700. Other OS users cannot
    replace entries between identity checks and SQLite open. Same-UID processes
    are trusted; flock serializes cooperating recovery invocations.
    """
    absolute = Path(os.path.abspath(state_path))
    wallet = _private_wallet(wallet_db)
    forbidden = [Path(str(wallet) + suffix) for suffix in ('', '-wal', '-shm', '-journal')]
    if absolute in forbidden:
        raise ValueError('sidecar aliases wallet or wallet companion')
    forbidden_ids = {_identity(p.stat()) for p in forbidden if p.exists()}
    parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    fd = None
    try:
        for part in absolute.parent.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = next_fd
        directory = os.fstat(parent)
        if directory.st_uid != os.geteuid() or stat.S_IMODE(directory.st_mode) != 0o700:
            raise ValueError('sidecar directory must be private and owned')
        created = False
        try:
            fd = os.open(absolute.name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=parent)
            created = True
        except FileExistsError:
            fd = os.open(absolute.name, os.O_RDWR | os.O_NOFOLLOW, dir_fd=parent)
        info = os.fstat(fd)
        _private_regular(info)
        if _identity(info) in forbidden_ids:
            raise ValueError('sidecar aliases wallet or companion inode')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

        def validate_files():
            current = os.stat(absolute.name, dir_fd=parent, follow_symlinks=False)
            _private_regular(current)
            if _identity(current) != _identity(info):
                raise ValueError('sidecar file replaced')
            for suffix in ('-wal', '-shm', '-journal'):
                try:
                    companion = os.stat(absolute.name + suffix, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                _private_regular(companion)
                if _identity(companion) in forbidden_ids:
                    raise ValueError('sidecar companion aliases wallet')

        validate_files()
        uri = Path(f'/proc/self/fd/{parent}/{absolute.name}').as_uri()
        if not created:
            # Inspect before RW open/hot-journal recovery; unrelated user data
            # is never adopted, initialized, migrated, or overwritten.
            with closing(sqlite3.connect(uri + '?mode=ro&immutable=1', uri=True)) as audit:
                bounded_sql(audit, deadline)
                _check_schema(audit)
                expected = (network, *_identity(wallet.stat()))
                if audit.execute('SELECT network,wallet_dev,wallet_ino FROM checkpoint WHERE id=1').fetchone() != expected:
                    raise ValueError('sidecar wallet binding mismatch')
        validate_files()
        with closing(sqlite3.connect(uri + '?mode=rw', uri=True, timeout=1)) as conn:
            bounded_sql(conn, deadline)
            validate_files()
            if created:
                with conn:
                    conn.execute(f'PRAGMA application_id={APPLICATION_ID}')
                    conn.execute('PRAGMA user_version=1')
                    for sql in SCHEMA:
                        conn.execute(sql)
                    conn.execute('INSERT INTO checkpoint VALUES(1,0,?,?,?)',
                                 (network, *_identity(wallet.stat())))
            _check_schema(conn)
            binding = conn.execute('SELECT network,wallet_dev,wallet_ino FROM checkpoint WHERE id=1').fetchone()
            if binding != (network, *_identity(wallet.stat())):
                raise ValueError('sidecar wallet binding mismatch')
            yield conn, validate_files
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


def recover(wallet_db, *, binary, server, network, state_path, now=None):
    deadline = time.monotonic() + COMMAND_SECONDS
    now = int(time.time()) if now is None else now
    if network not in ('main', 'test'):
        raise ValueError('unsupported wallet network')
    wallet_db = os.fspath(_private_wallet(wallet_db))
    uri = Path(wallet_db).resolve().as_uri() + '?mode=ro'
    with closing(sqlite3.connect(uri, uri=True, timeout=1)) as wallet:
        wallet.execute('PRAGMA query_only=ON')
        bounded_sql(wallet, min(deadline, time.monotonic() + 2))
        pools = received_pools(wallet)
        columns = tuple(wallet.execute('PRAGMA table_info(transactions)'))
        if not any(row[1] == 'id_tx' and row[2].upper() == 'INTEGER' and row[5] == 1 for row in columns):
            raise ValueError('wallet requires integer transaction primary key')
        with _sidecar(state_path, wallet_db, network, deadline) as (state, validate_files):
            cursor = state.execute('SELECT cursor FROM checkpoint WHERE id=1').fetchone()[0]
            if type(cursor) is not int or cursor < 0:
                raise ValueError('invalid recovery checkpoint')
            attempted = 0
            for scanned in range(SCAN_ROWS + 1):
                row = wallet.execute('SELECT id_tx,txid,mined_height FROM transactions '
                                     'WHERE id_tx>? ORDER BY id_tx LIMIT 1', (cursor,)).fetchone()
                if row is None and scanned == 0 and cursor != 0:
                    cursor = 0  # Last invocation may have failed on the tail row.
                    row = wallet.execute('SELECT id_tx,txid,mined_height FROM transactions '
                                         'WHERE id_tx>0 ORDER BY id_tx LIMIT 1').fetchone()
                if row is None:
                    break
                identity, txid, height = row
                if scanned == SCAN_ROWS:
                    state.commit()
                    raise ScanBudgetExceeded('recovery row budget reached; checkpoint retained')
                if time.monotonic() >= deadline:
                    raise TimeoutError('recovery deadline exceeded')
                if not isinstance(txid, bytes) or len(txid) != 32 or type(identity) is not int:
                    raise ValueError('invalid wallet transaction coordinates')
                unknown = False
                for table in sorted(pools):
                    if wallet.execute(f'SELECT 1 FROM {table} n JOIN transactions t ON t.id_tx=n.transaction_id '
                                      'WHERE n.transaction_id=? AND n.value>0 AND t.mined_height>0 AND '
                                      "(t.raw IS NULL OR typeof(t.raw)!='blob' OR length(t.raw)=0 "
                                      "OR n.memo IS NULL OR typeof(n.memo)!='blob') LIMIT 1", (identity,)).fetchone():
                        unknown = True
                validate_files()
                if unknown and attempted < BATCH:
                    if type(height) is not int or height <= 0:
                        raise ValueError('invalid recovery height')
                    retry = state.execute('SELECT attempts,next_at FROM recovery WHERE txid=?', (txid,)).fetchone()
                    attempts, next_at = retry if retry is not None else (0, 0)
                    if type(attempts) is not int or not 0 <= attempts <= MAX_ATTEMPTS or type(next_at) is not int or next_at < 0:
                        raise ValueError('invalid recovery attempt state')
                    eligible = attempts < MAX_ATTEMPTS and next_at <= now
                    if eligible:
                        with state:
                            state.execute('INSERT OR IGNORE INTO recovery VALUES(?,0,0)', (txid,))
                            state.execute('UPDATE recovery SET attempts=attempts+1,next_at=? WHERE txid=?', (now + COOLDOWN, txid))
                else:
                    eligible = False
                # Commit cursor before invocation: death/failure retains both
                # progress and attempt reservation. Later notes remain reachable.
                state.execute('UPDATE checkpoint SET cursor=? WHERE id=1', (identity,))
                cursor = identity
                if eligible or scanned % 16 == 15:
                    state.commit()
                if eligible:
                    attempted += 1
                    run_recovery_command([binary, '--wallet-db', wallet_db, '--server', server,
                                          '--network', network, '--txid', txid[::-1].hex(),
                                          '--height', str(height)], max(0.001, deadline - time.monotonic()))
            if time.monotonic() >= deadline:
                raise TimeoutError('recovery deadline exceeded')
            with state:
                state.execute('UPDATE checkpoint SET cursor=0 WHERE id=1')
            if time.monotonic() >= deadline:
                raise TimeoutError('recovery deadline exceeded')
            return attempted


def recover_configured(wallet_db):
    keys = ('WALLET_RECOVERY_BINARY', 'WALLET_RECOVERY_SERVER', 'WALLET_RECOVERY_NETWORK', 'WALLET_RECOVERY_STATE')
    values = [os.environ.get(key) for key in keys]
    if not any(values):
        return
    if not all(values):
        raise ValueError('incomplete wallet recovery configuration')
    recover(wallet_db, binary=values[0], server=values[1], network=values[2], state_path=values[3])
