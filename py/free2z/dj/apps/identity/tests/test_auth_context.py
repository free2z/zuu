"""AuthContext: per-credential auth_time/amr/acr, and its retention.

Real Postgres. Each of the three conditions a context must meet to be
honoured (live, current epoch, same account) has a test that breaks exactly
that one condition.
"""
import hashlib
from datetime import timedelta

import pytest
from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

from dj.apps.g12f.models import Creator
from dj.apps.identity.models import (
    AUTH_CONTEXT_MAX_AGE,
    AuthContext,
    credential_hash,
)

pytestmark = pytest.mark.django_db

SESSION_KEY = "abcdefghijklmnopqrstuvwxyz012345"
KNOX_DIGEST = "f" * 128


def _fresh(user):
    return Creator.objects.get(pk=user.pk)


def _record(user, *, kind="session", key=SESSION_KEY, amr=("pwd",), now=None,
            credential_ttl=timedelta(hours=10), epoch=None):
    now = now or timezone.now()
    return AuthContext.objects.record(
        user, kind=kind, key=key, auth_time=now, amr=amr, acr="",
        account_epoch=user.kt_account_epoch if epoch is None else epoch,
        credential_expires_at=now + credential_ttl,
    )


def test_the_session_key_is_never_stored(creator_factory):
    user = _fresh(creator_factory())
    ctx = _record(user)
    row = AuthContext.objects.filter(pk=ctx.pk).values().get()
    assert SESSION_KEY not in str(row)
    assert ctx.credential_hash == hashlib.sha256(
        f"session:{SESSION_KEY}".encode()).hexdigest()


def test_the_same_key_under_another_kind_is_another_credential():
    assert credential_hash("session", "k") != credential_hash("knox", "k")
    with pytest.raises(ValueError):
        credential_hash("jwt", "k")
    with pytest.raises(ValueError):
        credential_hash("session", "")


def test_a_recorded_context_is_current(creator_factory):
    user = _fresh(creator_factory())
    _record(user, amr=["pwd", "otp", "pwd"])
    ctx = AuthContext.objects.current(user, kind="session", key=SESSION_KEY)
    assert ctx is not None
    assert ctx.amr == ["otp", "pwd"]
    assert AuthContext.objects.current(user, kind="knox", key=SESSION_KEY) is None
    assert AuthContext.objects.current(user, kind="session", key="other") is None


def test_recording_again_replaces_the_context(creator_factory):
    """A step-up re-authenticates the same credential: one row, new time."""
    user = _fresh(creator_factory())
    t0 = timezone.now() - timedelta(minutes=30)
    _record(user, now=t0, amr=["pwd"])
    _record(user, amr=["hwk", "user"])
    assert AuthContext.objects.filter(creator=user).count() == 1
    ctx = AuthContext.objects.current(user, kind="session", key=SESSION_KEY)
    assert ctx.auth_time > t0 + timedelta(minutes=29)
    assert ctx.amr == ["hwk", "user"]


def test_an_expired_context_is_not_current(creator_factory):
    user = _fresh(creator_factory())
    past = timezone.now() - timedelta(hours=11)
    _record(user, now=past, credential_ttl=timedelta(hours=10))
    assert AuthContext.objects.current(user, kind="session", key=SESSION_KEY) is None


def test_a_context_from_before_an_ownership_event_is_not_current(creator_factory):
    user = _fresh(creator_factory())
    _record(user)
    assert AuthContext.objects.current(user, kind="session", key=SESSION_KEY)
    Creator.objects.filter(pk=user.pk).update(
        kt_account_epoch=F("kt_account_epoch") + 1)
    # The caller's copy is stale on purpose; the epoch is read from the row.
    assert AuthContext.objects.current(user, kind="session", key=SESSION_KEY) is None


def test_another_accounts_context_is_not_current(creator_factory):
    a, b = _fresh(creator_factory()), _fresh(creator_factory())
    _record(a)
    assert AuthContext.objects.current(b, kind="session", key=SESSION_KEY) is None


def test_retention_is_the_credential_expiry_capped_at_the_max_age(creator_factory):
    user = _fresh(creator_factory())
    now = timezone.now()
    short = _record(user, key="short", now=now, credential_ttl=timedelta(hours=10))
    assert short.expires_at == now + timedelta(hours=10)
    long = _record(user, key="long", now=now, credential_ttl=timedelta(days=365))
    assert long.expires_at == now + AUTH_CONTEXT_MAX_AGE


def test_a_token_without_an_expiry_is_bounded_by_the_max_age(creator_factory):
    """Knox allows ``expiry=None`` (no TTL); the cap alone bounds it."""
    user = _fresh(creator_factory())
    now = timezone.now()
    ctx = AuthContext.objects.record(
        user, kind="knox", key=KNOX_DIGEST, auth_time=now, amr=["pwd"],
        account_epoch=user.kt_account_epoch, credential_expires_at=None,
    )
    assert ctx.expires_at == now + AUTH_CONTEXT_MAX_AGE


def test_purge_removes_only_expired_rows_in_batches(creator_factory):
    user = _fresh(creator_factory())
    now = timezone.now()
    for i in range(5):
        _record(user, key=f"old-{i}", now=now - timedelta(days=30),
                credential_ttl=timedelta(hours=1))
    live = _record(user, key="live", now=now)
    assert AuthContext.objects.purge_expired(batch_size=2) == 2
    assert AuthContext.objects.purge_expired(batch_size=2) == 2
    assert AuthContext.objects.purge_expired(batch_size=2) == 1
    assert AuthContext.objects.purge_expired(batch_size=2) == 0
    assert list(AuthContext.objects.values_list("pk", flat=True)) == [live.pk]


def test_forget_deletes_one_credentials_context(creator_factory):
    user = _fresh(creator_factory())
    _record(user, kind="session", key=SESSION_KEY)
    _record(user, kind="knox", key=KNOX_DIGEST)
    assert AuthContext.objects.forget(kind="session", key=SESSION_KEY) == 1
    assert AuthContext.objects.current(user, kind="session", key=SESSION_KEY) is None
    assert AuthContext.objects.current(user, kind="knox", key=KNOX_DIGEST)


def test_one_credential_has_one_context(creator_factory):
    user = _fresh(creator_factory())
    ctx = _record(user)
    with pytest.raises(IntegrityError), transaction.atomic():
        AuthContext.objects.create(
            creator=user, credential_kind="session",
            credential_hash=ctx.credential_hash, auth_time=timezone.now(),
            account_epoch=1, expires_at=timezone.now() + timedelta(hours=1),
        )


@pytest.mark.parametrize("override", [
    {"credential_kind": "jwt"},
    {"credential_hash": "not-a-hash"},
    {"expires_at_offset": timedelta(0)},
])
def test_the_database_refuses_malformed_rows(creator_factory, override):
    user = _fresh(creator_factory())
    now = timezone.now()
    fields = dict(
        creator=user, credential_kind="session",
        credential_hash=credential_hash("session", "x"), auth_time=now,
        account_epoch=1, expires_at=now + timedelta(hours=1),
    )
    offset = override.pop("expires_at_offset", None)
    if offset is not None:
        fields["expires_at"] = now + offset
    fields.update(override)
    with pytest.raises(IntegrityError), transaction.atomic():
        AuthContext.objects.create(**fields)


def test_deleting_the_account_deletes_its_contexts(creator_factory):
    user = _fresh(creator_factory())
    ctx = _record(user)
    user.delete()
    assert not AuthContext.objects.filter(pk=ctx.pk).exists()


def test_scheduled_oidc_sweep_removes_expired_auth_contexts(creator_factory):
    from dj.apps.oidc.tasks import sweep_tokens

    user = _fresh(creator_factory())
    now = timezone.now()
    expired = _record(user, key="expired-for-sweep", now=now - timedelta(days=30),
                      credential_ttl=timedelta(hours=1))
    live = _record(user, key="live-for-sweep", now=now)
    sweep_tokens()
    assert not AuthContext.objects.filter(pk=expired.pk).exists()
    assert AuthContext.objects.filter(pk=live.pk).exists()
