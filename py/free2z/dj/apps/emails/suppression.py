"""The current conservative mail policy, pending the owner's decision.

An opt-out applies to every category, including explicitly requested recovery
mail. This module does not grant consent or prove mailbox ownership. Callers
that disclose the result must separately verify ownership of the address.
"""
import hashlib

from django.db import connections

from .models import OptOutEmail


def lock_addresses(addresses, *, using='default'):
    """Serialize supported opt-out writes with provider starts (PostgreSQL).

    Called inside an atomic block, after any Creator and Email row locks.
    Sort keys to make multi-address operations deadlock-free. Hashes are used
    only as advisory lock keys and never logged or stored.
    """
    connection = connections[using]
    if connection.vendor != 'postgresql':
        return
    if not connection.in_atomic_block:
        raise RuntimeError('email suppression lock requires a transaction')
    keys = sorted({
        int.from_bytes(hashlib.sha256(
            b'free2z/mail-suppression/v1\0' + address.encode('utf-8')
        ).digest()[:8], 'big', signed=True)
        for address in addresses
    })
    with connection.cursor() as cursor:
        for key in keys:
            cursor.execute('SELECT pg_advisory_xact_lock(%s)', [key])


def suppressed_addresses():
    """A database subquery; do not materialize the global suppression list."""
    return OptOutEmail.objects.values('email')


def is_suppressed(address):
    return OptOutEmail.objects.filter(email=address).exists()
