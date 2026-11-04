"""The knox 4.2.0 -> 5.1.0 token lockout, and the cleanup that prevents it.

knox 5.0.0 invalidated every token issued before it — ``TOKEN_KEY_LENGTH``
went 8 -> 15, so ``filter(token_key=token[:15])`` matches zero rows for a
legacy key, and ``hash_token`` changed too. Upstream documents this as
intended and nothing here can undo it.

The avoidable part is what those dead rows do NEXT. They are still
*unexpired*, ``TOKEN_LIMIT_PER_USER`` is 5, and ``knox.views.LoginView.post``
counts unexpired rows — so a caller holding five of them is refused a new one
with a 403, and cannot clear them, because ``/api/token/logout/`` and
``/api/token/logoutall/`` both require a WORKING token. It ends only when the
rows pass ``TOKEN_TTL``: up to ten hours.

**Who is actually affected, measured rather than assumed.** ``/api/token/login/``
runs ``DEFAULT_AUTHENTICATION_CLASSES`` = SessionAuthentication +
``AccountEpochTokenAuthentication``, and there is no BasicAuthentication. So
the cap 403 is reachable only by a caller who AUTHENTICATED SUCCESSFULLY —
i.e. one holding a session cookie (or an already-valid 5.x token). A
bearer-only client presenting a dead legacy token is rejected before the view
body ever runs, with ``403 {"detail": "Invalid token."}`` — not the cap error
— and no cleanup inside ``post()`` can help it. That is pinned by
``test_a_dead_bearer_token_never_reaches_the_cleanup`` below, because an
earlier revision of this file used ``force_authenticate()`` and therefore
"proved" a recovery for a population that cannot reach the code at all. The
codex adversarial review caught it.

How such a client gets back in, stated precisely (a later review round caught
this paragraph overclaiming as well): ``/api/auth/social/`` and
``/api/auth/zcash/`` mint a Knox token without needing one, via
``ktauth.credentials.issue_bearer_token``, which does not enforce
``TOKEN_LIMIT_PER_USER`` -- and those are its ONLY call sites.
``/api/auth/login/`` is not a Knox issuer at all: ``REST_AUTH['TOKEN_MODEL']`` is None and it issues no bearer token whatsoever
(it used to return an inert ``rest_framework.authtoken`` key;
``emails/test_password_events_revoke_tokens.py`` pins both). A PASSWORD-only integration therefore recovers only via
the session cookie that login sets plus ``/api/token/login/`` -- precisely
the caller this change unblocks. Being signed out once by a major version
bump is upstream's documented behaviour; being unable to sign back IN is the
part worth fixing.

``test_five_unexpired_legacy_tokens_lock_the_user_out`` is the negative
control that keeps the rest of this file honest: it pins the 403 as a real,
currently reachable behaviour, so the tests below are proving that a lock
which genuinely exists gets opened.

WHY THIS IS A RUNTIME CLEANUP AND NOT A DATA MIGRATION
-------------------------------------------------------
An earlier revision of this branch deleted the whole table in a ``RunPython``
data migration. Two rounds of codex adversarial review killed it, and the
repo's own deploy code says the same thing at
``bin/prod-healthcheck.sh``:

    Rolling back reverts CODE only, not the schema -- safe as long as
    migrations stay backward-compatible (expand/contract). A destructive
    migration would need its own gated follow-up so rollback remains safe.

``manage.py migrate`` runs BEFORE ``bazel-apply``, so a migration that empties
the token table has destroyed every bearer credential at a point where 5.1.0
is not yet serving and might never serve: any later build step can fail, and
the auto-rollback restores the previous IMAGE without rewinding migration
history. Those tokens were still perfectly valid on the 4.2.0 pods that keep
running. The migration would also re-run after the documented
``migrate g12f 0107`` rollback path, deleting live 5.x tokens platform-wide.

The runtime cleanup has neither problem: it lives in the 5.x code, so it
cannot run unless 5.x is actually serving; it is per-user and idempotent; and
it deletes only rows the running knox provably cannot authenticate.
"""

import pytest
from knox.models import AuthToken
from knox.settings import CONSTANTS, knox_settings
from rest_framework.test import APIClient

from dj.apps.g12f.models import IssuedTokenEpoch
from dj.apps.ktauth.credentials import purge_unusable_tokens


LOGIN_URL = "/api/token/login/"
CAP_ERROR = "Maximum amount of tokens allowed per user exceeded."
LEGACY_KEY_LENGTH = 8


def _make_legacy_token(user):
    """A row shaped the way knox 4.2.0 wrote them: an 8-character key.

    Written through the real manager and then narrowed, so everything else
    about the row — digest, expiry, and the ``IssuedTokenEpoch`` stamp its
    ``post_save`` receiver creates — is exactly what a 4.2.0 pod would leave
    behind. Only ``token_key`` is rewritten, because that is the one column
    the key-length change altered.
    """
    instance, _ = AuthToken.objects.create(user)
    AuthToken.objects.filter(pk=instance.pk).update(
        token_key=instance.token_key[:LEGACY_KEY_LENGTH]
    )
    return instance


def _fill_to_the_cap(user):
    limit = knox_settings.TOKEN_LIMIT_PER_USER
    assert limit, "This suite is meaningless without a configured token cap."
    for _ in range(limit):
        _make_legacy_token(user)
    return limit


def test_the_upgrade_actually_changed_the_key_length():
    """Pins the premise. If this ever stops being true, so does the lockout."""
    assert CONSTANTS.TOKEN_KEY_LENGTH == 15
    assert LEGACY_KEY_LENGTH != CONSTANTS.TOKEN_KEY_LENGTH


@pytest.mark.django_db
def test_five_unexpired_legacy_tokens_lock_the_user_out(
    api_client, creator_factory, monkeypatch
):
    """NEGATIVE CONTROL: the cap 403 this change prevents is real.

    The cleanup is disabled for this one test so the underlying knox
    behaviour is visible. Without this, a passing suite could not tell
    "the lockout is fixed" from "the lockout never existed".
    """
    monkeypatch.setattr(
        "dj.free2z.urls.purge_unusable_tokens", lambda user: 0
    )
    user = creator_factory()
    limit = _fill_to_the_cap(user)
    api_client.force_login(user)

    response = api_client.post(LOGIN_URL)

    assert response.status_code == 403, response.data
    assert response.data["error"] == CAP_ERROR
    assert AuthToken.objects.filter(user=user).count() == limit


@pytest.mark.django_db
def test_a_dead_bearer_token_never_reaches_the_cleanup(creator_factory):
    """The limitation, pinned so it cannot be quietly re-hidden.

    This is the test an earlier revision of this file did NOT have, and its
    absence made the whole suite dishonest: every other test here used
    ``force_authenticate()``, which installs a user directly on the request
    and SKIPS the authentication classes entirely. Under that fixture a
    bearer client looks recoverable. It is not.

    ``/api/token/login/`` authenticates with SessionAuthentication +
    ``AccountEpochTokenAuthentication`` and no BasicAuthentication, so a dead
    legacy token fails authentication and DRF returns before ``post()`` runs.
    Nothing inside the view can rescue that caller -- which is fine, because
    the social/Zcash/password issuers do not enforce the cap, so signing in
    again works. What matters is that this file never again claims otherwise.

    Asserted as "not the cap error" rather than as a bare status code: the
    response is a 403 rather than a 401 only because SessionAuthentication is
    first in the list and supplies no ``WWW-Authenticate`` header, which is a
    DRF detail this test has no reason to freeze.
    """
    user = creator_factory()
    instance, raw_token = AuthToken.objects.create(user)
    AuthToken.objects.filter(pk=instance.pk).update(
        token_key=instance.token_key[:LEGACY_KEY_LENGTH]
    )
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Token {raw_token}")

    response = client.post(LOGIN_URL)

    assert response.status_code in (401, 403), response.data
    assert response.data.get("error") != CAP_ERROR
    assert response.data.get("detail") is not None
    # The row is still there: the request never reached the cleanup.
    assert AuthToken.objects.filter(pk=instance.pk).exists()


@pytest.mark.django_db
def test_a_user_at_the_cap_can_log_in_again(api_client, creator_factory):
    """The whole point: five dead rows no longer cost anyone ten hours."""
    user = creator_factory()
    limit = _fill_to_the_cap(user)
    assert AuthToken.objects.filter(user=user).count() == limit
    api_client.force_login(user)

    response = api_client.post(LOGIN_URL)

    assert response.status_code == 200, response.data
    assert response.data["token"]
    # Only the token this login just minted; the five dead ones are gone.
    assert AuthToken.objects.filter(user=user).count() == 1


@pytest.mark.django_db
def test_the_purge_cascades_the_issued_token_epoch_stamps(creator_factory):
    """The stamps go with the tokens — asserted, not inferred from the FK.

    ``IssuedTokenEpoch.token`` is that table's primary key, so a stamp that
    outlived its token names a credential that does not exist. Django
    cascades in PYTHON, not in the database (the constraint is
    ``NO ACTION DEFERRABLE``), so this is a property of HOW the purge
    deletes, not of the schema.
    """
    user = creator_factory()
    limit = _fill_to_the_cap(user)
    # Captured as primary keys BEFORE the delete, and asserted afterwards by
    # primary key. Re-querying `filter(token__user=user)` would join through
    # the token table and report 0 for orphaned stamps too -- the assertion
    # would pass on exactly the bug it exists to catch. (An earlier revision
    # of this test did that; a `_raw_delete` negative control caught it.)
    stamp_ids = list(
        IssuedTokenEpoch.objects.filter(token__user=user).values_list(
            "pk", flat=True
        )
    )
    assert len(stamp_ids) == limit

    assert purge_unusable_tokens(user) == limit

    assert AuthToken.objects.filter(user=user).count() == 0
    assert not IssuedTokenEpoch.objects.filter(pk__in=stamp_ids).exists()


@pytest.mark.django_db
def test_the_purge_never_deletes_a_usable_token(api_client, creator_factory):
    """A cleanup that revokes live credentials is worse than the lockout.

    Only rows whose ``token_key`` was written at a DIFFERENT key length go: a
    row the running knox could still authenticate must survive a login, or
    signing in on one device would sign you out of every other.
    """
    user = creator_factory()
    keep, _ = AuthToken.objects.create(user)
    stale = _make_legacy_token(user)
    api_client.force_login(user)

    response = api_client.post(LOGIN_URL)

    assert response.status_code == 200, response.data
    surviving = set(
        AuthToken.objects.filter(user=user).values_list("pk", flat=True)
    )
    assert keep.pk in surviving
    assert stale.pk not in surviving


@pytest.mark.django_db
def test_the_purge_leaves_other_users_alone(api_client, creator_factory):
    """Scoped to the caller, not a platform-wide sweep on every login."""
    caller = creator_factory()
    bystander = creator_factory()
    bystander_stale = _make_legacy_token(bystander)
    _make_legacy_token(caller)
    api_client.force_login(caller)

    assert api_client.post(LOGIN_URL).status_code == 200

    assert AuthToken.objects.filter(pk=bystander_stale.pk).exists()


@pytest.mark.django_db
def test_the_purge_is_idempotent(creator_factory):
    """Running it twice is a no-op, and it reports what it removed.

    This is the property a one-shot data migration could not have, and the
    reason the cleanup is safe to run on every single login.
    """
    user = creator_factory()
    _make_legacy_token(user)
    AuthToken.objects.create(user)

    assert purge_unusable_tokens(user) == 1
    assert purge_unusable_tokens(user) == 0
    assert AuthToken.objects.filter(user=user).count() == 1


def test_no_destructive_token_migration_was_reintroduced():
    """The bulk purge must not come back as a migration (expand/contract).

    ``bin/prod-healthcheck.sh`` rolls back CODE and not the schema, so a
    migration that deletes bearer credentials revokes them at a point where
    5.1.0 may never end up serving. Two rounds of codex adversarial review
    landed on this, and it is the kind of thing a later "let's just clean the
    table" commit re-adds without knowing why it was removed.
    """
    from pathlib import Path

    from dj.apps.g12f import migrations

    # The one sanctioned exception, and why it is not this hazard: 0113
    # purges `rest_framework.authtoken` rows, a credential NO release
    # -- old or new -- authenticates with, so a code rollback loses nothing
    # by it. It must never touch Knox, which is asserted rather than trusted.
    not_knox = {"0113_purge_legacy_drf_authtoken.py"}

    directory = Path(migrations.__file__).parent
    names = sorted(p.name for p in directory.glob("[0-9]*.py"))
    assert not [
        n for n in names
        if ("purge" in n or "knox" in n) and n not in not_knox
    ], names
    for name in not_knox:
        source = (directory / name).read_text(encoding="utf-8").lower()
        assert "knox" not in source and "authtoken_token" in source, name
