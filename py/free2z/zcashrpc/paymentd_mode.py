"""Fail-closed, root-managed selection of the one ZEC purchase producer.

Missing state under a trusted root directory retains the legacy default. This
module has no environment override; a malformed marker disables both writers.
"""
from __future__ import annotations

import argparse
import ast
from contextlib import contextmanager
import fcntl
import math
from functools import wraps
import os
from pathlib import Path
import stat
import sys
import time

ACTIVE_PATH = Path('/var/lib/free2z-paymentd/ACTIVE')
PRODUCER_LOCK = ACTIVE_PATH.with_name('PRODUCER_LOCK')
GUARD_VERSION = 'paymentd-producer-guard-v1'
MAINTENANCE_HEARTBEAT = 'credit-loop: maintenance cycle ok - '


class LegacyProducerDisabled(RuntimeError):
    pass


def _root_leaf(path):
    """Open a pinned root leaf, or None for actual trusted absence only."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise LegacyProducerDisabled('producer path is not absolute')
    fd = None
    try:
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        parts = path.parts[1:]
        for index, part in enumerate(parts[:-1]):
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o022:
                raise LegacyProducerDisabled('producer namespace is not root-managed')
            try:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                  dir_fd=fd)
            except FileNotFoundError:
                return None
            os.close(fd)
            fd = next_fd
            if index == len(parts) - 2:
                info = os.fstat(fd)
                if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o755:
                    raise LegacyProducerDisabled('producer directory mode differs')
        try:
            leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                           dir_fd=fd)
        except FileNotFoundError:
            return None
        info = os.fstat(leaf)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0
                or stat.S_IMODE(info.st_mode) != 0o644):
            os.close(leaf)
            raise LegacyProducerDisabled('producer artifact ownership/type/mode differs')
        return leaf
    finally:
        if fd is not None:
            os.close(fd)


def buy_producer_mode(path=None):
    """Return legacy/paymentd/invalid using pinned, non-followed directory FDs."""
    path = ACTIVE_PATH if path is None else Path(path)
    try:
        leaf = _root_leaf(path)
        if leaf is None:
            return 'legacy'
        try:
            return 'paymentd' if os.read(leaf, 33) == b'paymentd\n' else 'invalid'
        finally:
            os.close(leaf)
    except (OSError, ValueError, IndexError, LegacyProducerDisabled):
        return 'invalid'


def _pinned_lock(fd):
    current = _root_leaf(PRODUCER_LOCK)
    if current is None:
        raise LegacyProducerDisabled('producer lock inode changed; refusing writes')
    try:
        info, opened = os.fstat(current), os.fstat(fd)
        if (info.st_dev, info.st_ino) != (opened.st_dev, opened.st_ino):
            raise LegacyProducerDisabled('producer lock inode changed; refusing writes')
    finally:
        os.close(current)


@contextmanager
def producer_lease(expected, *, timeout=15, exclusive=False):
    """Hold the fixed root lock through commit and recheck selection after acquire.

    An absent lock retains pre-cutover legacy compatibility. Paymentd and every
    root transition require the installed lock. Root must install it before the
    guarded bundle and drain all older unleased code before the first transition.
    Root transitions use exclusive=True and mutate the marker inside this scope.
    """
    if (expected not in ('legacy', 'paymentd', 'invalid')
            or (expected == 'invalid' and not exclusive)
            or isinstance(timeout, bool) or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout) or not 0 < timeout <= 300):
        raise LegacyProducerDisabled('invalid producer lease request')
    if exclusive and os.geteuid() != 0:
        raise LegacyProducerDisabled('producer transitions require root')
    fd = None
    entered = False
    try:
        fd = _root_leaf(PRODUCER_LOCK)
        if fd is None:
            if expected != 'legacy' or exclusive:
                raise LegacyProducerDisabled('installed producer lock required')
        else:
            deadline = time.monotonic() + timeout
            lock = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
            while True:
                try:
                    fcntl.flock(fd, lock | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise LegacyProducerDisabled('producer lease deadline exceeded') from None
                    time.sleep(min(0.025, max(0, deadline - time.monotonic())))
            _pinned_lock(fd)
        if buy_producer_mode() != expected:
            raise LegacyProducerDisabled(f'{expected} ZEC purchase producer disabled')
        entered = True
        yield
        if fd is not None:
            _pinned_lock(fd)
    except (OSError, ValueError, IndexError) as exc:
        if entered:
            raise
        raise LegacyProducerDisabled('producer lease unavailable') from exc
    finally:
        if fd is not None:
            # Closing releases the lease even on exceptions or process death.
            os.close(fd)


def legacy_buy_producer(function=None, *, refusal=None):
    """Hold a SH lease across the complete legacy call, including DB commit."""
    if function is None:
        return lambda callback: legacy_buy_producer(callback, refusal=refusal)
    @wraps(function)
    def leased(*args, **kwargs):
        try:
            with producer_lease('legacy'):
                return function(*args, **kwargs)
        except LegacyProducerDisabled as exc:
            if refusal is not None:
                raise refusal(str(exc)) from exc
            raise
    return leased


def require_legacy_producer():
    mode = buy_producer_mode()
    if mode != 'legacy':
        raise LegacyProducerDisabled(f'legacy ZEC purchase producer disabled ({mode})')


def _producer_contract(source):
    """Semantic compatibility of the financial lease, independent of readiness UI.

    Whole-source closure is still verified separately. A changed critical protocol
    requires a reviewed compatibility upgrade, rather than trusting a version label.
    """
    names = {'ACTIVE_PATH', 'PRODUCER_LOCK', 'GUARD_VERSION',
             'LegacyProducerDisabled', '_root_leaf', 'buy_producer_mode',
             '_pinned_lock', 'producer_lease', 'legacy_buy_producer',
             'require_legacy_producer'}
    required_imports = {'fcntl', 'math', 'os', 'stat', 'time', '__future__',
                        'contextlib', 'functools', 'pathlib'}
    tree = ast.parse(source)
    selected, seen, imports = [], set(), []
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            if isinstance(node, ast.Import):
                if any(alias.name in required_imports for alias in node.names):
                    imports.append(ast.dump(node))
            elif node.module in required_imports:
                imports.append(ast.dump(node))
        name = getattr(node, 'name', None)
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            name = getattr(node.targets[0], 'id', None)
        if name not in names:
            continue
        if name in seen:
            return None
        seen.add(name)
        # Documentation changes cannot alter lease or classifier semantics.
        for child in ast.walk(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                if (child.body and isinstance(child.body[0], ast.Expr)
                        and isinstance(child.body[0].value, ast.Constant)
                        and isinstance(child.body[0].value.value, str)):
                    child.body = child.body[1:]
        selected.append(ast.dump(node))
    return (imports, selected) if seen == names else None


def guarded_release(path):
    """Explicit readiness for restarting maintenance under paymentd selection.

    These are reviewed entry guards, not permission supplied by an environment
    flag. An old release without them cannot be restarted or rolled back to.
    """
    path = Path(path)
    files = (
        'py/dj/apps/g12f/management/commands/credit_creators.py',
        'py/dj/apps/tuzis/zec.py', 'py/zcashrpc/creditwatch.py',
        'zcash/pipeline/credit-loop.sh', 'zcash/pipeline/picante-release.sh',
    )
    try:
        contract = _producer_contract(Path(__file__).read_text())
        if contract is None or _producer_contract(
                (path / 'py/zcashrpc/paymentd_mode.py').read_text()) != contract:
            return False
        texts = {name: (path / name).read_text() for name in files}
        if not all(GUARD_VERSION in text for text in texts.values()):
            return False
        zec_tree = ast.parse(texts[files[1]])
        for name in ('credit_zec_purchase', 'credit_zec_purchase_instantly'):
            functions = [node for node in zec_tree.body if isinstance(node, ast.FunctionDef)
                         and node.name == name]
            if len(functions) != 1:
                return False
            if [ast.dump(node) for node in functions[0].decorator_list] != [ast.dump(ast.Name(id='legacy_buy_producer', ctx=ast.Load()))]:
                return False
            body = functions[0].body
            if isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                body = body[1:]
            expected = ast.parse('from zcashrpc.paymentd_mode import require_legacy_producer\nrequire_legacy_producer()').body
            if [ast.dump(node) for node in body[:2]] != [ast.dump(node) for node in expected]:
                return False
        command = ast.parse(texts[files[0]])
        handles = [node for node in ast.walk(command) if isinstance(node, ast.FunctionDef)
                   and node.name == 'handle']
        if len(handles) != 1 or len(handles[0].decorator_list) != 1 or ast.dump(handles[0].decorator_list[0]) != ast.dump(ast.parse('@legacy_buy_producer(refusal=CommandError)\ndef x(): pass').body[0].decorator_list[0]):
            return False
        expected = ast.parse('from zcashrpc.paymentd_mode import LegacyProducerDisabled, require_legacy_producer\ntry:\n    require_legacy_producer()\nexcept LegacyProducerDisabled as exc:\n    raise CommandError(str(exc)) from exc').body
        if len(handles) != 1 or [ast.dump(node) for node in handles[0].body[:2]] != [ast.dump(node) for node in expected]:
            return False
        loop = texts[files[3]]
        return ('legacy) run_django credit_creators "$DJANGO_TIMEOUT" || cc_status=$?' in loop
                and 'paymentd|invalid) echo "credit-loop: legacy BUY disabled ($buy_mode); continuing maintenance" ;;' in loop
                and 'producer_readiness || return 1' in texts[files[4]])
    except (OSError, UnicodeError, SyntaxError, IndexError):
        return False


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--check-release', type=Path)
    parser.add_argument('--legacy-file-deployer', action='store_true')
    args = parser.parse_args(argv)
    mode = buy_producer_mode()
    print(mode)
    if args.legacy_file_deployer:
        # Installing the fixed lock retires the unleased file-by-file deployer.
        # Root drains older invocations before proceeding with the first cutover.
        try:
            lock = _root_leaf(PRODUCER_LOCK)
        except (OSError, ValueError, IndexError, LegacyProducerDisabled):
            return 1
        if lock is not None:
            os.close(lock)
            return 1
        return 0 if mode == 'legacy' else 1
    if args.check_release is not None and mode != 'legacy':
        return 0 if guarded_release(args.check_release) else 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
