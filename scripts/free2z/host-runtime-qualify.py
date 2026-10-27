#!/usr/bin/env python3
"""Execute only inside the non-root, network-disabled qualification container.

The container must contain no source image filesystem, compiler, host Python,
credentials, wallet data, or writable payload. Invoke with the bundled Python
and -I, once for each of two unrelated absolute payload prefixes.
"""
import argparse
import fcntl
import importlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import sysconfig
import tempfile

SYSTEM = {'ld-linux-x86-64.so.2', 'libc.so.6', 'libdl.so.2', 'libm.so.6',
          'libpthread.so.0', 'librt.so.1'}


def run(root):
    root = root.resolve(strict=True)
    python = root / 'runtime/bin/python'
    if os.geteuid() == 0 or not sys.flags.isolated or Path(sys.executable) != python:
        raise ValueError('qualification requires non-root isolated bundled Python')
    if os.environ:
        raise ValueError('qualification must start with an empty environment')
    if Path(sys.prefix) != root / 'runtime' or Path(sys.base_prefix) != root / 'runtime':
        raise ValueError('CPython prefix did not relocate with its runtime')
    for path in sys.path:
        if path and not Path(path).is_relative_to(root / 'runtime'):
            raise ValueError('Python search path escaped the bundle')
    if os.access(python, os.W_OK):
        raise ValueError('payload is writable')
    subprocess.run([str(python), '-I', '-m', 'pip', 'check'], check=True, env={}, timeout=90)
    sys.path.insert(0, str(root / 'py'))
    os.environ.update(DJANGO_SETTINGS_MODULE='dj.free2z.settings',
                      SECRET_KEY='synthetic-qualification-key-no-credentials',
                      SSL_CERT_FILE=str(root / 'runtime/share/ca-certificates.crt'),
                      TIKTOKEN_CACHE_DIR=str(root / 'runtime/share/tiktoken-cache'))
    import django
    django.setup()
    from django.apps import apps
    if not list(apps.get_models()):
        raise ValueError('application registry is empty')
    for name in ('_ssl', '_sqlite3', '_ctypes', '_bz2', '_lzma', '_hashlib',
                 'psycopg', 'psycopg2', 'cryptography.hazmat.bindings._rust',
                 'av', 'grpc', 'PIL.Image', 'zcashrpc.paymentd_mode',
                 'dj.free2z.asgi', 'dj.free2z.wsgi'):
        importlib.import_module(name)
    import ssl
    if not ssl.create_default_context().get_ca_certs():
        raise ValueError('bundled certificate store is empty')
    mapped = set()
    for line in Path('/proc/self/maps').read_text().splitlines():
        fields = line.split(maxsplit=5)
        if len(fields) < 6 or not fields[5].startswith('/'):
            continue
        path = Path(fields[5])
        with path.open('rb') as stream:
            if stream.read(4) != b'\x7fELF':
                continue
        if not path.is_relative_to(root):
            if path.name not in SYSTEM or path.parent.as_posix() not in (
                    '/usr/lib/x86_64-linux-gnu', '/lib/x86_64-linux-gnu', '/lib64'):
                raise ValueError('native dependency escaped bundle: ' + str(path))
        mapped.add(str(path).replace(str(root), '$PAYLOAD', 1))
    subprocess.run([str(root / 'bin/zcash-paymentd'), '--help'], check=True,
                   env={}, timeout=30, stdout=subprocess.DEVNULL)
    with tempfile.TemporaryDirectory(prefix='host-qualification-') as scratch:
        scratch = Path(scratch)
        lock_path = scratch / 'producer.lock'
        with lock_path.open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            descriptor = lock.fileno()
            script = ('import os,signal; os.fstat(' + str(descriptor) + '); '
                      'print(os.geteuid(),flush=True); signal.pause()')
            child = subprocess.Popen([str(python), '-I', '-c', script], pass_fds=(descriptor,),
                                     env={}, stdout=subprocess.PIPE, text=True)
            try:
                # communicate() cannot be used before SIGTERM: the child is
                # intentionally waiting while retaining the inherited flock.
                import selectors
                with selectors.DefaultSelector() as ready:
                    ready.register(child.stdout, selectors.EVENT_READ)
                    if not ready.select(10):
                        raise ValueError('child readiness timed out')
                    if child.stdout.readline().strip() != str(os.geteuid()):
                        raise ValueError('receiving UID changed across exec')
                lock.close()
                with lock_path.open('r') as contender:
                    try:
                        fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        pass
                    else:
                        raise ValueError('producer lock did not survive direct exec')
                    child.send_signal(signal.SIGTERM)
                    if child.wait(timeout=10) != -signal.SIGTERM:
                        raise ValueError('SIGTERM was not delivered to native child')
                    fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=10)
                child.stdout.close()
        wallet_dir = scratch / 'synthetic-wallet'
        wallet_dir.mkdir()
        wallet = wallet_dir / 'wallet.sqlite'
        writer = sqlite3.connect(wallet)
        try:
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('CREATE TABLE synthetic(value TEXT)')
            writer.execute("INSERT INTO synthetic VALUES ('fixture')")
            writer.commit()
            for file in wallet_dir.iterdir():
                file.chmod(0o444)
            wallet_dir.chmod(0o555)
            reader = sqlite3.connect(wallet.as_uri() + '?mode=ro', uri=True)
            try:
                if reader.execute('SELECT value FROM synthetic').fetchone() != ('fixture',):
                    raise ValueError('read-only WAL fixture unreadable')
                try:
                    reader.execute("INSERT INTO synthetic VALUES ('forbidden')")
                except sqlite3.OperationalError:
                    pass
                else:
                    raise ValueError('read-only wallet allowed a write')
            finally:
                reader.close()
        finally:
            wallet_dir.chmod(0o700)
            for file in wallet_dir.iterdir():
                file.chmod(0o600)
            writer.close()
    return dict(python=dict(implementation='cpython', version=sys.version.split()[0],
                            soabi=sysconfig.get_config_var('SOABI')),
                prefix=str(root), native_mappings=sorted(mapped),
                checks=['pip-check', 'django-registry', 'application-imports', 'native-imports',
                        'bundled-ca', 'daemon-help', 'uid', 'inherited-flock', 'sigterm', 'readonly-wallet-wal'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--payload', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    report = run(args.payload)
    with args.report.open('x') as output:
        json.dump(report, output, sort_keys=True)
