""": the developer console before third-party developers self-register.

Lookalike names, origins that are not origins (or are same-site with us),
https-only consent metadata, and editing a grant's spend cap from
``/account/apps`` with the step-up rule for raises. Real Postgres, real
endpoints.

NEGATIVE CONTROLS (run by hand,; each turns the named tests red):

* ``registration_policy.name_skeleton`` returning ``name.casefold()``:
  the spaced, Cyrillic, leet and fullwidth lookalikes register.
* dropping ``host_is_first_party_site`` from ``origin_problem``: the
  same-site origins register.
* ``_policy_judges`` returning ``True`` always: the legacy-row tests fail
  (an operator could not freeze a lookalike without renaming it).
* dropping the ``is_cap_raise`` guard in ``consent.update_grant_cap``: the
  raise-without-a-recent-sign-in tests answer 200.
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from django.core.exceptions import ValidationError
from django.db import connection
from django.utils import timezone

from dj.apps.identity.models import AuthContext
from dj.apps.oidc import registration_policy as policy
from dj.apps.oidc.models import AppAuthorization, F2ZApplication

from .conftest import WEB_REDIRECT, Flow

pytestmark = pytest.mark.django_db

APPS = "/api/oauth/apps/"


@pytest.fixture
def dev_client(api_client, developer):
    api_client.force_login(developer)
    return api_client


def _public(**overrides):
    body = {
        "client_type": "public",
        "name": "Tutor Web",
        "redirect_uris": ["https://tutor.example.org/cb"],
        "allowed_scopes": ["openid", "ai:invoke"],
    }
    body.update(overrides)
    return body


# ------------------------------------------------------------------ names
LOOKALIKES = [
    "ϜREE2Z", "ꓝꓣꓰꓰ2ꓜ", "ᖴᎡᎬᎬ2Ꮓ", "ꜰʀᴇᴇ2ᴢ",
    "frєє2z", "frɛɛ2z", "freeƧz", "freeƻz",
    "free2ʒ", "free2з", "free2զ", "free2ⲍ",
    "Free2Z",
    "FREE2Z",
    "free2z",
    "free 2 z",
    "Free-2-Z Tutor",
    "free_2z",
    "freе 2z",            # Cyrillic е
    "Frее2Z",        # two Cyrillic е
    "Ｆｒｅｅ２Ｚ",  # fullwidth Ｆｒｅｅ２Ｚ (NFKC)
    "fr33 2z",                 # leet
    "frée2z",             # combining-mark lookalike (é)
    "free2Ζ",             # Greek capital Zeta
    "My free2z helper",
    "Free2Give", "FREE2GIVE", "Free2Glve", "FREE2GlVE",
    "ſree2z", "ſree2give", "free2g˛ve", "free2gͺve",
]


@pytest.mark.parametrize("name", LOOKALIKES)
def test_brand_lookalikes_are_refused_for_third_party_apps(name):
    assert policy.name_problem(name, first_party=False) is not None, policy.name_skeleton(name)
    assert policy.name_problem(name, first_party=True) is None


INVISIBLE = [
    "Tutor\u3164", "Tutor\uffa0", "Tutor\u115f", "Tutor\u1160",
    "Tutor\u034f", "Tutor\ufe0f", "Tutor\U000e0100",
    "Tutor​",       # zero-width space
    "Tu‍tor",       # zero-width joiner
    "‮Tutor",       # right-to-left override
    "Tutor⁦x⁩",  # isolates
    "Tutor﻿",       # BOM
    "Tu\u0007tor",       # control
]


@pytest.mark.parametrize("name", INVISIBLE)
def test_control_bidi_and_zero_width_are_refused_even_for_first_party(name):
    assert policy.name_problem(name, first_party=False) is not None
    assert policy.name_problem(name, first_party=True) is not None


@pytest.mark.parametrize("name", [
    "Tutor", "Corpora Tutor", "Free Tutor 2", "Zen Free", "Freeze Z", "Café 2",
    "日本語アプリ", "Tutor for Free", "Free 2 Zoom",
])
def test_ordinary_names_pass(name):
    # "Free 2 Zoom" folds to "free2zoom", which contains "free2z": refused.
    expected_refused = name == "Free 2 Zoom"
    assert (policy.name_problem(name, first_party=False) is not None) is expected_refused


def test_the_console_refuses_a_lookalike_name(dev_client):
    response = dev_client.post(APPS, _public(name="freе 2 Z"), format="json")
    assert response.status_code == 400, response.content
    assert "name" in response.json()
    assert not F2ZApplication.objects.exists()
    response = dev_client.post(APPS, _public(name="Tu‮tor"), format="json")
    assert response.status_code == 400
    assert "name" in response.json()


def test_a_first_party_app_may_carry_the_brand(dev_client, developer):
    app = F2ZApplication.objects.create(
        name="Free2Z Mobile", user=developer, first_party=True,
        client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris="cash.free2z.app:/oauth/callback",
    )
    renamed = dev_client.patch(f"{APPS}{app.pk}/", {"name": "Free2Z for iPhone"}, format="json")
    assert renamed.status_code == 200, renamed.content


def _legacy_lookalike(developer) -> F2ZApplication:
    """A row that predates, written past ``clean()``."""
    app = F2ZApplication(
        name="Free2Z Helper", user=developer,
        client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris="https://tutor.example.org/cb",
        privacy_url="http://tutor.example.org/privacy",
    )
    F2ZApplication.objects.bulk_create([app])
    return F2ZApplication.objects.get(pk=app.pk)


def test_a_legacy_lookalike_row_stays_saveable_for_the_operator(developer):
    app = _legacy_lookalike(developer)
    app.frozen = True
    app.save()                                  # freezing needs no rename
    app.refresh_from_db()
    assert app.frozen is True
    app.name = "Free2Z Helper 2"                # but a NEW lookalike name is judged
    with pytest.raises(ValidationError) as caught:
        app.save()
    assert "name" in caught.value.message_dict


def test_a_legacy_lookalike_row_edited_in_the_console(dev_client, developer):
    app = _legacy_lookalike(developer)
    unchanged = dev_client.patch(f"{APPS}{app.pk}/", {"markup_bps": 100}, format="json")
    assert unchanged.status_code == 200, unchanged.content
    renamed = dev_client.patch(f"{APPS}{app.pk}/", {"name": "FREE 2 Z"}, format="json")
    assert renamed.status_code == 400
    fixed = dev_client.patch(f"{APPS}{app.pk}/", {"name": "Tutor Helper"}, format="json")
    assert fixed.status_code == 200, fixed.content


# ---------------------------------------------------------------- origins
BAD_ORIGINS = {
    "https://app.example.com/": "path",
    "https://app.example.com/cb": "path",
    "https://app.example.com?x=1": "query",
    "https://app.example.com?": "query",
    "https://app.example.com#frag": "fragment",
    "https://app.example.com#": "fragment",
    "http://app.example.com": "https",
    "https://user@app.example.com": "user name",
    "https://App.Example.com": "https://app.example.com",
    "https://app.example.com:443": "https://app.example.com",
    "https://": "host",
    "https://free2z.cash": "Free2Z domain",
    "https://stage.free2z.cash": "Free2Z domain",
    "https://FREE2Z.COM": "Free2Z domain",
    "https://a.b.free2give.xyz": "Free2Z domain",
    "https://free2z.net:8443": "Free2Z domain",
    "https://free2z.cash.": "Free2Z domain",
}


@pytest.mark.parametrize("origin,why", sorted(BAD_ORIGINS.items()))
def test_origins_that_are_not_canonical_https_origins_are_refused(dev_client, origin, why):
    response = dev_client.post(APPS, _public(allowed_origins=[origin]), format="json")
    assert response.status_code == 400, (origin, response.content)
    messages = " ".join(response.json()["allowed_origins"])
    assert why in messages, messages
    assert not F2ZApplication.objects.exists()


@pytest.mark.parametrize("origin", [
    "https://app.example.com",
    "https://app.example.com:8443",
    "https://notfree2z.cash",        # not same-site: a different registrable domain
    "https://free2z.cash.example.org",
])
def test_canonical_third_party_origins_register(dev_client, origin):
    response = dev_client.post(APPS, _public(allowed_origins=[origin]), format="json")
    assert response.status_code == 201, (origin, response.content)
    assert response.json()["allowed_origins"] == [origin]


def test_ipv6_and_internationalized_origins_use_the_browsers_form(dev_client):
    """The canonical form is what a browser puts in ``Origin``: an IPv6
    literal keeps its brackets, an internationalized host is punycode."""
    ok = dev_client.post(APPS, _public(allowed_origins=["https://[2001:db8::1]:8443"]),
                         format="json")
    assert ok.status_code == 201, ok.content
    upper = dev_client.post(APPS, _public(name="B", allowed_origins=["https://[2001:DB8::1]"]),
                            format="json")
    assert upper.status_code == 400
    assert "https://[2001:db8::1]" in " ".join(upper.json()["allowed_origins"])
    unicode = dev_client.post(APPS, _public(name="C", allowed_origins=["https://bücher.example"]),
                              format="json")
    assert unicode.status_code == 400
    assert "https://xn--bcher-kva.example" in " ".join(unicode.json()["allowed_origins"])
    for name, rewritten in (
        ("E", "https://[2001:0db8:0000:0000:0000:0000:0000:0001]"),  # browser: [2001:db8::1]
        ("F", "https://127.1"),                                       # browser: 127.0.0.1
        ("G", "https://%61pp.example.com"),                           # browser: app.example.com
        ("H", "https://0x7f.0.0.1"),
    ):
        refused = dev_client.post(APPS, _public(name=name, allowed_origins=[rewritten]),
                                  format="json")
        assert refused.status_code == 400, (rewritten, refused.content)
    padded = dev_client.post(
        APPS, _public(name="I", allowed_origins=["https://[2001:0db8:0000:0000:0000:0000:0000:0001]"]),
        format="json",
    )
    assert "https://[2001:db8::1]" in " ".join(padded.json()["allowed_origins"])
    dotted = dev_client.post(APPS, _public(name="J", allowed_origins=["https://203.0.113.7:8443"]),
                             format="json")
    assert dotted.status_code == 201, dotted.content
    ours = dev_client.post(
        APPS, _public(name="D", allowed_origins=["https://ｆｒｅｅ２ｚ.cash"]),
        format="json",
    )
    assert ours.status_code == 400
    assert "Free2Z domain" in " ".join(ours.json()["allowed_origins"])


def test_origins_are_judged_on_edit_too(dev_client):
    created = dev_client.post(APPS, _public(allowed_origins=["https://app.example.com"]),
                              format="json").json()
    response = dev_client.patch(f"{APPS}{created['id']}/",
                                {"allowed_origins": ["https://x.free2z.cash"]}, format="json")
    assert response.status_code == 400
    assert "allowed_origins" in response.json()


# ------------------------------------------------------------ metadata URLs
@pytest.mark.parametrize("field", ["logo_url", "privacy_url", "terms_url"])
def test_metadata_urls_must_be_https(dev_client, field):
    refused = dev_client.post(APPS, _public(**{field: "http://tutor.example.org/x"}), format="json")
    assert refused.status_code == 400, refused.content
    assert field in refused.json()
    refused = dev_client.post(APPS, _public(**{field: "ftp://tutor.example.org/x"}), format="json")
    assert refused.status_code == 400
    accepted = dev_client.post(APPS, _public(**{field: "https://tutor.example.org/x"}), format="json")
    assert accepted.status_code == 201, accepted.content
    blank = dev_client.post(APPS, _public(name="Other", **{field: ""}), format="json")
    assert blank.status_code == 201, blank.content


def test_a_legacy_http_url_does_not_block_other_edits(dev_client, developer):
    app = _legacy_lookalike(developer)            # carries an http privacy_url
    response = dev_client.patch(f"{APPS}{app.pk}/", {"markup_bps": 50}, format="json")
    assert response.status_code == 200, response.content
    response = dev_client.patch(f"{APPS}{app.pk}/",
                                {"privacy_url": "http://tutor.example.org/p2"}, format="json")
    assert response.status_code == 400


# ------------------------------------------------------------ grant cap edit
@pytest.fixture
def ai_grant(signed_in, user, web_app):
    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid ai:invoke")
    flow.authorize(spend_cap_2z=100, cap_period="month")
    return AppAuthorization.objects.get(user=user, application=web_app)


def _grant_url(app) -> str:
    return f"/api/oauth/grants/{app.pk}/cap/"


def _fresh_sign_in(client, user, *, ago=timedelta(0)):
    AuthContext.objects.record(
        user, kind="session", key=client.session.session_key,
        auth_time=timezone.now() - ago, amr=["pwd"], acr="urn:f2z:acr:1fa",
        account_epoch=user.kt_account_epoch, credential_expires_at=None,
    )


def test_lowering_a_cap_applies_at_once(signed_in, ai_grant, web_app):
    generation = ai_grant.generation
    response = signed_in.put(_grant_url(web_app),
                               {"spend_cap_2z": 50, "cap_period": "month"}, format="json")
    assert response.status_code == 200, response.content
    assert response.json()["spend_cap_2z"] == 50
    ai_grant.refresh_from_db()
    assert (ai_grant.spend_cap_2z, ai_grant.cap_period) == (50, "month")
    assert ai_grant.generation == generation, "a cap change never moves agen"
    # A cap of 0 admits no spend in any window, so it is a lowering whatever
    # the period: "stop this app spending" never needs a fresh sign-in.
    zero = signed_in.put(_grant_url(web_app),
                           {"spend_cap_2z": 0, "cap_period": "total"}, format="json")
    assert zero.status_code == 200, zero.content
    ai_grant.refresh_from_db()
    assert (ai_grant.spend_cap_2z, ai_grant.cap_period) == (0, "total")
    #...and from 0, any positive amount is a raise, same period or not.
    for cap, period in [(1, "total"), (1, "day"), (None, "total")]:
        raised = signed_in.put(_grant_url(web_app),
                               {"spend_cap_2z": cap, "cap_period": period}, format="json")
        assert raised.status_code == 401, (cap, period, raised.content)
    ai_grant.refresh_from_db()
    assert (ai_grant.spend_cap_2z, ai_grant.cap_period) == (0, "total")


@pytest.mark.parametrize("cap,period", [
    (200, "month"), (100, "day"), (None, "month"),
    # A LONGER period is a raise too, and so is a smaller amount over a
    # different period: the ledger counts spend per window, so any period
    # change starts an empty window.
    (100, "total"), (50, "total"), (100, "week"), (50, "week"), (1, "day"),
])
def test_raising_a_cap_without_a_recent_sign_in_is_refused(signed_in, ai_grant, web_app, cap, period):
    response = signed_in.put(_grant_url(web_app),
                               {"spend_cap_2z": cap, "cap_period": period}, format="json")
    assert response.status_code == 401, response.content
    assert response.json()["code"] == "insufficient_user_authentication"
    assert 'max_age="300"' in response["WWW-Authenticate"]
    ai_grant.refresh_from_db()
    assert (ai_grant.spend_cap_2z, ai_grant.cap_period) == (100, "month")


def test_raising_a_cap_with_a_stale_sign_in_is_refused(signed_in, user, ai_grant, web_app):
    _fresh_sign_in(signed_in, user, ago=timedelta(minutes=6))
    response = signed_in.put(_grant_url(web_app),
                               {"spend_cap_2z": 500, "cap_period": "month"}, format="json")
    assert response.status_code == 401
    ai_grant.refresh_from_db()
    assert ai_grant.spend_cap_2z == 100


def test_raising_a_cap_with_a_recent_sign_in_applies(signed_in, user, ai_grant, web_app):
    _fresh_sign_in(signed_in, user)
    response = signed_in.put(_grant_url(web_app),
                               {"spend_cap_2z": None, "cap_period": "week"}, format="json")
    assert response.status_code == 200, response.content
    ai_grant.refresh_from_db()
    assert (ai_grant.spend_cap_2z, ai_grant.cap_period) == (None, "week")


# ---------------------------------------------- the raise rule, direction by direction
PERIODS = ["day", "week", "month", "total"]


@pytest.mark.parametrize("old_period", PERIODS)
@pytest.mark.parametrize("new_period", PERIODS)
def test_is_cap_raise_by_direction(old_period, new_period):
    """: the rule is a pure function of the two caps, and any change of
    period on a capped grant is a raise -- the ledger's spend window is keyed
    by the period, so a new period is an empty window whichever way the
    periods rank (``day < week < month < total`` used to make a longer period
    a lowering)."""
    from dj.apps.oidc.consent import is_cap_raise

    same = old_period == new_period
    # Same amount, and a smaller amount: only a kept period is a lowering.
    assert is_cap_raise(100, old_period, 100, new_period) is (not same)
    assert is_cap_raise(100, old_period, 50, new_period) is (not same)
    # A higher amount is a raise whatever the period.
    assert is_cap_raise(100, old_period, 101, new_period) is True
    # No cap is a raise; a cap of 0 admits nothing and never is -- and from
    # 0, any positive amount always is.
    assert is_cap_raise(100, old_period, None, new_period) is True
    assert is_cap_raise(100, old_period, 0, new_period) is False
    assert is_cap_raise(0, old_period, 0, new_period) is False
    assert is_cap_raise(0, old_period, 1, new_period) is True
    assert is_cap_raise(0, old_period, None, new_period) is True
    # An uncapped grant has no window to reset: adding any cap is a lowering.
    assert is_cap_raise(None, old_period, 100, new_period) is False
    assert is_cap_raise(None, old_period, None, new_period) is False


def _hold(user, app, grant, key: str, amount_m2z: int, card) -> dict:
    """A gateway hold as the gateway makes it: through ``ledger.hold``."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT * FROM ledger.hold(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            [user.public_id, str(app.pk), amount_m2z, key, key, 1, 300,
             user.kt_account_epoch, grant.generation, "cap-model", card.version,
             None, grant.markup_bps],
        )
        row = cursor.fetchone()
        return dict(zip([column[0] for column in cursor.description], row))


@pytest.fixture
def gateway(user, web_app):
    """What a hold needs besides the grant: the app in ``ledger_app``, a
    published rate card, and a prepaid balance of 300 2Z."""
    from dj.apps.oidc import ledger_projection
    from dj.apps.pricing.models import RateCard, RateCardModel

    assert ledger_projection.sync_application(web_app) == ledger_projection.WRITTEN
    card = RateCard.objects.create(version=2301)
    RateCardModel.objects.create(
        rate_card=card, model_id="cap-model",
        **{field.name: 1 for field in RateCardModel._meta.fields if "nusd" in field.name},
    )
    RateCard.objects.filter(pk=card.pk).update(active=True, published_at=timezone.now())
    with connection.cursor() as cursor:
        cursor.execute("UPDATE g12f_creator SET tuzis=300 WHERE id=%s", [user.pk])
    return card


def _spend_the_whole_window(user, web_app, ai_grant, card, key="month-1"):
    held = _hold(user, web_app, ai_grant, key, 100_000, card)
    assert held["status"] == "held", held
    with connection.cursor() as cursor:
        cursor.execute("SELECT * FROM ledger.settle_fixed(%s, %s)", [held["hold_id"], 100_000])
        assert cursor.fetchone()[3] == 100_000   # charged
    assert _hold(user, web_app, ai_grant, key + "-over", 1_000, card)["status"] == "cap_exceeded"


def test_a_period_change_cannot_refill_a_spent_window_without_a_fresh_sign_in(
    signed_in, user, ai_grant, web_app, gateway,
):
    """, driven through the real ledger: 100/month, spent to the cap.

    ``ledger_spend_window`` is keyed by ``ledger.window_start(period, now)``
    and ``sync_grant`` opens a new frame on a period change, so 100/month ->
    100/total (or 50/total, or 100/week) would be an EMPTY window -- a fresh
    100 for an app that spent this month's 100. The step-up is the fence:
    without a recent sign-in the change is refused and the hold stays
    ``cap_exceeded``.
    """
    _spend_the_whole_window(user, web_app, ai_grant, gateway)
    for cap, period in [(100, "total"), (50, "total"), (100, "week"), (50, "day")]:
        refused = signed_in.put(_grant_url(web_app),
                                {"spend_cap_2z": cap, "cap_period": period}, format="json")
        assert refused.status_code == 401, (cap, period, refused.content)
        assert refused.json()["code"] == "insufficient_user_authentication"
        ai_grant.refresh_from_db()
        assert (ai_grant.spend_cap_2z, ai_grant.cap_period) == (100, "month")
        with connection.cursor() as cursor:
            cursor.execute("SELECT period, cap_window_revision FROM ledger_spend_cap WHERE app_id=%s",
                           [web_app.pk])
            assert cursor.fetchone() == ("month", 0), "the ledger frame did not move"
        assert _hold(user, web_app, ai_grant, f"after-{cap}-{period}", 1_000, gateway)["status"] == "cap_exceeded"

    # A lowering that KEEPS the period keeps the window and its spend.
    lowered = signed_in.put(_grant_url(web_app),
                            {"spend_cap_2z": 50, "cap_period": "month"}, format="json")
    assert lowered.status_code == 200, lowered.content
    assert _hold(user, web_app, ai_grant, "after-lowering", 1_000, gateway)["status"] == "cap_exceeded"


def test_with_a_fresh_sign_in_a_period_change_is_the_users_new_budget(
    signed_in, user, ai_grant, web_app, gateway,
):
    """The ledger behaviour the rule exists for: once the user has
    re-authenticated, month -> total IS a fresh window (the same as raising
    the amount would be). This is the negative control for the test above --
    if the ledger ever carried spend across a frame change, the step-up would
    no longer be needed, and this test would say so."""
    _spend_the_whole_window(user, web_app, ai_grant, gateway)
    _fresh_sign_in(signed_in, user)
    moved = signed_in.put(_grant_url(web_app),
                          {"spend_cap_2z": 100, "cap_period": "total"}, format="json")
    assert moved.status_code == 200, moved.content
    ai_grant.refresh_from_db()
    with connection.cursor() as cursor:
        cursor.execute("SELECT period, cap_window_revision, ledger.cap_remaining(app_id, account_id, now()) "
                       "FROM ledger_spend_cap WHERE app_id=%s", [web_app.pk])
        assert cursor.fetchone() == ("total", 1, 100_000), "a new frame, and an empty window"
    refilled = _hold(user, web_app, ai_grant, "fresh-window", 1_000, gateway)
    assert refilled["status"] == "held", refilled


def _revoke(signed_in, web_app):
    assert signed_in.delete(f"/api/oauth/grants/{web_app.pk}/").status_code == 204


def _reconsent(signed_in, user, web_app, *, spend_cap_2z, cap_period):
    """A fresh authorization after a revoke: the consent screen, then the
    decision, exactly as the page does it."""
    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid ai:invoke")
    evaluated = flow.evaluate().json()
    assert evaluated["action"] == "consent", evaluated
    assert evaluated["consent"]["is_raise_step_up_required"] is True, "the last grant counts"
    return flow.decide(evaluated, spend_cap_2z=spend_cap_2z, cap_period=cap_period)


def _spent_window_rows(web_app) -> list:
    with connection.cursor() as cursor:
        cursor.execute("SELECT spent_m2z FROM ledger_spend_window WHERE app_id=%s ORDER BY window_start",
                       [web_app.pk])
        return [row[0] for row in cursor.fetchall()]


def test_revoke_then_reconsent_at_another_period_needs_the_step_up(
    signed_in, user, ai_grant, web_app, gateway,
):
    """ review: revoking a grant leaves ``ledger_spend_window`` in
    place, so revoke -> re-consent at another period is the same empty
    window as a direct change, and is judged against the LAST grant."""
    _spend_the_whole_window(user, web_app, ai_grant, gateway)
    _revoke(signed_in, web_app)
    assert _spent_window_rows(web_app) == [100_000], "the spend survives the revoke"

    refused = _reconsent(signed_in, user, web_app, spend_cap_2z=100, cap_period="total")
    assert refused.status_code == 401, refused.content
    assert refused.json()["code"] == "insufficient_user_authentication"
    ai_grant.refresh_from_db()
    assert ai_grant.revoked_at is not None, "nothing was recorded"
    assert _hold(user, web_app, ai_grant, "while-revoked", 1_000, gateway)["status"] == "revoked"

    # The same cap and period again: the window carries its spend, no step-up.
    same = _reconsent(signed_in, user, web_app, spend_cap_2z=100, cap_period="month")
    assert same.status_code == 200, same.content
    ai_grant.refresh_from_db()
    assert ai_grant.is_live
    assert _hold(user, web_app, ai_grant, "same-window", 1_000, gateway)["status"] == "cap_exceeded"

    # With a fresh sign-in the period change is the user's new budget.
    _revoke(signed_in, web_app)
    _fresh_sign_in(signed_in, user)
    moved = _reconsent(signed_in, user, web_app, spend_cap_2z=100, cap_period="total")
    assert moved.status_code == 200, moved.content
    ai_grant.refresh_from_db()
    assert (ai_grant.spend_cap_2z, ai_grant.cap_period, ai_grant.is_live) == (100, "total", True)
    assert _hold(user, web_app, ai_grant, "new-window", 1_000, gateway)["status"] == "held"


def test_after_a_revoke_the_screen_offers_the_last_cap_so_keeping_it_never_loops(
    signed_in, user, ai_grant, web_app,
):
    """Codex review, round 2: the app's default (100/month here) is above a
    revoked 50/month grant. Pre-selecting the default would make "keep my
    current limit" a raise the POST refuses again and again."""
    lowered = signed_in.put(_grant_url(web_app),
                            {"spend_cap_2z": 50, "cap_period": "month"}, format="json")
    assert lowered.status_code == 200, lowered.content
    _revoke(signed_in, web_app)
    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid ai:invoke")
    evaluated = flow.evaluate().json()
    assert evaluated["consent"]["spend_cap"] == {"spend_cap_2z": 50, "cap_period": "month"}
    assert evaluated["consent"]["is_raise_step_up_required"] is True
    # The app's default is a raise over the last grant...
    assert flow.decide(evaluated, spend_cap_2z=100, cap_period="month").status_code == 401
    #...keeping the last cap is not, and reconnects at once.
    kept = flow.decide(evaluated, spend_cap_2z=50, cap_period="month")
    assert kept.status_code == 200, kept.content
    ai_grant.refresh_from_db()
    assert (ai_grant.spend_cap_2z, ai_grant.cap_period, ai_grant.is_live) == (50, "month", True)


def test_an_identity_only_reconnect_after_a_revoke_keeps_the_last_cap(signed_in, user, ai_grant, web_app):
    """Codex review, round 3: the page omits the cap fields when only
    ``openid`` is requested. The omitted cap must be the LAST grant's, not
    the app's default, or the reconnect is refused as a raise forever."""
    lowered = signed_in.put(_grant_url(web_app),
                            {"spend_cap_2z": 50, "cap_period": "month"}, format="json")
    assert lowered.status_code == 200, lowered.content
    _revoke(signed_in, web_app)
    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid")
    evaluated = flow.evaluate().json()
    assert evaluated["action"] == "consent"
    reconnected = flow.decide(evaluated)            # no cap fields at all
    assert reconnected.status_code == 200, reconnected.content
    ai_grant.refresh_from_db()
    assert (ai_grant.spend_cap_2z, ai_grant.cap_period, ai_grant.is_live) == (50, "month", True)
    assert ai_grant.scope_list == ["openid"]


def test_revoke_then_reconsent_uncapped_needs_the_step_up(signed_in, user, ai_grant, web_app, gateway):
    _spend_the_whole_window(user, web_app, ai_grant, gateway)
    _revoke(signed_in, web_app)

    refused = _reconsent(signed_in, user, web_app, spend_cap_2z=None, cap_period="month")
    assert refused.status_code == 401, refused.content
    assert refused.json()["code"] == "insufficient_user_authentication"
    ai_grant.refresh_from_db()
    assert ai_grant.revoked_at is not None and ai_grant.spend_cap_2z == 100
    assert _hold(user, web_app, ai_grant, "while-revoked", 1_000, gateway)["status"] == "revoked"

    _fresh_sign_in(signed_in, user)
    uncapped = _reconsent(signed_in, user, web_app, spend_cap_2z=None, cap_period="month")
    assert uncapped.status_code == 200, uncapped.content
    ai_grant.refresh_from_db()
    assert (ai_grant.spend_cap_2z, ai_grant.is_live) == (None, True)
    held = _hold(user, web_app, ai_grant, "uncapped", 1_000, gateway)
    assert (held["status"], held["cap_remaining"]) == ("held", None), held


def test_the_cap_edit_writes_the_ledger_projection(signed_in, ai_grant, web_app):
    response = signed_in.put(_grant_url(web_app),
                               {"spend_cap_2z": 40, "cap_period": "month"}, format="json")
    assert response.status_code == 200, response.content
    with connection.cursor() as cursor:
        cursor.execute("SELECT cap_m2z, period FROM ledger_spend_cap WHERE app_id = %s",
                       [str(web_app.pk)])
        assert cursor.fetchone() == (40_000, "month")


def test_total_limit_replaces_the_old_projection(signed_in, user, ai_grant, web_app):
    _fresh_sign_in(signed_in, user)   # month -> total opens a fresh window: a raise
    response = signed_in.put(_grant_url(web_app),
                             {"spend_cap_2z": 50, "cap_period": "total"}, format="json")
    assert response.status_code == 200, response.content
    ai_grant.refresh_from_db()
    assert (ai_grant.spend_cap_2z, ai_grant.cap_period) == (50, "total")
    with connection.cursor() as cursor:
        cursor.execute("SELECT cap_m2z,period FROM ledger_spend_cap WHERE app_id=%s", [web_app.pk])
        assert cursor.fetchone() == (50000, "total")


def test_the_cap_is_never_implied(signed_in, ai_grant, web_app):
    for body in ({"cap_period": "month"}, {"spend_cap_2z": 10}, {},
                 {"spend_cap_2z": -1, "cap_period": "month"},
                 {"spend_cap_2z": 10, "cap_period": "year"}):
        response = signed_in.put(_grant_url(web_app), body, format="json")
        assert response.status_code == 400, (body, response.content)
    ai_grant.refresh_from_db()
    assert ai_grant.spend_cap_2z == 100


def test_only_the_owner_edits_a_live_grant(creator_factory, ai_grant, web_app, signed_in):
    from rest_framework.test import APIClient

    other = APIClient()
    other.force_login(creator_factory(username="mallory"))
    response = other.put(_grant_url(web_app),
                                {"spend_cap_2z": 1, "cap_period": "month"}, format="json")
    assert response.status_code == 404
    assert signed_in.delete(f"/api/oauth/grants/{web_app.pk}/").status_code == 204
    revoked = signed_in.put(_grant_url(web_app),
                              {"spend_cap_2z": 1, "cap_period": "month"}, format="json")
    assert revoked.status_code == 404
    missing = signed_in.put("/api/oauth/grants/00000000-0000-4000-8000-000000000000/cap/",
                              {"spend_cap_2z": 1, "cap_period": "month"}, format="json")
    assert missing.status_code == 404


def test_signed_out_cannot_edit(ai_grant, web_app):
    from rest_framework.test import APIClient

    response = APIClient().put(_grant_url(web_app),
                                 {"spend_cap_2z": 1, "cap_period": "month"}, format="json")
    assert response.status_code in (401, 403)


def test_a_grant_without_ai_invoke_has_no_cap_to_edit(signed_in, user, web_app):
    Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid profile").authorize()
    response = signed_in.put(_grant_url(web_app),
                               {"spend_cap_2z": 1, "cap_period": "month"}, format="json")
    assert response.status_code == 400
    assert response.json()["code"] == "cap_not_applicable"


def test_delegated_bearer_cannot_change_even_its_own_users_budget(signed_in, user, web_app):
    """Budget authority stays with the first-party user, not the delegated app."""
    from rest_framework.test import APIClient
    from dj.apps.oidc.scopes import ALL_SCOPES

    tokens = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT,
                  scope=" ".join(ALL_SCOPES)).run(spend_cap_2z=100, cap_period="month")
    grant = AppAuthorization.objects.get(user=user, application=web_app)
    generation = grant.generation
    bearer = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access_token']}"}
    delegated = APIClient()
    # Positive control: a real token for this user/app, with every app scope.
    assert delegated.get("/api/oauth/userinfo", **bearer).status_code == 200
    # A lowering needs no step-up, so an accidental OAuth opt-in would succeed.
    response = delegated.put(_grant_url(web_app),
                             {"spend_cap_2z": 50, "cap_period": "month"},
                             format="json", **bearer)
    assert response.status_code in (401, 403)
    assert "not accepted" in response.json()["detail"]
    grant.refresh_from_db()
    assert (grant.spend_cap_2z, grant.cap_period, grant.generation) == (100, "month", generation)
    # The signed-in user still owns this exact operation.
    response = signed_in.put(_grant_url(web_app),
                             {"spend_cap_2z": 50, "cap_period": "month"}, format="json")
    assert response.status_code == 200
