""": a registration's default TOTAL budget, and the authorization
request's optional spend-cap hint (`f2z_spend_cap` / `f2z_spend_period`).

The hint is a URL parameter, so the rule it lives under is "a URL never
dictates what goes in the database": it may only move what the consent
screen PRE-SELECTS, clamped so it is never above what the screen would have
offered anyway, and nothing is recorded except the cap the consent POST
carries in its own body. Every refusal sits beside the positive case.
"""
from __future__ import annotations

import itertools

import pytest
from rest_framework.test import APIClient

from types import SimpleNamespace

from dj.apps.oidc import consent
from dj.apps.oidc.models import AppAuthorization, CapPeriod, F2ZApplication

from .conftest import LOOPBACK_REQUESTED, WEB_REDIRECT, Flow, query_of

pytestmark = pytest.mark.django_db

APPS = "/api/oauth/apps/"
AI = "openid offline_access ai:invoke"


def _grant(user, app):
    grant = AppAuthorization.objects.get(user=user, application=app)
    return grant.spend_cap_2z, grant.cap_period


@pytest.fixture
def aha_app(developer):
    """Registered the way AHA would: through the public console, as an
    ordinary public client with a 500 2Z TOTAL default budget."""
    console = APIClient()
    console.force_login(developer)
    response = console.post(APPS, {
        "client_type": "public",
        "name": "AHA",
        "redirect_uris": ["http://127.0.0.1:0/callback"],
        "allowed_scopes": ["openid", "offline_access", "ai:invoke"],
        "default_spend_cap_2z": 500,
        "default_cap_period": "total",
    }, format="json")
    assert response.status_code == 201, response.content
    assert (response.json()["default_spend_cap_2z"], response.json()["default_cap_period"]) == (500, "total")
    return F2ZApplication.objects.get(pk=response.json()["id"])


@pytest.fixture
def aha_flow(signed_in, user, aha_app):
    return Flow(signed_in, user, aha_app, redirect_uri=LOOPBACK_REQUESTED, scope=AI)


def _consent(flow, **hint):
    response = flow.evaluate(**hint)
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["action"] == "consent", body
    return body


# ------------------------------------------------ the registration's default
def test_registration_default_total_is_preselected_and_recorded(aha_flow, user, aha_app):
    evaluated = _consent(aha_flow)
    prompt = evaluated["consent"]
    assert prompt["spend_cap"] == {"spend_cap_2z": 500, "cap_period": "total"}
    assert prompt["spend_cap_source"] == "app"
    assert prompt["current_spend_cap"] is None
    # The page submits the pre-selection as the user's explicit choice.
    decided = aha_flow.decide(evaluated, spend_cap_2z=500, cap_period="total")
    assert decided.status_code == 200, decided.content
    assert _grant(user, aha_app) == (500, "total")


def test_the_user_can_still_lower_or_change_the_registration_default(aha_flow, user, aha_app):
    evaluated = _consent(aha_flow)
    assert aha_flow.decide(evaluated, spend_cap_2z=120, cap_period="week").status_code == 200
    assert _grant(user, aha_app) == (120, "week")


# ------------------------------------------------------------ the hint
def test_a_lower_hint_is_preselected_as_is(aha_flow):
    prompt = _consent(aha_flow, f2z_spend_cap="200", f2z_spend_period="total")["consent"]
    assert prompt["spend_cap"] == {"spend_cap_2z": 200, "cap_period": "total"}
    assert prompt["spend_cap_source"] == "request"


def test_a_hint_above_the_registration_is_clamped_to_it(aha_flow):
    # Same period, more than the default: the amount is lowered to it.
    prompt = _consent(aha_flow, f2z_spend_cap="900", f2z_spend_period="total")["consent"]
    assert prompt["spend_cap"] == {"spend_cap_2z": 500, "cap_period": "total"}
    assert prompt["spend_cap_source"] == "request"
    # No period: the registration's own, so it fits.
    prompt = _consent(aha_flow, f2z_spend_cap="900")["consent"]
    assert prompt["spend_cap"] == {"spend_cap_2z": 500, "cap_period": "total"}


def test_a_hint_for_another_period_than_the_registration_is_ignored(aha_flow):
    # A capped default fixes the period: 900 a day, or even 100 a month, is
    # outside "500 in total" whatever the amount, and a period is never
    # rewritten -- the hint is ignored and the app's default is offered.
    for cap, period in (("900", "day"), ("100", "month"), ("1", "week")):
        prompt = _consent(aha_flow, f2z_spend_cap=cap, f2z_spend_period=period)["consent"]
        assert prompt["spend_cap"] == {"spend_cap_2z": 500, "cap_period": "total"}, period
        assert prompt["spend_cap_source"] == "app", period


def test_a_hint_without_a_period_keeps_the_preselected_period(signed_in, user, aha_app):
    aha_app.default_spend_cap_2z = None
    aha_app.save()
    flow = Flow(signed_in, user, aha_app, redirect_uri=LOOPBACK_REQUESTED, scope=AI)
    prompt = _consent(flow, f2z_spend_cap="500")["consent"]
    # No registration budget: the platform's month, and the hint's amount
    # is already lower than "no cap", so nothing is clamped.
    assert prompt["spend_cap"] == {"spend_cap_2z": 500, "cap_period": "month"}
    prompt = _consent(flow, f2z_spend_cap="500", f2z_spend_period="total")["consent"]
    assert prompt["spend_cap"] == {"spend_cap_2z": 500, "cap_period": "total"}


@pytest.mark.parametrize("hint", [
    {"f2z_spend_cap": "0"},
    {"f2z_spend_cap": "-5"},
    {"f2z_spend_cap": "01"},
    {"f2z_spend_cap": "1e3"},
    {"f2z_spend_cap": "12.5"},
    {"f2z_spend_cap": "９"},             # a fullwidth digit: isdigit, not ASCII
    {"f2z_spend_cap": "2147483648"},
    {"f2z_spend_cap": "99999999999999999999"},
    {"f2z_spend_cap": "100", "f2z_spend_period": "year"},
    {"f2z_spend_period": "total"},           # a period alone is no hint
])
def test_an_unusable_hint_is_ignored_not_an_error(aha_flow, hint):
    prompt = _consent(aha_flow, **hint)["consent"]
    assert prompt["spend_cap"] == {"spend_cap_2z": 500, "cap_period": "total"}
    assert prompt["spend_cap_source"] == "app"


def test_the_hint_is_clamped_to_the_existing_grant_and_never_needs_a_step_up(aha_flow, user, aha_app):
    aha_app.default_cap_period = "month"
    aha_app.save()
    aha_flow.run(spend_cap_2z=100, cap_period="month")
    prompt = _consent(aha_flow, f2z_spend_cap="400", f2z_spend_period="month")["consent"]
    assert prompt["current_spend_cap"] == {"spend_cap_2z": 100, "cap_period": "month"}
    assert prompt["spend_cap"] == {"spend_cap_2z": 100, "cap_period": "month"}
    # A lower amount is taken; confirming it is a LOWERING and records
    # without any recent sign-in (this session has no auth context at all,
    # so a raise would be a 401).
    evaluated = _consent(aha_flow, f2z_spend_cap="40", f2z_spend_period="month")
    assert evaluated["consent"]["spend_cap"] == {"spend_cap_2z": 40, "cap_period": "month"}
    decided = aha_flow.decide(evaluated, spend_cap_2z=40, cap_period="month")
    assert decided.status_code == 200, decided.content
    assert _grant(user, aha_app) == (40, "month")
    #...whereas the user choosing a raise themselves still needs one.
    evaluated = _consent(aha_flow)
    assert aha_flow.decide(evaluated, spend_cap_2z=40, cap_period="day").status_code == 401


def test_the_hint_never_moves_a_capped_grant_to_another_period(aha_flow, aha_app):
    # "100 a month" -> "100 in total" ranks as a lowering, but the ledger
    # counts each period in its own window: an app that spent this month's
    # 100 would get a fresh 100. Such a hint is not applied at all.
    aha_app.default_cap_period = "month"
    aha_app.save()
    aha_flow.run(spend_cap_2z=100, cap_period="month")
    prompt = _consent(aha_flow, f2z_spend_cap="50", f2z_spend_period="total")["consent"]
    assert prompt["spend_cap"] == {"spend_cap_2z": 100, "cap_period": "month"}
    assert prompt["spend_cap_source"] == "grant"
    # Positive cases: the same period (a shorter one is first lengthened to
    # the registration's month), a lower amount.
    prompt = _consent(aha_flow, f2z_spend_cap="50", f2z_spend_period="month")["consent"]
    assert prompt["spend_cap"] == {"spend_cap_2z": 50, "cap_period": "month"}
    assert prompt["spend_cap_source"] == "request"
    # A shorter period is never lengthened into a fit: ignored.
    for period in ("week", "day"):
        prompt = _consent(aha_flow, f2z_spend_cap="50", f2z_spend_period=period)["consent"]
        assert prompt["spend_cap"] == {"spend_cap_2z": 100, "cap_period": "month"}, period
        assert prompt["spend_cap_source"] == "grant", period
    # With the registration at `total`, the hint could only reach this grant
    # by changing its period, so it is ignored whatever it asks for.
    aha_app.default_cap_period = "total"
    aha_app.save()
    prompt = _consent(aha_flow, f2z_spend_cap="50", f2z_spend_period="month")["consent"]
    assert prompt["spend_cap_source"] == "grant"


@pytest.mark.parametrize("hint", [
    {"f2z_spend_cap": " 200 ", "f2z_spend_period": " total"},
    {"f2z_spend_cap": "500\x00"},
    {"f2z_spend_cap": "500", "f2z_spend_period": "total\x00"},
])
def test_an_unusable_hint_is_dropped_before_signing_so_allow_and_deny_work(aha_flow, user, aha_app, hint):
    evaluated = _consent(aha_flow, **hint)
    assert evaluated["consent"]["spend_cap_source"] == "app"
    # Ignored means as if never sent: not echoed, so nothing the POST's
    # serializer would refuse (a NUL) or rewrite (padding) comes back.
    assert "f2z_spend_cap" not in evaluated["authorization_request"]
    assert "f2z_spend_period" not in evaluated["authorization_request"]
    denied = aha_flow.decide(evaluated, allow=False)
    assert denied.status_code == 200, denied.content
    assert denied.json()["action"] == "redirect"
    decided = aha_flow.decide(evaluated, spend_cap_2z=500, cap_period="total")
    assert decided.status_code == 200, decided.content
    assert _grant(user, aha_app) == (500, "total")


def test_an_uncapped_existing_grant_takes_the_hint_as_a_lowering(aha_flow, user, aha_app):
    aha_flow.run(spend_cap_2z=None, cap_period="month")
    prompt = _consent(aha_flow, f2z_spend_cap="500", f2z_spend_period="total")["consent"]
    assert prompt["current_spend_cap"] == {"spend_cap_2z": None, "cap_period": "month"}
    assert prompt["spend_cap"] == {"spend_cap_2z": 500, "cap_period": "total"}


# ------------------------------------- a URL never dictates what is recorded
def test_the_hint_alone_never_records_a_cap(aha_flow, user, aha_app):
    # No registered budget: the hint's period is free, the fallback period
    # (platform `month`) differs, so the row shows which one was used.
    aha_app.default_spend_cap_2z = None
    aha_app.default_cap_period = "month"
    aha_app.save()
    evaluated = _consent(aha_flow, f2z_spend_cap="50", f2z_spend_period="total")
    assert evaluated["authorization_request"]["f2z_spend_cap"] == "50"
    assert evaluated["consent"]["spend_cap"] == {"spend_cap_2z": 50, "cap_period": "total"}
    # The first AI consent still needs the body's own decision.
    missing = aha_flow.decide(evaluated)
    assert missing.status_code == 400
    assert not AppAuthorization.objects.filter(user=user, application=aha_app).exists()
    # A body cap without a period takes the REGISTRATION's period, not the
    # hint's: the hint's `total` never reaches the row by itself.
    decided = aha_flow.decide(evaluated, spend_cap_2z=50)
    assert decided.status_code == 200, decided.content
    assert _grant(user, aha_app) == (50, "month")


def test_a_reconsent_without_a_body_cap_keeps_the_grant_despite_a_hint(aha_flow, user, aha_app):
    aha_flow.run(spend_cap_2z=300, cap_period="total")
    evaluated = _consent(aha_flow, f2z_spend_cap="10", f2z_spend_period="total")
    assert evaluated["consent"]["spend_cap"] == {"spend_cap_2z": 10, "cap_period": "total"}
    assert aha_flow.decide(evaluated).status_code == 200
    assert _grant(user, aha_app) == (300, "total")


def test_the_request_id_binds_the_hint(aha_flow, user, aha_app):
    evaluated = _consent(aha_flow, f2z_spend_cap="50", f2z_spend_period="total")
    tampered = dict(evaluated)
    tampered["authorization_request"] = {**evaluated["authorization_request"], "f2z_spend_cap": "5"}
    refused = aha_flow.decide(tampered, spend_cap_2z=5, cap_period="total")
    assert refused.status_code == 400
    assert refused.json()["error"] == "invalid_request"
    assert not AppAuthorization.objects.filter(user=user, application=aha_app).exists()


def test_a_silent_approval_ignores_the_hint(signed_in, user, web_app):
    # An https client with a covering grant is approved without a screen:
    # nobody confirmed anything, so the hint changes nothing.
    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid ai:invoke")
    flow.run(spend_cap_2z=100, cap_period="month")
    response = flow.evaluate(f2z_spend_cap="5", f2z_spend_period="total").json()
    assert response["action"] == "approve"
    assert flow.decide(response, spend_cap_2z="omit").status_code == 200
    assert _grant(user, web_app) == (100, "month")


def test_the_hint_is_never_forwarded_to_oauthlib_nor_the_redirect(aha_flow, monkeypatch):
    """The hint is the platform's, not an OAuth parameter: oauthlib (and so
    the code, the stored grant and the redirect) never sees it. Every
    synthetic request the consent step hands the library is captured, so a
    change that forwarded it fails here rather than passing silently."""
    from dj.apps.oidc import views

    handed = []
    real = views._synthetic_authorization_request

    def spy(params, user=None):
        request = real(params, user=user)
        handed.append(request)
        return request

    monkeypatch.setattr(views, "_synthetic_authorization_request", spy)
    evaluated = _consent(aha_flow, f2z_spend_cap="500", f2z_spend_period="total")
    # The consent step itself still received and echoed it...
    assert evaluated["authorization_request"]["f2z_spend_cap"] == "500"
    decided = aha_flow.decide(evaluated, spend_cap_2z=500, cap_period="total")
    assert decided.status_code == 200, decided.content
    #...but no request built for the library carried it (GET, POST's
    # validation and the POST's code minting: at least three).
    assert len(handed) >= 3
    for request in handed:
        for name in ("f2z_spend_cap", "f2z_spend_period", "f2z_login_ticket"):
            assert name not in request.GET, name
            assert name not in request.META["QUERY_STRING"], name
    redirect = decided.json()["redirect_to"]
    assert "f2z_spend" not in redirect
    # And the code it minted still exchanges.
    code = query_of(redirect)["code"]
    assert aha_flow.exchange(code).status_code == 200


# ------------------------------------------------------- the clamp itself
PERIODS = [p.value for p in CapPeriod]


@pytest.mark.parametrize("ceiling_cap", [None, 0, 1, 100, 500])
def test_clamp_only_lowers_the_amount_and_never_changes_a_period(ceiling_cap):
    for cap, period, ceiling_period in itertools.product(
        [1, 99, 100, 101, 500, 10_000], PERIODS, PERIODS,
    ):
        result = consent.clamp_cap(cap, period, ceiling_cap, ceiling_period)
        if ceiling_cap is None:
            assert result == (cap, period)
            continue
        if period != ceiling_period:
            assert result is None
            continue
        assert result == (min(cap, ceiling_cap), period)
        assert not consent.is_cap_raise(ceiling_cap, ceiling_period, *result)


def test_an_applied_hint_never_raises_the_registration_nor_the_grant():
    """Exhaustive over small values, on the FINAL pre-selection (not just
    `clamp_cap`): whenever a hint is applied, confirming it is not a raise
    over the registration's default, nor over an existing grant, and never
    moves a capped grant to another period (codex review, )."""
    caps = [None, 1, 50, 100, 500]
    for (reg_cap, reg_period), existing, (hint_cap, hint_period) in itertools.product(
        itertools.product(caps, PERIODS),
        [None, *(SimpleNamespace(spend_cap_2z=c, cap_period=p) for c in caps for p in PERIODS)],
        itertools.product([1, 50, 100, 101, 900], [None, *PERIODS]),
    ):
        app = SimpleNamespace(default_spend_cap_2z=reg_cap, default_cap_period=reg_period)
        cap, period, source = consent.preselection(
            app, existing, consent.SpendCapHint(hint_cap, hint_period),
        )
        case = (reg_cap, reg_period, existing, hint_cap, hint_period, cap, period)
        if source != consent.SOURCE_REQUEST:
            assert (cap, period) == consent.preselection(app, existing)[:2], case
            continue
        if reg_cap is not None:
            # Within the registration's default: its period, at most its amount.
            assert period == reg_period and cap <= reg_cap, case
        if existing is not None:
            assert not consent.is_cap_raise(
                existing.spend_cap_2z, existing.cap_period, cap, period,
            ), case
            if existing.spend_cap_2z is not None:
                assert period == existing.cap_period, case


# ------------- a grant that never decided AI spending is no baseline
@pytest.mark.parametrize("revoke", [True, False])
def test_an_identity_only_grant_never_preselects_uncapped_ai(signed_in, user, aha_app, revoke):
    """Identity-only while the app had no default: the row stores "no cap"
    only because identity needs none. After the app sets 500/total (and the
    user revokes, or simply upgrades), the AI consent must offer the app's
    default -- pre-selecting "no cap" would grant uncapped AI on one Allow,
    skipping the "no limit" confirmation a capped pre-selection requires."""
    aha_app.default_spend_cap_2z = None
    aha_app.save()
    identity = Flow(signed_in, user, aha_app, redirect_uri=LOOPBACK_REQUESTED, scope="openid")
    identity.run()
    assert _grant(user, aha_app) == (None, "month")
    aha_app.default_spend_cap_2z = 500
    aha_app.default_cap_period = "total"
    aha_app.save()
    if revoke:
        consent.revoke_authorization(user, aha_app)
    flow = Flow(signed_in, user, aha_app, redirect_uri=LOOPBACK_REQUESTED, scope=AI)
    prompt = _consent(flow)["consent"]
    assert prompt["spend_cap"] == {"spend_cap_2z": 500, "cap_period": "total"}
    assert prompt["spend_cap_source"] == "app"
    assert prompt["current_spend_cap"] is None
    assert prompt["is_raise_step_up_required"] is False
    # The hint applies against the app's default, not the stored "no cap".
    prompt = _consent(flow, f2z_spend_cap="200", f2z_spend_period="total")["consent"]
    assert prompt["spend_cap"] == {"spend_cap_2z": 200, "cap_period": "total"}
    # And confirming the pre-selection needs no fresh sign-in.
    decided = flow.decide(_consent(flow), spend_cap_2z=500, cap_period="total")
    assert decided.status_code == 200, decided.content
    assert _grant(user, aha_app) == (500, "total")


def test_a_capped_grant_without_ai_is_still_the_baseline(signed_in, user, aha_app):
    # AI was granted at 100/month and later narrowed to identity: the cap is
    # still the user's decision (and the ledger window), so it is kept.
    aha_app.default_cap_period = "month"
    aha_app.save()
    flow = Flow(signed_in, user, aha_app, redirect_uri=LOOPBACK_REQUESTED, scope=AI)
    flow.run(spend_cap_2z=100, cap_period="month")
    flow.scope = "openid"
    assert flow.decide(_consent(flow, prompt="consent")).status_code == 200
    assert AppAuthorization.objects.get(user=user, application=aha_app).scope == "openid"
    assert _grant(user, aha_app) == (100, "month")
    flow.scope = AI
    prompt = _consent(flow)["consent"]
    assert prompt["spend_cap"] == {"spend_cap_2z": 100, "cap_period": "month"}
    assert prompt["spend_cap_source"] == "grant"
    assert prompt["current_spend_cap"] == {"spend_cap_2z": 100, "cap_period": "month"}
