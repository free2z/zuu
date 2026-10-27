"""The sign-up welcome grant: every new account starts with 2Z.

Real Postgres, real ledger, and the real sign-up endpoints: each path is
driven over HTTP exactly as a browser or app drives it (provider round trips
and signature checks stubbed at the same seams the login tests stub), and the
grant is read back from the receipt table AND the ledger journal.

NEGATIVE CONTROLS (run by hand while writing this file; each went red):
  * adding ``welcome_new_account`` back to the exempt Zcash path -> the
    Zcash test fails (balance 10) and ``test_every_welcome_site_calls_the_hook``
    fails naming the exemption (2 failed);
  * making ``welcome-grant:`` keys per-account again in ``issue_grant``
    (``if False:`` on the global branch) -> 14 fail, the late-repair test
    among them (and every journal check, which expects the key itself);
  * keying the social path on the account id instead of the identity (drop
    its ``identity_key=``) -> the three social cases plus the unlink,
    either-X-door and repaired-identity tests fail (6 failed);
  * replacing the social path's ``welcome_new_account(...)`` with ``pass`` ->
    the three ``test_social_sign_up_grants_*`` cases and
    ``test_every_welcome_site_calls_the_hook`` fail (4 failed);
  * ``if existing is not None`` -> ``if False`` in ``issue_grant`` (no receipt
    check) -> the repeated-grant test and both runbook-repair tests fail with a
    second receipt (3 failed);
  * making ``welcome_new_account`` re-raise -> both failure tests fail: the
    sign-up 500s instead of creating the account (2 failed).
"""
import ast
import secrets
import subprocess
import sys
from decimal import Decimal
from io import StringIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.test import Client
from rest_framework.test import APIClient

from dj.apps.g12f.models import Creator
from dj.apps.social.models import SocialIdentity
from dj.apps.tuzis import welcome
from dj.apps.tuzis.models import TuziGrant
from dj.apps.twitter.models import TwitterProfile
from dj.apps.twitter.views import (
    TWITTER_OAUTH2_HANDSHAKE_COOKIE,
    sign_oauth2_handshake,
)
from dj.apps.zauth.models import ZcashIdentity

pytestmark = pytest.mark.django_db

PASSWORD = "correct-horse-battery-staple"
SOCIAL_REDIRECT_URI = "http://localhost:3000/auth/callback"
ZCASH_ADDRESS = "t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH"
PY_ROOT = Path(__file__).resolve().parents[3]  #.../py


# --------------------------------------------------------------------------- #
# Fixtures and helpers
# --------------------------------------------------------------------------- #
@pytest.fixture(autouse=True)
def _captcha_passes(monkeypatch):
    monkeypatch.setattr(
        "dj.apps.g12f.captcha.requests.post",
        lambda _url, **_kw: SimpleNamespace(json=lambda: {"success": True}),
    )


@pytest.fixture(autouse=True)
def _clean_caches():
    from django.core.cache import cache

    cache.clear()
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def _not_prod(monkeypatch):
    monkeypatch.delenv("NAMESPACE", raising=False)


@pytest.fixture
def social_providers(settings):
    for prefix in ("GOOGLE", "TWITTER", "GITHUB"):
        setattr(settings, f"{prefix}_CLIENT_ID", f"test-{prefix.lower()}-id")
        setattr(settings, f"{prefix}_CLIENT_SECRET", f"test-{prefix.lower()}-secret")
    settings.SOCIAL_REDIRECT_URI_ALLOWLIST = [SOCIAL_REDIRECT_URI]
    return settings


@pytest.fixture
def zcash_admission(settings, request):
    settings.ZCASH_AUTH_ADMISSION_NAMESPACE = (
        f"welcome-{request.node.nodeid}-{secrets.token_hex(8)}")
    settings.ZCASH_CHALLENGE_ADMISSION_LIMITS = {
        "window_seconds": 60, "client": 100, "address": 100}
    settings.ZCASH_LOGIN_ADMISSION_LIMITS = {"window_seconds": 60, "client": 100}


def _password_sign_up(client, username):
    return client.post("/api/start/", {
        "username": username, "password": PASSWORD,
        "captcha_result": "ci-valid-captcha",
    }, format="json")


def _social_login(client, mocker, provider, uid):
    mocker.patch("dj.apps.social.views.exchange_identity", return_value={
        "uid": uid, "handle": f"{uid}-handle", "avatar_url": ""})
    start = client.get(f"/api/auth/social/{provider}/start",
                       {"redirect_uri": SOCIAL_REDIRECT_URI})
    assert start.status_code == 200, start.content
    return client.post(f"/api/auth/social/{provider}/", {
        "code": "provider-code", "state": start.data["state"],
        "redirect_uri": SOCIAL_REDIRECT_URI,
    }, format="json")


def _zcash_login(client, address=ZCASH_ADDRESS):
    challenge = client.post("/api/auth/zcash/challenge/",
                            {"address": address}, format="json")
    assert challenge.status_code == 200, challenge.content
    return client.post("/api/auth/zcash/login/", {
        "address": address, "challenge": challenge.data["challenge"],
        "signature": "valid-signature",
    }, format="json")


def _twitter_callback(client, mocker, twitter_id):
    client.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE] = sign_oauth2_handshake(
        "twitter-state", "verifier")
    mocker.patch("dj.apps.twitter.views.get_twitter_user", return_value={
        "id": twitter_id, "username": twitter_id, "name": "X user",
        "description": "", "profile_image_url": ""})
    return client.get("/api/twitter/callback",
                      {"state": "twitter-state", "code": "provider-code"},
                      secure=True)


def _balance(creator):
    return Creator.objects.get(pk=creator.pk).tuzis


def _journal(creator):
    """Every welcome-keyed ledger leg into this account:
    (debit key, credit key, m2Z, code, idem)."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT d.key, c.key, t.amount, t.code, k.idem
              FROM ledger_transfer_key k
              JOIN ledger_transfer t ON t.id = k.transfer_id
              JOIN ledger_account d ON d.id = t.debit_account_id
              JOIN ledger_account c ON c.id = t.credit_account_id
             WHERE k.idem LIKE 'welcome-grant:%%' AND c.key = %s
            """,
            [f"user:{creator.pk}"],
        )
        return cursor.fetchall()


def assert_welcomed_once(creator, amount=Decimal("10"), key=None):
    """Exactly one receipt, one sys:promo -> user leg, and the balance."""
    key = key or welcome.welcome_key(creator.pk)
    grants = list(TuziGrant.objects.filter(creator_id=creator.pk))
    assert len(grants) == 1, grants
    [grant] = grants
    assert grant.amount == amount
    assert grant.balance_after == amount
    assert grant.idempotency_key == key
    assert grant.operator == welcome.WELCOME_OPERATOR
    assert grant.reason == welcome.WELCOME_REASON
    assert _balance(creator) == amount
    # The ledger leg: sys:promo debited, the user's own account credited, by
    # exactly the amount in m2Z (1 2Z = 1000 m2Z), as a grant.
    assert _journal(creator) == [
        ("sys:promo", f"user:{creator.pk}", int(amount * 1000), "grant", key)]


def assert_not_welcomed(creator):
    assert not TuziGrant.objects.filter(creator_id=creator.pk).exists()
    assert _balance(creator) == Decimal("0")
    assert _journal(creator) == []


# --------------------------------------------------------------------------- #
# Every sign-up path grants exactly once
# --------------------------------------------------------------------------- #
def test_password_sign_up_grants_the_welcome_2z(api_client):
    response = _password_sign_up(api_client, "welcome-pw")

    assert response.status_code == 201, response.content
    assert_welcomed_once(Creator.objects.get(username="welcome-pw"))


def test_password_sign_in_after_sign_up_grants_nothing_more(api_client):
    assert _password_sign_up(api_client, "welcome-again").status_code == 201
    creator = Creator.objects.get(username="welcome-again")

    # The two-request dance: /api/start/ refuses the existing username, then
    # the login leg signs in. Neither creates an account, so neither grants.
    again = _password_sign_up(api_client, "welcome-again")
    assert again.status_code == 400, again.content
    login = api_client.post("/api/auth/login/", {
        "username": "welcome-again", "password": PASSWORD,
        "captcha_result": "ci-valid-captcha",
    }, format="json")
    assert login.status_code == 204, login.content

    assert_welcomed_once(creator)


@pytest.mark.parametrize("provider", ["google", "x", "github"])
def test_social_sign_up_grants_the_welcome_2z_and_sign_in_again_does_not(
    api_client, social_providers, mocker, provider,
):
    first = _social_login(api_client, mocker, provider, f"{provider}-uid-1")
    assert first.status_code == 200, first.content
    assert first.data["created"] is True
    creator = SocialIdentity.objects.get(
        provider=provider, provider_uid=f"{provider}-uid-1").creator
    key = welcome.identity_welcome_key(provider, f"{provider}-uid-1")
    assert_welcomed_once(creator, key=key)

    second = _social_login(APIClient(), mocker, provider, f"{provider}-uid-1")
    assert second.status_code == 200, second.content
    assert second.data["created"] is False
    assert_welcomed_once(creator, key=key)


def _orphan(creator):
    """What set-password + rename + unlink leaves: the account no longer
    owns the identity, and its username no longer blocks a new one."""
    SocialIdentity.objects.filter(creator=creator).delete()
    TwitterProfile.objects.filter(creator=creator).delete()
    Creator.objects.filter(pk=creator.pk).update(
        username=f"renamed-{creator.pk}")


def test_an_unlinked_social_identity_earns_no_second_grant(
    api_client, social_providers, mocker,
):
    """The faucet codex found: sign up with Google, gift the 2Z away, set a
    password, rename, unlink, sign in with the same Google account again --
    a NEW account. One welcome grant per external identity, ever."""
    first = _social_login(api_client, mocker, "google", "loop-uid")
    assert first.data["created"] is True
    original = SocialIdentity.objects.get(provider_uid="loop-uid").creator
    _orphan(original)

    again = _social_login(APIClient(), mocker, "google", "loop-uid")

    assert again.status_code == 200, again.content
    assert again.data["created"] is True
    fresh = SocialIdentity.objects.get(provider_uid="loop-uid").creator
    assert fresh.pk != original.pk
    assert_not_welcomed(fresh)
    assert_welcomed_once(
        original, key=welcome.identity_welcome_key("google", "loop-uid"))


def test_one_x_account_is_one_grant_through_either_x_door(
    api_client, social_providers, mocker,
):
    """Social X and the legacy X callback share X's user id."""
    first = _social_login(api_client, mocker, "x", "4242")
    assert first.data["created"] is True
    social_account = SocialIdentity.objects.get(provider_uid="4242").creator
    _orphan(social_account)

    response = _twitter_callback(Client(), mocker, "4242")

    assert response.status_code == 302, response.content
    legacy_account = TwitterProfile.objects.get(twitter_id="4242").creator
    assert legacy_account is not None and legacy_account.pk != social_account.pk
    assert_not_welcomed(legacy_account)


def test_linking_a_social_identity_to_an_existing_account_grants_nothing(
    api_client, social_providers, mocker, creator_factory,
):
    user = creator_factory(tuzis=Decimal("0"))
    api_client.force_authenticate(user)
    mocker.patch("dj.apps.social.views.require_recent_auth")

    response = _social_login(api_client, mocker, "google", "link-only")

    assert response.status_code == 200, response.content
    assert response.data["created"] is False
    assert_not_welcomed(user)


def test_zcash_wallet_sign_up_is_exempt_and_grants_nothing(
    api_client, mocker, zcash_admission,
):
    """No CAPTCHA + free keypairs = a faucet; see EXEMPT_SITES."""
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    first = _zcash_login(api_client)
    assert first.status_code == 200, first.content
    creator = ZcashIdentity.objects.get(zcash_address=ZCASH_ADDRESS).creator
    assert_not_welcomed(creator)

    second = _zcash_login(APIClient())
    assert second.status_code == 200, second.content
    assert_not_welcomed(creator)


def test_twitter_sign_up_grants_the_welcome_2z_and_sign_in_again_does_not(mocker):
    response = _twitter_callback(Client(), mocker, "brand-new-x")
    assert response.status_code == 302, response.content
    creator = TwitterProfile.objects.get(twitter_id="brand-new-x").creator
    assert creator is not None
    key = welcome.identity_welcome_key("x", "brand-new-x")
    assert_welcomed_once(creator, key=key)

    TwitterProfile.objects.filter(twitter_id="brand-new-x").update(allow_login=True)
    again = _twitter_callback(Client(), mocker, "brand-new-x")
    assert again.status_code == 302, again.content
    assert_welcomed_once(creator, key=key)

    # Unlink and re-provision: a new account, no second grant.
    _orphan(creator)
    third = _twitter_callback(Client(), mocker, "brand-new-x")
    assert third.status_code == 302, third.content
    fresh = TwitterProfile.objects.get(twitter_id="brand-new-x").creator
    assert fresh.pk != creator.pk
    assert_not_welcomed(fresh)


def test_a_late_repair_cannot_pay_an_identity_twice(
    api_client, social_providers, mocker, monkeypatch,
):
    """Codex round 3: A's grant fails, the identity is unlinked, B is created
    from it and IS welcomed -- then an operator runs A's repair. The key is
    global, so the repair is refused instead of paying the identity twice."""
    def boom(*args, **kwargs):
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(welcome, "issue_grant", boom)
    assert _social_login(api_client, mocker, "google", "late-uid").status_code == 200
    monkeypatch.undo()
    first = SocialIdentity.objects.get(provider_uid="late-uid").creator
    _orphan(first)
    assert _social_login(APIClient(), mocker, "google", "late-uid").data["created"]
    second = SocialIdentity.objects.get(provider_uid="late-uid").creator
    key = welcome.identity_welcome_key("google", "late-uid")
    assert_welcomed_once(second, key=key)

    reason = "welcome grant repair (#2698)"
    first.refresh_from_db()  # renamed by the unlink step
    dry = _grant_tuzis(first.username, "10", reason=reason,
                       idempotency_key=key, dry_run=True)
    assert "would refuse: a different account" in dry
    with pytest.raises(CommandError, match="a different account"):
        _grant_tuzis(first.username, "10", reason=reason, idempotency_key=key)

    assert_not_welcomed(first)
    assert_welcomed_once(second, key=key)


def test_a_repaired_identity_grant_also_blocks_reprovisioning(
    api_client, social_providers, mocker, monkeypatch,
):
    """The failed-grant runbook repairs with the log line's key; the repair's
    receipt (posted under its own ledger key) still counts for the identity."""
    def boom(*args, **kwargs):
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(welcome, "issue_grant", boom)
    first = _social_login(api_client, mocker, "github", "repair-uid")
    assert first.status_code == 200, first.content
    monkeypatch.undo()
    creator = SocialIdentity.objects.get(provider_uid="repair-uid").creator
    assert_not_welcomed(creator)

    key = welcome.identity_welcome_key("github", "repair-uid")
    _grant_tuzis(creator.username, "10",
                 reason="welcome grant repair (#2698)", idempotency_key=key)
    assert _balance(creator) == Decimal("10")
    _orphan(creator)

    again = _social_login(APIClient(), mocker, "github", "repair-uid")
    assert again.data["created"] is True
    assert_not_welcomed(SocialIdentity.objects.get(provider_uid="repair-uid").creator)


# --------------------------------------------------------------------------- #
# Exactly once, and the amount is one setting
# --------------------------------------------------------------------------- #
def test_a_repeated_grant_for_one_account_is_a_no_op(creator_factory):
    creator = creator_factory(tuzis=Decimal("0"))

    first = welcome.welcome_new_account(creator, path="test")
    second = welcome.welcome_new_account(creator, path="test")
    third = welcome.grant_welcome(creator, path="test")

    assert first is not None
    assert second is None and third is None
    assert_welcomed_once(creator)


@pytest.mark.parametrize("amount", [1, 25])
def test_the_setting_is_the_amount(settings, api_client, amount):
    settings.WELCOME_GRANT_2Z = amount

    assert _password_sign_up(api_client, f"welcome-{amount}").status_code == 201

    assert_welcomed_once(
        Creator.objects.get(username=f"welcome-{amount}"), Decimal(amount))


def test_zero_disables_the_grant(settings, api_client):
    settings.WELCOME_GRANT_2Z = 0

    assert _password_sign_up(api_client, "welcome-off").status_code == 201

    assert_not_welcomed(Creator.objects.get(username="welcome-off"))


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(None, 10), ("25", 25), ("0", 0), ("1000", 1000),
     ("1001", 10), ("100000", 10), ("-1", 10), ("ten", 10)],
)
def test_the_setting_reads_the_environment_and_refuses_a_typo(raw, expected):
    """WELCOME_GRANT_2Z is read once at boot; an extra zero falls back to 10."""
    import os

    env = {k: v for k, v in os.environ.items() if k != "WELCOME_GRANT_2Z"}
    if raw is not None:
        env["WELCOME_GRANT_2Z"] = raw
    env["PYTHONPATH"] = str(PY_ROOT)
    env["DJANGO_SETTINGS_MODULE"] = "dj.free2z.settings"
    result = subprocess.run(
        [sys.executable, "-c",
         "from django.conf import settings; print(settings.WELCOME_GRANT_2Z)"],
        env=env, capture_output=True, text=True, timeout=120, check=True,
    )
    assert result.stdout.strip().splitlines()[-1] == str(expected)


# --------------------------------------------------------------------------- #
# A failure never breaks sign-up, and is alertable and repairable
# --------------------------------------------------------------------------- #


def test_a_database_error_inside_the_grant_leaves_sign_up_usable(
    api_client, monkeypatch,
):
    """A real SQL failure aborts only the grant's savepoint, not the sign-up."""
    from dj.apps.tuzis import grants

    def broken_create(**kwargs):
        with connection.cursor() as cursor:
            cursor.execute("SELECT * FROM no_such_table_w2698")

    monkeypatch.setattr(grants.TuziGrant.objects, "create", broken_create)
    response = _password_sign_up(api_client, "welcome-sqlerr")

    assert response.status_code == 201, response.content
    creator = Creator.objects.get(username="welcome-sqlerr")
    assert creator.has_usable_password()
    assert_not_welcomed(creator)


def _grant_tuzis(*args, **kwargs):
    out = StringIO()
    kwargs.setdefault("operator", "pytest-operator")
    call_command("grant_tuzis", *args, stdout=out, **kwargs)
    return out.getvalue()


def test_the_runbook_repair_grants_once_and_never_twice(creator_factory, monkeypatch):
    """The alert's repair: ``grant_tuzis... --idempotency-key welcome-grant:<id>``."""
    creator = creator_factory(tuzis=Decimal("0"))
    key = welcome.welcome_key(creator.pk)
    reason = "welcome grant repair (#2698)"

    out = _grant_tuzis(creator.username, "10", reason=reason, idempotency_key=key)
    assert "GRANTED 10" in out
    # The sign-up path (or a second repair) sees the repair's receipt.
    assert welcome.welcome_new_account(creator, path="test") is None
    assert "REPLAY" in _grant_tuzis(
        creator.username, "10", reason=reason, idempotency_key=key)
    assert TuziGrant.objects.filter(creator=creator).count() == 1
    assert _balance(creator) == Decimal("10")


def test_a_repair_after_a_grant_that_did_land_pays_nothing(creator_factory):
    """The welcome grant wrote no IdempotencyKey row; the receipt alone refuses."""
    creator = creator_factory(tuzis=Decimal("0"))
    key = welcome.welcome_key(creator.pk)
    assert welcome.welcome_new_account(creator, path="test") is not None
    reason = "welcome grant repair (#2698)"

    dry = _grant_tuzis(creator.username, "10", reason=reason,
                       idempotency_key=key, dry_run=True)
    assert "would replay, credit nothing" in dry
    with pytest.raises(CommandError, match="refusing a different amount"):
        _grant_tuzis(creator.username, "11", reason=reason, idempotency_key=key)
    out = _grant_tuzis(creator.username, "10", reason=reason, idempotency_key=key)
    assert "REPLAY" in out and "GRANTED" not in out
    assert_welcomed_once(creator)


# --------------------------------------------------------------------------- #
# Every place that creates an account is a decided place
# --------------------------------------------------------------------------- #
#Non-test modules (relative to py/) that create a Creator for a person
#signing up. Each must call ``welcome_new_account``.
WELCOME_SITES = {
    "dj/apps/g12f/views/creator.py",   # SignUpView: POST /api/start/
    "dj/apps/social/views.py",         # SocialLoginView: Google, X, GitHub
    "dj/apps/twitter/views.py",        # X web callback (handle_new_twitter_user)
}

#Non-test modules that create a Creator but deliberately do NOT grant, and
#why. (The staff admin add form, ``createsuperuser`` and fixtures go through
#Django's own code, not a call site under py/, so they never grant either.)
EXEMPT_SITES: dict[str, str] = {
    "dj/apps/zauth/views.py": (
        "Zcash wallet sign-in has no CAPTCHA and a fresh transparent keypair "
        "costs nothing, so a per-account grant there is a 2Z faucet "
        "(~30 accounts/min/client, consolidated by gifting). The owner's "
        "accepted exposure (#2698) is premised on the sign-up reCAPTCHA. "
        "Grant here only once wallet sign-up has its own abuse admission."
    ),
}

_USER_NAMES = {"Creator", "User", "UserModel"}
_INSERT_METHODS = {
    "create", "create_user", "create_superuser", "get_or_create",
    "update_or_create", "bulk_create", "acreate", "aget_or_create",
    "aupdate_or_create", "abulk_create",
}


def _root_name(node):
    while isinstance(node, (ast.Attribute, ast.Call)):
        node = node.func if isinstance(node, ast.Call) else node.value
    return node.id if isinstance(node, ast.Name) else None


def _account_insert_sites(tree):
    """Calls that construct or insert a Creator/User row."""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        # Creator(...) / User(...) -- a model constructor, then.save().
        if isinstance(func, ast.Name) and func.id in _USER_NAMES:
            yield node.lineno
        # Creator.objects.create(...), get_user_model().objects.create(...),
        # User._base_manager.get_or_create(...), create_user(...).
        elif isinstance(func, ast.Attribute) and func.attr in _INSERT_METHODS:
            root = _root_name(func.value)
            chain = ast.unparse(func.value)
            if root in _USER_NAMES or "get_user_model()" in chain:
                yield node.lineno
            elif func.attr in {"create_user", "create_superuser"}:
                yield node.lineno


def _welcome_calls(tree):
    return [
        node.lineno for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and (getattr(node.func, "id", None) == "welcome_new_account"
             or getattr(node.func, "attr", None) == "welcome_new_account")
    ]


def _non_test_modules():
    for path in sorted((PY_ROOT / "dj").rglob("*.py")):
        rel = path.relative_to(PY_ROOT).as_posix()
        parts = set(path.parts)
        if parts & {"migrations", "tests", "__pycache__"}:
            continue
        if path.name.startswith("test_") or path.name in {"tests.py", "conftest.py"}:
            continue
        yield rel, ast.parse(path.read_text(), filename=str(path))


def test_every_account_insert_site_is_a_welcome_site():
    found = {}
    for rel, tree in _non_test_modules():
        sites = list(_account_insert_sites(tree))
        if sites:
            found[rel] = sites
    undecided = {
        rel: lines for rel, lines in found.items()
        if rel not in WELCOME_SITES and rel not in EXEMPT_SITES
    }
    assert not undecided, (
        "These modules create an account but are neither a welcome-grant "
        "site nor an exemption (#2698). If it is a sign-up, call "
        "dj.apps.tuzis.welcome.welcome_new_account(creator, path=...) in the "
        f"same transaction and add it to WELCOME_SITES: {undecided}"
    )
    # Stale entries fail too: an inert entry reads as live to the next reader.
    assert WELCOME_SITES <= set(found), WELCOME_SITES - set(found)
    assert set(EXEMPT_SITES) <= set(found), set(EXEMPT_SITES) - set(found)


def test_every_welcome_site_calls_the_hook():
    trees = dict(_non_test_modules())
    for rel in sorted(WELCOME_SITES):
        assert _welcome_calls(trees[rel]), (
            f"{rel} creates an account for a sign-up but never calls "
            "welcome_new_account"
        )
    for rel in sorted(EXEMPT_SITES):
        assert not _welcome_calls(trees[rel]), (
            f"{rel} is exempt from the welcome grant ({EXEMPT_SITES[rel]}) "
            "but calls welcome_new_account: remove the call or the exemption"
        )


def test_the_insert_site_scanner_sees_every_shape():
    """Positive control for the scanner above: each shape is detected."""
    shapes = [
        "Creator(username='x').save()",
        "Creator.objects.create(username='x')",
        "Creator._base_manager.get_or_create(username='x')",
        "User.objects.create(username='x')",
        "get_user_model().objects.create(username='x')",
        "Creator.objects.create_user('x')",
        "something.create_superuser('x')",
    ]
    for shape in shapes:
        assert list(_account_insert_sites(ast.parse(shape))), shape
    for benign in ["CreatorFollow.objects.get_or_create(a=1)",
                   "UserProfile.objects.get_or_create(user=u)",
                   "Creator.objects.filter(pk=1).update(x=1)"]:
        assert not list(_account_insert_sites(ast.parse(benign))), benign
