"""SEAM: the ledger's projection of the app registry and of the grant.

docs/tuzis/ledger-v2.md §3.6 and §3.7 define ``ledger_app`` (the registry
as the hold functions read it: developer, frozen, registered and approved
markup) and ``ledger_spend_cap`` (the grant as the hold reads it: the cap,
the period, the CONSENTED markup, the generation, the revocation). Both are
migration **L2**, which has not merged at the time of I3; the hold
functions must never join ``oidc_*`` tables, so the registry pushes into
them.

The L2 schema represents day/week/month and total caps. Every existing grant
must be projected before gateway activation, including uncapped grants (a NULL
cap inside a real row). Missing third-party projections fail closed at hold
admission. The synchronization command backfills pre-L2 registrations/grants;
normal consent, revocation and registration writes keep them current, and a
grant write also inserts its app's ``ledger_app`` row when it is missing
(``sync_grant``).

A cap frame revision changes when its period changes or the cap is enabled
/ disabled. Numerical limit edits keep the frame. Existing holds retain their
original calendar window across natural rollover, but additional exposure
after a frame replacement must fit the replacement window.

The account id the projection keys on is ``ledger.ensure_account`` (L1),
which exists today.
"""
from __future__ import annotations

import logging
from types import SimpleNamespace

from django.db import connection, transaction

logger = logging.getLogger(__name__)

LEDGER_APP_TABLE = "ledger_app"
LEDGER_SPEND_CAP_TABLE = "ledger_spend_cap"

SKIPPED_NO_TABLE = "skipped_no_table"
WRITTEN = "written"

#The ledger's rails for a third-party app in v1 (ledger-v2 §3.6): card and
#Zcash; the IAP rails only in Free2Z's own apps.
THIRD_PARTY_RAILS = ("stripe", "zec")
FIRST_PARTY_RAILS = ("stripe", "zec", "iap_apple", "iap_google")


def _table_exists(name: str) -> bool:
    with connection.cursor() as cursor:
        return name in set(connection.introspection.table_names(cursor))


_APP_INSERT = f"""
    INSERT INTO {LEDGER_APP_TABLE}
        (id, developer_creator_id, frozen, markup_bps, approved_markup_bps, rails, updated_at)
    VALUES (%s, %s, %s, %s, %s, %s, now())
"""


def _app_params(application, *, frozen=None) -> list:
    rails = FIRST_PARTY_RAILS if application.first_party else THIRD_PARTY_RAILS
    return [
        str(application.pk),
        application.user_id,
        application.frozen if frozen is None else frozen,
        application.markup_bps,
        application.approved_markup_bps,
        list(rails),
    ]


def sync_application(application) -> str:
    """Upsert the app into ``ledger_app`` (§3.6), if the table exists."""
    if not _table_exists(LEDGER_APP_TABLE):
        logger.info("oidc: ledger_app not present; registry projection skipped (L2 pending)")
        return SKIPPED_NO_TABLE
    with connection.cursor() as cursor:
        cursor.execute(
            _APP_INSERT
            + """
            ON CONFLICT (id) DO UPDATE SET
                developer_creator_id = EXCLUDED.developer_creator_id,
                frozen = EXCLUDED.frozen,
                markup_bps = EXCLUDED.markup_bps,
                approved_markup_bps = EXCLUDED.approved_markup_bps,
                rails = EXCLUDED.rails,
                updated_at = now()
            """,
            _app_params(application),
        )
    return WRITTEN


def _ensure_application(application) -> bool:
    """Insert the app's ``ledger_app`` row if -- and only if -- it is missing.

    Returns ``True`` when this call created the row. Never overwrites: see
    :func:`sync_grant` for why the grant path must not upsert the registry.
    """
    from .models import F2ZApplication

    with connection.cursor() as cursor:
        # A plain MVCC read first: the common case (row present) takes no
        # lock and writes nothing, so it can never wait on, or deadlock
        # with, a concurrent registry write or the delete tombstone.
        cursor.execute(f"SELECT 1 FROM {LEDGER_APP_TABLE} WHERE id = %s", [str(application.pk)])
        if cursor.fetchone() is not None:
            return False
        # Missing: take the registry's lock order -- the app row, THEN
        # ledger_app -- as developer._save and sync_oidc_ledger do (both
        # FOR UPDATE the app). KEY SHARE is the lock a new grant's deferred
        # foreign key takes at COMMIT anyway; taking it here, before the
        # insert, waits out a registry writer instead of deadlocking with it
        # at commit. The values come from the locked row, not the instance.
        cursor.execute(
            f"SELECT user_id, frozen, markup_bps, approved_markup_bps, first_party "
            f"FROM {F2ZApplication._meta.db_table} WHERE id = %s FOR KEY SHARE",
            [application.pk],
        )
        row = cursor.fetchone()
        if row is None:
            return False  # deleted under us: no projection, fail closed
        current = SimpleNamespace(
            pk=application.pk, user_id=row[0], frozen=row[1], markup_bps=row[2],
            approved_markup_bps=row[3], first_party=row[4],
        )
        cursor.execute(_APP_INSERT + " ON CONFLICT (id) DO NOTHING", _app_params(current))
        created = cursor.rowcount == 1
    if created:
        logger.warning(
            "oidc: ledger_app row was missing for app=%s; projected from its grant (self-heal)",
            application.pk,
        )
    return created


@transaction.atomic
def sync_grant(authorization) -> str:
    """Upsert the grant into ``ledger_spend_cap`` (§3.7), if the table exists,
    and make sure its app has a ``ledger_app`` row (§3.6).

    Why the app too: a ``ledger_spend_cap`` row without its ``ledger_app``
    row is useless -- ``ledger.gateway_identity()`` JOINs ``ledger_app``, so
    every paid call fails closed as ``token_revoked``, and
    ``/api/sdk/v1/grant`` reads ``ledger_cap_pending`` for ever. The app row
    is otherwise written only at registration and on an admin save, so an app
    registered before L2 (or whose registration-time projection was lost)
    has none until someone runs ``sync_oidc_ledger --apply``. That is the
    2026-10-05 ¡AHA! incident: the app was registered the day before L2
    landed and the backfill was never run in prod. A consent is the natural
    self-heal point -- it is the moment the app first needs the row.

    Insert-if-missing, never an upsert: the registry write paths
    (``developer._save``, the admin, the delete tombstone) own the row and
    write it under their own locks; ``authorization.application`` may be an
    instance loaded before such a write committed, and overwriting a newer
    ``frozen=true`` or a lowered markup with it would fail OPEN. If the row
    is missing, no registry write since L2 has committed one, and any that
    is in flight still upserts after us. An app deletion racing a grant
    write is covered by the tombstone being an upsert too
    (``ledger_signals``): whichever inserts first, the other waits on it and
    the row ends frozen, or Postgres aborts one of the two. It runs before
    the creator lock so one user's ledger locks stay together
    (``sync_oidc_ledger``) and nothing waits on another transaction while
    holding them.
    """
    if not _table_exists(LEDGER_SPEND_CAP_TABLE):
        logger.info("oidc: ledger_spend_cap not present; grant projection skipped (L2 pending)")
        return SKIPPED_NO_TABLE
    if _table_exists(LEDGER_APP_TABLE):
        _ensure_application(authorization.application)
    from dj.apps.ledger.api import ensure_account, lock_creator

    lock_creator(authorization.user_id)
    account_id = ensure_account(authorization.user_id)
    cap_m2z = None if authorization.spend_cap_2z is None else authorization.spend_cap_2z * 1000
    with connection.cursor() as cursor:
        cursor.execute("SELECT id FROM ledger_account WHERE id = %s FOR NO KEY UPDATE", [account_id])
        cursor.execute(
            f"""
            INSERT INTO {LEDGER_SPEND_CAP_TABLE}
                (app_id, account_id, cap_m2z, period, markup_bps, grant_generation, revoked_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (app_id, account_id) DO UPDATE SET
                cap_window_revision = ledger_spend_cap.cap_window_revision + CASE
                    WHEN ledger_spend_cap.period IS DISTINCT FROM EXCLUDED.period
                      OR (ledger_spend_cap.cap_m2z IS NULL) <> (EXCLUDED.cap_m2z IS NULL)
                    THEN 1 ELSE 0 END,
                cap_m2z = EXCLUDED.cap_m2z,
                period = EXCLUDED.period,
                markup_bps = EXCLUDED.markup_bps,
                grant_generation = EXCLUDED.grant_generation,
                revoked_at = EXCLUDED.revoked_at,
                updated_at = now()
            """,
            [
                str(authorization.application_id),
                account_id,
                cap_m2z,
                authorization.cap_period,
                authorization.markup_bps,
                authorization.generation,
                authorization.revoked_at,
            ],
        )
    return WRITTEN
