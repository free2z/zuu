"""Approved money-host and one-buy-producer boundaries for paymentd hooks."""
import hashlib
import os
import re
import stat
import subprocess
from pathlib import Path

from django.db import connection
from zcashrpc.deployment_paths import deployment_root

from .paymentd_protocol import PaymentEvidenceError, root_namespace

GUARD = Path('/usr/local/sbin/free2z-host-guard')
REPOSITORY = deployment_root(__file__)


def root_bytes(path, limit=65536, mode=None):
    """Read root-managed public configuration; never follow a substituted leaf."""
    root_namespace(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o022:
            raise PaymentEvidenceError('root-managed artifact ownership/mode differs')
        if mode is not None and stat.S_IMODE(info.st_mode) != mode:
            raise PaymentEvidenceError('root-managed artifact mode differs')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            data = source.read(limit + 1)
        if len(data) > limit:
            raise PaymentEvidenceError('root-managed artifact exceeds input bound')
        return data
    finally:
        os.close(fd)


def require_active_producer():
    from zcashrpc.paymentd_mode import buy_producer_mode
    if buy_producer_mode() != 'paymentd':
        raise PaymentEvidenceError('paymentd is not the active buy producer')


def require_runtime(*, writes):
    """A copied disk, SQLite fallback or absent cutover cannot issue credit."""
    if connection.vendor != 'postgresql':
        raise PaymentEvidenceError('paymentd financial backend requires PostgreSQL')
    authority = (REPOSITORY / 'zcash/pipeline/authorised-money-host.env').read_text()
    ids = re.findall(r'^FREE2Z_MONEY_HOST_INSTANCE_ID=([0-9]+)$', authority, re.MULTILINE)
    if len(ids) != 1:
        raise PaymentEvidenceError('authorized money-host declaration is invalid')
    actual_guard = root_bytes(GUARD)
    declared_guard = (REPOSITORY / 'zcash/pipeline/free2z-host-guard.sh').read_bytes()
    if hashlib.sha256(actual_guard).digest() != hashlib.sha256(declared_guard).digest():
        raise PaymentEvidenceError('installed money-host guard differs from this release')
    try:
        subprocess.run([str(GUARD), ids[0]], stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={'PATH':'/usr/bin:/bin'}, cwd='/', timeout=15, check=True)
    except (OSError, subprocess.SubprocessError) as exc:
        raise PaymentEvidenceError('authorized money-host identity is unavailable') from exc
    if writes:
        require_active_producer()
