"""Policy fence shared by prepared Python writers, independent of services.

Use before any finance lock. NOWAIT also makes a missed outer pin fail with a
retryable database error instead of waiting in the inverse lock order. Reads
and durable observations of already-captured funds do not use this decorator.
"""
from functools import wraps

from django.db import connection, transaction


def is_explicit_policy_refusal(exc):
    """Distinguish an intentional fence from a retryable database failure."""
    cause = getattr(exc, '__cause__', None)
    diagnostic = getattr(cause, 'diag', None)
    return getattr(cause, 'sqlstate', None) == '23514' and getattr(diagnostic, 'message_primary', None) in {
        'economic_writers_fenced', 'economic_policy_requires_ledger_writer_boundary',
        'economic_policy_version_mismatch'}


def pin_supported_policy():
    if not connection.in_atomic_block:
        raise RuntimeError('economic writer pin requires transaction.atomic()')
    with connection.cursor() as cursor:
        cursor.execute('SELECT version FROM economy_economicpolicy WHERE id FOR SHARE NOWAIT')
        row = cursor.fetchone()
        if row is None or row[0] not in (0, 1):
            raise RuntimeError('unsupported economic policy')
        version = row[0]
        cursor.execute("SELECT set_config('free2z.economic_policy_version',%s,true)", [str(version)])
        cursor.execute('SELECT version FROM economy.policy()')
        if cursor.fetchone()[0] != version:
            raise RuntimeError('economic policy changed while pinned')
    return version


def prepared_writer(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with transaction.atomic():
            pin_supported_policy()
            return function(*args, **kwargs)
    return wrapped


def product_integration_available():
    """Cheap installed-ABI proof; deployed writers are checked at activation.

    This is a schema capability, not an external deployment attestation. Public
    active capabilities also require policy1 and the true writer boundary.
    """
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regprocedure('ledger.prepare_economic_policy(integer,integer)') IS NOT NULL "
            "AND to_regprocedure('economy.settle_service_delivery(uuid,text,bigint,jsonb)') IS NOT NULL "
            "AND to_regclass('economy_supplierofferapproval') IS NOT NULL "
            "AND to_regclass('economy_sdkserviceadmission') IS NOT NULL "
            "AND to_regclass('economy_servicedelivery') IS NOT NULL "
            "AND to_regclass('economy_capturedzecnote') IS NOT NULL "
            "AND to_regclass('economy_zecnotedisposition') IS NOT NULL")
        return bool(cursor.fetchone()[0])
