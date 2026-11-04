"""Trusted Django reservation handles; the gateway cannot call these helpers."""
from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID

from django.db import connection

from dj.apps.economy.epoch import prepared_writer

FIRST_PARTY_APP_ID = UUID('00000000-0000-4000-8000-000000000001')


@dataclass(frozen=True)
class HoldReservation:
    pk: UUID
    user_id: int
    amount: Decimal
    scope: str


@prepared_writer
def call(name, *args):
    # Internal, fixed function names only; values always use placeholders.
    if name not in {'hold_internal', 'settle_fixed', 'release'}:
        raise ValueError('unsupported Django hold operation')
    with connection.cursor() as cursor:
        cursor.execute(f'SELECT * FROM ledger.{name}(' + ','.join(['%s'] * len(args)) + ')', args)
        row = cursor.fetchone()
        return dict(zip([column[0] for column in cursor.description], row))
