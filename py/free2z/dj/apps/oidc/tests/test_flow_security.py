"""The authorization-code flow and its security properties, each with the
positive case beside the refusal so a broken check cannot pass by accident."""
from __future__ import annotations

from datetime import timedelta

import jwt as pyjwt
import pytest
from django.conf import settings
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.ktauth.epoch import EVENT_PASSWORD_CHANGE, bump_account_epoch
from dj.apps.oidc import keys
from dj.apps.oidc.authentication import verify_bearer
from dj.apps.oidc.models import AccessToken, AppAuthorization, RefreshToken
from dj.apps.oidc.scopes import AUD_AI, AUD_API, AUD_ID
from dj.apps.oidc.tokens import (
    InvalidAccessToken,
    access_token_claims,
    decode_access_token,
    sign_access_token,
)

from .conftest import (
    LOOPBACK_REQUESTED,
    WEB_REDIRECT,
    WEB_REDIRECT_2,
    Flow,
    form_post,
    query_of,
)

pytestmark = pytest.mark.django_db


def userinfo(access_token):
    return APIClient().get("/api/oauth/userinfo", HTTP_AUTHORIZATION=f"Bearer {access_token}")


# ------------------------------------------------------------- happy path
def test_the_whole_flow_and_every_claim(flow, user, web_app, keyring):
    response = flow.evaluate()
    assert response.status_code == 200
    evaluated = response.json()
    assert evaluated["action"] == "consent"
    consent = evaluated["consent"]
    assert consent["application"]["client_id"] == web_app.client_id
    assert consent["application"]["developer"] == "corpora"
    assert consent["scopes"] == ["openid", "profile", "offline_access"]
    assert consent["cap_required"] is False

    tokens = flow.run()
    assert tokens["token_type"] == "Bearer"
    assert tokens["expires_in"] == 300
    assert tokens["scope"] == "openid profile offline_access"
    assert "refresh_token" in tokens and "id_token" in tokens

    header = pyjwt.get_unverified_header(tokens["access_token"])
    assert header == {"alg": "ES256", "typ": "at+jwt", "kid": keyring.active_es256.kid}
    claims = decode_access_token(tokens["access_token"], audience=AUD_ID)
    assert claims["iss"] == settings.OIDC_ISSUER
    assert claims["sub"] == str(user.public_id)
    assert claims["aud"] == [AUD_ID]
    assert claims["client_id"] == web_app.client_id
    assert claims["scope"] == "openid profile offline_access"
    assert claims["exp"] - claims["iat"] == 300
    assert claims["aep"] == user.kt_account_epoch == 1
    assert claims["agen"] == 1
    assert claims["jti"]

    id_header = pyjwt.get_unverified_header(tokens["id_token"])
    assert id_header["alg"] == "RS256" and id_header["kid"] == keyring.active_rs256.kid
    id_claims = pyjwt.decode(
        tokens["id_token"], keyring.active_rs256.public_pem, algorithms=["RS256"],
        audience=web_app.client_id, issuer=settings.OIDC_ISSUER,
    )
    assert id_claims["sub"] == str(user.public_id)
    assert id_claims["nonce"] == flow.nonce
    assert "at_hash" in id_claims
    assert id_claims["preferred_username"] == "alice"
    assert "email" not in id_claims  # scope not granted

    grant = AppAuthorization.objects.get(user=user, application=web_app)
    assert grant.scope_list == ["openid", "profile", "offline_access"]
    assert grant.generation == 1 and grant.markup_bps == 0
    row = AccessToken.objects.get(token=tokens["access_token"])
    assert (row.account_epoch, row.grant_generation) == (1, 1)
    assert RefreshToken.objects.get(token=tokens["refresh_token"]).account_epoch == 1


def test_audiences_follow_the_granted_scopes(signed_in, user, web_app):
    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT,
                scope="openid balance:read ai:invoke")
    tokens = flow.run(spend_cap_2z=50, cap_period="day")
    claims = decode_access_token(tokens["access_token"], audience=AUD_AI)
    assert claims["aud"] == [AUD_ID, AUD_AI, AUD_API]
    assert "refresh_token" not in tokens, "no offline_access, no refresh token (spec §8)"
    grant = AppAuthorization.objects.get(user=user, application=web_app)
    assert (grant.spend_cap_2z, grant.cap_period) == (50, "day")


def test_authorization_response_carries_iss_for_mix_up_detection(flow):
    """RFC 9207 on success AND on error, and discovery agrees (spec §9.3)."""
    code_url = flow.decide(flow.evaluate().json()).json()["redirect_to"]
    assert query_of(code_url)["iss"] == settings.OIDC_ISSUER
    denied = flow.decide(flow.evaluate().json(), allow=False).json()["redirect_to"]
    assert query_of(denied)["error"] == "access_denied"
    assert query_of(denied)["iss"] == settings.OIDC_ISSUER
    assert query_of(denied)["state"] == flow.state
    discovery = APIClient().get("/.well-known/openid-configuration").json()
    assert discovery["issuer"] == settings.OIDC_ISSUER
    assert discovery["authorization_response_iss_parameter_supported"] is True


# ---------------------------------------------------- code / redirect binding
def test_a_code_is_bound_to_the_redirect_uri_it_was_issued_for(flow):
    code = flow.authorize()
    mismatch = flow.exchange(code, redirect_uri=WEB_REDIRECT_2)   # registered, but not THIS one
    assert mismatch.status_code == 400
    assert mismatch.json()["error"] == "invalid_grant"
    # Control: the same code with the right redirect URI is good (a refused
    # attempt does not spend it -- the legitimate client can still redeem)...
    ok = flow.exchange(code)
    assert ok.status_code == 200
    #...and single use.
    replay = flow.exchange(code)
    assert replay.status_code == 400 and replay.json()["error"] == "invalid_grant"


def test_a_replayed_code_revokes_the_tokens_of_its_first_redemption(flow, user):
    """RFC 6749 §4.1.2. The replay is refused AND what the first redemption
    issued dies: access token gone, refresh family revoked."""
    code = flow.authorize()
    tokens = flow.exchange(code).json()
    assert userinfo(tokens["access_token"]).status_code == 200
    replay = flow.exchange(code)
    assert replay.status_code == 400 and replay.json()["error"] == "invalid_grant"
    assert userinfo(tokens["access_token"]).status_code == 401
    assert flow.refresh(tokens["refresh_token"]).status_code == 400
    assert not AccessToken.objects.filter(user=user).exists()
    # Negative control: a different, un-replayed authorization is untouched.
    other = flow.run()
    assert userinfo(other["access_token"]).status_code == 200
    # The grant itself survives (this is not a grant revocation).
    assert AppAuthorization.objects.get(user=user, application=flow.app).is_live


def test_a_mint_refuses_when_the_epoch_moved_between_validation_and_signing(flow, user):
    """Codex round 2: the credential's stamped epoch must equal the row's at
    mint time; a reset committing in between is refused, never adopted."""
    from oauthlib.oauth2.rfc6749 import errors as oauth_errors

    from dj.apps.oidc.models import AuthorizationCode
    from dj.apps.oidc.tokens import build_token_context

    from oauthlib.common import Request as OAuthlibRequest

    flow.authorize()
    grant = AuthorizationCode.objects.get(user=user)
    req = OAuthlibRequest("https://oidc.local/api/oauth/token", http_method="POST")
    req.user, req.client, req.scopes = user, flow.app, ["openid"]
    req.f2z_authorization_code = grant
    assert build_token_context(req).account_epoch == 1          # control
    type(user).objects.filter(pk=user.pk).update(kt_account_epoch=2)   # "between"
    with pytest.raises(oauth_errors.InvalidGrantError):
        build_token_context(req)


def test_consent_is_bound_to_the_terms_the_user_saw(flow, web_app, user):
    """Codex round 2: a markup rise between GET and POST invalidates the
    request_id; the page must evaluate again and show the new price."""
    evaluated = flow.evaluate().json()
    assert evaluated["consent"]["application"]["markup_bps"] == 0
    web_app.markup_bps = 2000
    web_app.approved_markup_bps = 2000
    web_app.save()
    stale = flow.decide(evaluated)
    assert stale.status_code == 400 and "terms" in stale.json()["error_description"]
    assert not AppAuthorization.objects.filter(user=user, application=web_app).exists()
    # Re-evaluated, the new price is shown and consent records it.
    fresh = flow.evaluate().json()
    assert fresh["consent"]["application"]["markup_bps"] == 2000
    assert flow.decide(fresh).status_code == 200
    assert AppAuthorization.objects.get(user=user, application=web_app).markup_bps == 2000
    # The silent-approve path is bound too: an approve request_id minted
    # before a rise is refused rather than consenting unseen.
    approve = flow.evaluate().json()
    assert approve["action"] == "approve"
    web_app.markup_bps = 3000
    web_app.approved_markup_bps = 3000
    web_app.save()
    assert flow.decide(approve).status_code == 400
    assert AppAuthorization.objects.get(user=user, application=web_app).markup_bps == 2000


def test_revoking_the_grant_kills_outstanding_codes(flow, signed_in, web_app, user):
    """Codex round 2: a code issued before a revocation must not redeem
    against a grant re-authorized within the code's lifetime."""
    code = flow.authorize()
    assert signed_in.delete(f"/api/oauth/grants/{web_app.pk}/").status_code == 204
    fresh_code = flow.authorize()                       # re-authorize
    refused = flow.exchange(code)
    assert refused.status_code == 400 and refused.json()["error"] == "invalid_grant"
    assert flow.exchange(fresh_code).status_code == 200  # control


def test_a_lost_concurrent_redemption_revokes_both_chains(flow, user):
    """Codex round 2: simulates the loser of two racing redemptions -- the
    compare-and-set fails and the tokens THIS request minted die with the
    winner's."""
    from dj.apps.oidc.models import AuthorizationCode, RefreshToken
    from dj.apps.oidc.validators import F2ZOAuth2Validator
    from oauthlib.oauth2.rfc6749 import errors as oauth_errors

    code = flow.authorize()
    winner = flow.exchange(code).json()                 # redeemed: winner's chain recorded
    assert userinfo(winner["access_token"]).status_code == 200
    loser = flow.run()                                  # stands in for the loser's freshly saved chain
    from oauthlib.common import Request as OAuthlibRequest

    req = OAuthlibRequest("https://oidc.local/api/oauth/token", http_method="POST")
    req.client = flow.app
    req.f2z_minted_access_token = AccessToken.objects.get(token=loser["access_token"])
    req.f2z_minted_refresh_token = RefreshToken.objects.get(token=loser["refresh_token"])
    with pytest.raises(oauth_errors.InvalidGrantError):
        F2ZOAuth2Validator().invalidate_authorization_code(flow.app.client_id, code, req)
    assert userinfo(winner["access_token"]).status_code == 401
    assert userinfo(loser["access_token"]).status_code == 401
    assert flow.refresh(winner["refresh_token"]).status_code == 400
    assert flow.refresh(loser["refresh_token"]).status_code == 400
    assert AuthorizationCode.objects.get(code=code).redeemed_at is not None


def test_a_code_is_bound_to_its_client(flow, loopback_app):
    code = flow.authorize()
    response = flow.exchange(code, client_id=loopback_app.client_id)
    assert response.status_code == 400
    assert response.json()["error"] in ("invalid_grant", "invalid_client")


def test_loopback_ignores_the_port_and_nothing_else(signed_in, user, loopback_app):
    """RFC 8252 §7.3: registered with port 0, requested with an ephemeral port."""
    flow = Flow(signed_in, user, loopback_app, redirect_uri=LOOPBACK_REQUESTED, scope="openid")
    assert flow.exchange(flow.authorize()).status_code == 200
    other_port = Flow(signed_in, user, loopback_app,
                      redirect_uri="http://127.0.0.1:60000/callback", scope="openid")
    assert other_port.exchange(other_port.authorize()).status_code == 200
    wrong_path = Flow(signed_in, user, loopback_app,
                      redirect_uri="http://127.0.0.1:49152/other", scope="openid")
    assert wrong_path.evaluate().status_code == 400
    localhost = Flow(signed_in, user, loopback_app,
                     redirect_uri="http://localhost:49152/callback", scope="openid")
    assert localhost.evaluate().status_code == 400


# ------------------------------------------------------------------- PKCE
def test_pkce_cannot_be_downgraded(flow):
    plain = flow.evaluate(code_challenge_method="plain").json()
    assert plain["action"] == "redirect"
    assert query_of(plain["redirect_to"])["error"] == "invalid_request"
    missing = flow.evaluate(code_challenge=None, code_challenge_method=None).json()
    assert missing["action"] == "redirect"
    assert query_of(missing["redirect_to"])["error"] == "invalid_request"
    # The consent POST re-validates: a tampered method in the body is refused
    # even with a valid request_id shape.
    evaluated = flow.evaluate().json()
    evaluated["authorization_request"]["code_challenge_method"] = "plain"
    tampered = flow.decide(evaluated)
    assert tampered.status_code == 400   # request_id no longer matches the params


def test_the_verifier_is_checked_at_the_token_endpoint(flow):
    code = flow.authorize()
    assert flow.exchange(code, verifier=None).status_code == 400
    code = flow.authorize()
    wrong = flow.exchange(code, verifier="a" * 43)
    assert wrong.status_code == 400 and wrong.json()["error"] == "invalid_grant"
    # Control.
    assert flow.exchange(flow.authorize()).status_code == 200


# --------------------------------------------------------- refresh families
def _age_revocation(refresh_token, seconds):
    RefreshToken.objects.filter(token=refresh_token).update(
        revoked=timezone.now() - timedelta(seconds=seconds),
    )


def test_refresh_rotates_and_the_lost_response_grace_returns_the_same_successor(flow):
    tokens = flow.run()
    rt1 = tokens["refresh_token"]
    second = flow.refresh(rt1)
    assert second.status_code == 200
    rt2 = second.json()["refresh_token"]
    assert rt2 != rt1
    # Within 60 s the previous token yields the SAME successor (spec §8).
    again = flow.refresh(rt1)
    assert again.status_code == 200
    assert again.json()["refresh_token"] == rt2
    assert again.json()["access_token"] == second.json()["access_token"]
    assert AppAuthorization.objects.get(user=flow.user, application=flow.app).generation == 1


def test_refresh_reuse_revokes_the_family_and_bumps_the_grant_generation(flow):
    tokens = flow.run()
    rt1 = tokens["refresh_token"]
    second = flow.refresh(rt1).json()
    rt2, at2 = second["refresh_token"], second["access_token"]
    assert userinfo(at2).status_code == 200

    _age_revocation(rt1, 61)                       # past the grace window
    reuse = flow.refresh(rt1)
    assert reuse.status_code == 400 and reuse.json()["error"] == "invalid_grant"

    # The whole family is dead...
    later = flow.refresh(rt2)
    assert later.status_code == 400 and later.json()["error"] == "invalid_grant"
    #...the grant generation moved...
    assert AppAuthorization.objects.get(user=flow.user, application=flow.app).generation == 2
    #...and the access token minted from the chain is refused right away,
    # not in five minutes.
    refused = userinfo(at2)
    assert refused.status_code == 401
    with pytest.raises(InvalidAccessToken) as excinfo:
        verify_bearer(at2, audience=AUD_ID)
    assert excinfo.value.code == "token_revoked"


def test_a_fresh_family_is_unaffected_by_another_familys_reuse(signed_in, user, web_app):
    """Negative control for the test above: two devices, one stolen token."""
    device_a = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid offline_access")
    device_b = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid offline_access")
    a = device_a.run()
    b = device_b.run()
    a2 = device_a.refresh(a["refresh_token"]).json()
    _age_revocation(a["refresh_token"], 61)
    assert device_a.refresh(a["refresh_token"]).status_code == 400
    # Family B's refresh token still rotates (the family is intact)...
    b2 = device_b.refresh(b["refresh_token"])
    assert b2.status_code == 200
    #...but its access tokens minted before the bump are refused, because
    # `agen` is per grant, not per family (spec §6.3): sign in again.
    assert userinfo(a2["access_token"]).status_code == 401
    assert userinfo(b2.json()["access_token"]).status_code == 200


# --------------------------------------------------------------- account epoch
def test_an_ownership_event_kills_access_and_refresh_tokens(flow, user, django_capture_on_commit_callbacks):
    tokens = flow.run()
    assert userinfo(tokens["access_token"]).status_code == 200      # control

    with django_capture_on_commit_callbacks(execute=True):
        bump_account_epoch(user.pk, event=EVENT_PASSWORD_CHANGE)

    refused = userinfo(tokens["access_token"])
    assert refused.status_code == 401
    with pytest.raises(InvalidAccessToken) as excinfo:
        verify_bearer(tokens["access_token"], audience=AUD_ID)
    assert excinfo.value.code == "token_revoked"
    refresh = flow.refresh(tokens["refresh_token"])
    assert refresh.status_code == 400 and refresh.json()["error"] == "invalid_grant"
    # The browser session died with the event too; a new sign-in mints
    # tokens at the new epoch.
    assert flow.evaluate().json()["action"] == "login"
    user.refresh_from_db()          # the session hash carries the epoch
    flow.client.force_login(user)
    fresh = flow.run()
    assert decode_access_token(fresh["access_token"], audience=AUD_ID)["aep"] == 2
    assert userinfo(fresh["access_token"]).status_code == 200


def test_a_code_minted_before_an_ownership_event_is_not_redeemable_after_it(flow, user, django_capture_on_commit_callbacks):
    """Codex finding: a code plus verifier stolen from a compromised session
    must not turn into post-recovery tokens when the owner resets their
    password inside the code's 60-second window."""
    code = flow.authorize()
    with django_capture_on_commit_callbacks(execute=True):
        bump_account_epoch(user.pk, event=EVENT_PASSWORD_CHANGE)
    refused = flow.exchange(code)
    assert refused.status_code == 400 and refused.json()["error"] == "invalid_grant"
    assert not AccessToken.objects.filter(user=user).exists()


def test_a_banned_account_can_neither_refresh_nor_redeem(flow, user):
    """Codex finding: a ban does not move the epoch, so it must be checked
    on its own at every mint."""
    tokens = flow.run()
    code = flow.authorize()
    type(user).objects.filter(pk=user.pk).update(is_active=False)
    refused = flow.refresh(tokens["refresh_token"])
    assert refused.status_code == 400 and refused.json()["error"] == "invalid_grant"
    refused = flow.exchange(code)
    assert refused.status_code == 400 and refused.json()["error"] == "invalid_grant"
    assert userinfo(tokens["access_token"]).status_code == 401
    # Control: reactivated, a NEW sign-in works (the old family stays dead).
    type(user).objects.filter(pk=user.pk).update(is_active=True)
    assert flow.refresh(tokens["refresh_token"]).status_code == 400
    assert flow.exchange(flow.authorize()).status_code == 200


def test_reuse_is_detected_after_any_number_of_rotations(flow):
    """Codex finding: after RT1 -> RT2 -> RT3 the access token minted from
    RT1 is gone, so 'does its successor still exist' is the wrong question;
    'is the family still alive' is the right one."""
    tokens = flow.run()
    rt1 = tokens["refresh_token"]
    rt2 = flow.refresh(rt1).json()["refresh_token"]
    third = flow.refresh(rt2).json()
    rt3, at3 = third["refresh_token"], third["access_token"]
    assert userinfo(at3).status_code == 200
    _age_revocation(rt1, 61)
    replay = flow.refresh(rt1)
    assert replay.status_code == 400
    assert AppAuthorization.objects.get(user=flow.user, application=flow.app).generation == 2
    assert userinfo(at3).status_code == 401
    assert flow.refresh(rt3).status_code == 400
    # And a token the user deliberately revoked, presented again, bumps
    # nothing: the family was already dead, so this is not reuse.
    fresh = flow.run()
    assert form_post(APIClient(), "/api/oauth/revoke", {
        "token": fresh["refresh_token"], "client_id": flow.app.client_id,
    }).status_code == 200
    assert flow.refresh(fresh["refresh_token"]).status_code == 400
    assert AppAuthorization.objects.get(user=flow.user, application=flow.app).generation == 2


def test_a_jwt_with_a_stale_aep_is_refused_even_if_it_verifies(flow, user):
    """The stamp, not just the signature: a perfectly signed token whose
    `aep` is behind the account is `token_revoked`."""
    tokens = flow.run()
    claims = decode_access_token(tokens["access_token"], audience=AUD_ID)
    stale = dict(claims, aep=claims["aep"] - 1) if claims["aep"] > 1 else None
    if stale is None:
        # Epoch 1 has no predecessor; bump and re-sign at the old value.
        user.refresh_from_db()
        from django.contrib.auth import get_user_model
        get_user_model().objects.filter(pk=user.pk).update(kt_account_epoch=2)
        stale = dict(claims)
    forged = sign_access_token(stale)
    with pytest.raises(InvalidAccessToken) as excinfo:
        verify_bearer(forged, audience=AUD_ID)
    assert excinfo.value.code == "token_revoked"


# ------------------------------------------------------------- aud and iss
def test_audience_and_issuer_are_enforced(flow, user, web_app, keyring):
    tokens = flow.run()
    token = tokens["access_token"]
    assert decode_access_token(token, audience=AUD_ID)["sub"] == str(user.public_id)
    with pytest.raises(InvalidAccessToken, match="audience"):
        decode_access_token(token, audience=AUD_AI)        # ai:invoke not granted
    claims = decode_access_token(token, audience=AUD_ID)
    with pytest.raises(InvalidAccessToken, match="issuer"):
        decode_access_token(sign_access_token(dict(claims, iss="https://evil.example")), audience=AUD_ID)
    # An ID token is never an access token: wrong typ, and its kid is an RSA key.
    with pytest.raises(InvalidAccessToken):
        decode_access_token(tokens["id_token"], audience=AUD_ID)


def test_a_token_signed_by_another_key_is_refused(flow, keyring):
    tokens = flow.run()
    claims = decode_access_token(tokens["access_token"], audience=AUD_ID)
    attacker = keys.signing_key_from_private(keys.ALG_ES256, keys.generate_private_key(keys.ALG_ES256))
    # Same kid as the real key, attacker's signature.
    forged = pyjwt.encode(claims, attacker.private_pem, algorithm="ES256",
                          headers={"kid": keyring.active_es256.kid, "typ": "at+jwt"})
    with pytest.raises(InvalidAccessToken, match="verification failed"):
        decode_access_token(forged, audience=AUD_ID)
    # Unknown kid.
    forged = pyjwt.encode(claims, attacker.private_pem, algorithm="ES256",
                          headers={"kid": attacker.kid, "typ": "at+jwt"})
    with pytest.raises(InvalidAccessToken, match="unknown kid"):
        decode_access_token(forged, audience=AUD_ID)
    # alg confusion: an HS256 token under the real kid. The verifier pins
    # ES256 for that key, whatever the header claims.
    forged = pyjwt.encode(claims, "a" * 32, algorithm="HS256",
                          headers={"kid": keyring.active_es256.kid, "typ": "at+jwt"})
    with pytest.raises(InvalidAccessToken):
        decode_access_token(forged, audience=AUD_ID)


def test_a_retired_key_still_verifies_and_the_jwks_lists_it(flow, settings):
    """Rotation (spec §6.1): tokens minted before the rotation verify from
    the JWKS for as long as the predecessor stays published."""
    tokens = flow.run()
    old = keys.get_keyring()
    new_es = keys.private_key_to_pem(keys.generate_private_key(keys.ALG_ES256))
    settings.OIDC_ES256_PRIVATE_KEYS = new_es + "\n" + old.active_es256.private_pem.decode()
    settings.OIDC_RS256_PRIVATE_KEYS = old.active_rs256.private_pem.decode()
    keys.reset()
    try:
        ring = keys.get_keyring()
        assert ring.active_es256.kid != old.active_es256.kid
        kids = [k["kid"] for k in APIClient().get("/api/oauth/jwks").json()["keys"]]
        assert kids[:2] == [ring.active_es256.kid, old.active_es256.kid]
        assert decode_access_token(tokens["access_token"], audience=AUD_ID)
        assert userinfo(tokens["access_token"]).status_code == 200
        # A new token is signed by the new key.
        header = pyjwt.get_unverified_header(flow.run()["access_token"])
        assert header["kid"] == ring.active_es256.kid
    finally:
        keys.install(old)


# ------------------------------------------------- silent grants (spec §5)
def test_a_loopback_client_never_gets_money_scopes_silently(loopback_flow, loopback_app, user):
    loopback_flow.run(spend_cap_2z=100, cap_period="month")       # a grant now exists
    silent = loopback_flow.evaluate(prompt="none").json()
    assert silent["action"] == "redirect"
    assert query_of(silent["redirect_to"])["error"] == "interaction_required"
    # Without prompt=none the same request shows the consent screen again.
    assert loopback_flow.evaluate().json()["action"] == "consent"
    # But openid alone, which is not a money scope, is granted silently.
    only_openid = loopback_flow.evaluate(prompt="none", scope="openid").json()
    assert only_openid["action"] == "approve"
    assert loopback_flow.decide(only_openid).json()["action"] == "redirect"


def test_a_private_scheme_client_is_treated_like_loopback(signed_in, user, loopback_app):
    from .conftest import PRIVATE_SCHEME_REDIRECT

    flow = Flow(signed_in, user, loopback_app, redirect_uri=PRIVATE_SCHEME_REDIRECT,
                scope="openid purchase:create")
    flow.run()
    assert query_of(flow.evaluate(prompt="none").json()["redirect_to"])["error"] == "interaction_required"


def test_a_web_client_with_an_existing_grant_is_approved_silently(signed_in, user, web_app):
    """Negative control for the loopback rule."""
    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT,
                scope="openid offline_access ai:invoke")
    flow.run(spend_cap_2z=100, cap_period="month")
    silent = flow.evaluate(prompt="none").json()
    assert silent["action"] == "approve"
    code_url = flow.decide(silent).json()["redirect_to"]
    assert "code" in query_of(code_url)
    assert flow.evaluate().json()["action"] == "approve"
    assert flow.evaluate(prompt="consent").json()["action"] == "consent"


def test_prompt_none_without_a_session_is_login_required(api_client, web_app, user):
    flow = Flow(api_client, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid")
    anonymous = flow.evaluate().json()
    assert set(anonymous) == {"action", "reason", "login_ticket"}
    assert (anonymous["action"], anonymous["reason"]) == ("login", "login_required")
    silent = flow.evaluate(prompt="none").json()
    assert query_of(silent["redirect_to"])["error"] == "login_required"
    assert api_client.post("/api/oauth/authorize", {"request_id": "x", "authorization_request": flow.params(), "allow": True}, format="json").status_code in (401, 403)


# --------------------------------------------------- request validation
def test_request_rules_of_the_contract(flow):
    def error_of(**overrides):
        body = flow.evaluate(**overrides).json()
        assert body["action"] == "redirect", body
        return query_of(body["redirect_to"])["error"]

    assert error_of(state="short") == "invalid_request"
    assert error_of(nonce=None) == "invalid_request"            # openid needs nonce
    assert error_of(response_type="token") in (
        "unsupported_response_type", "unauthorized_client", "invalid_request",
    )
    assert error_of(response_mode="fragment") == "invalid_request"
    assert error_of(scope="openid admin:all") == "invalid_scope"
    assert error_of(prompt="none login") == "invalid_request"
    assert error_of(acr_values="urn:example:gold") == "invalid_request"
    # A client_id or redirect_uri that cannot be trusted never redirects.
    fatal = flow.evaluate(redirect_uri="https://evil.example/cb")
    assert fatal.status_code == 400 and fatal.json()["error"] in ("invalid_request", "mismatching_redirect_uri")
    fatal = flow.evaluate(client_id="nope")
    assert fatal.status_code == 400


def test_the_consent_post_is_bound_to_the_evaluated_request(flow, creator_factory):
    evaluated = flow.evaluate().json()
    # Another user cannot spend this request_id.
    other = APIClient()
    other.force_login(creator_factory(username="mallory"))
    stolen = other.post("/api/oauth/authorize", {
        "request_id": evaluated["request_id"],
        "authorization_request": evaluated["authorization_request"],
        "allow": True,
    }, format="json")
    assert stolen.status_code == 400
    assert not AppAuthorization.objects.filter(user__username="mallory").exists()
    # The parameters cannot change under it.
    evaluated["authorization_request"]["scope"] = "openid profile email offline_access"
    assert flow.decide(evaluated).status_code == 400
    # Granted scopes must be a subset of the request.
    evaluated = flow.evaluate().json()
    widened = flow.decide(evaluated, scope=["openid", "ai:invoke"])
    assert widened.status_code == 400 and widened.json()["error"] == "invalid_scope"
    # A subset is fine, and the grant records exactly that.
    narrowed = flow.decide(flow.evaluate().json(), scope=["openid"])
    assert narrowed.status_code == 200
    assert AppAuthorization.objects.get(user=flow.user, application=flow.app).scope == "openid"


# ---------------------------------------------------- consent semantics
def test_reconsent_when_the_effective_markup_rises(flow, web_app, user):
    flow.run()
    assert flow.evaluate().json()["action"] == "approve"
    web_app.markup_bps = 1500
    web_app.save()                                 # requested, not yet approved
    assert flow.evaluate().json()["action"] == "approve", "pending markup changes nothing"
    web_app.approved_markup_bps = 1500
    web_app.save()                                 # approval raises the EFFECTIVE markup
    evaluated = flow.evaluate().json()
    assert evaluated["action"] == "consent"
    assert evaluated["consent"]["application"]["markup_bps"] == 1500
    flow.decide(evaluated)
    assert AppAuthorization.objects.get(user=user, application=web_app).markup_bps == 1500
    web_app.approved_markup_bps = 500
    web_app.save()                                 # lowering never re-prompts
    assert flow.evaluate().json()["action"] == "approve"


def test_raising_a_spend_cap_requires_recent_authentication(signed_in, user, web_app):
    from dj.apps.identity.models import AuthContext

    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid ai:invoke")
    flow.run(spend_cap_2z=100, cap_period="month")

    def reconsent(**kwargs):
        evaluated = flow.evaluate(prompt="consent").json()
        assert evaluated["action"] == "consent"
        # Re-consent pre-selects the EXISTING cap (spec §5).
        current = AppAuthorization.objects.get(user=user, application=web_app)
        assert evaluated["consent"]["spend_cap"] == {
            "spend_cap_2z": current.spend_cap_2z, "cap_period": current.cap_period,
        }
        assert evaluated["consent"]["is_raise_step_up_required"] is True
        return flow.decide(evaluated, **kwargs)

    # No recorded authentication time: a raise fails closed with RFC 9470.
    raised = reconsent(spend_cap_2z=200, cap_period="month")
    assert raised.status_code == 401
    assert raised.json()["code"] == "insufficient_user_authentication"
    assert 'error="insufficient_user_authentication"' in raised["WWW-Authenticate"]
    assert 'max_age="300"' in raised["WWW-Authenticate"]
    shortened = reconsent(spend_cap_2z=100, cap_period="day")     # same amount, shorter period
    assert shortened.status_code == 401
    # A LONGER period too, and even with a smaller amount: the ledger counts
    # spend per window, so a new period starts an empty one.
    lengthened = reconsent(spend_cap_2z=100, cap_period="total")
    assert lengthened.status_code == 401
    assert lengthened.json()["code"] == "insufficient_user_authentication"
    lengthened_and_lowered = reconsent(spend_cap_2z=50, cap_period="total")
    assert lengthened_and_lowered.status_code == 401
    uncapped = reconsent(spend_cap_2z=None, cap_period="month")
    assert uncapped.status_code == 401
    grant = AppAuthorization.objects.get(user=user, application=web_app)
    assert (grant.spend_cap_2z, grant.cap_period) == (100, "month")
    # Lowering needs nothing.
    lowered = reconsent(spend_cap_2z=50, cap_period="month")
    assert lowered.status_code == 200
    # With a fresh AuthContext for this session, the raise goes through and
    # the tokens carry auth_time.
    AuthContext.objects.record(
        user, kind="session", key=signed_in.session.session_key,
        auth_time=timezone.now(), amr=["pwd"], acr="urn:f2z:acr:1fa",
        account_epoch=user.kt_account_epoch, credential_expires_at=None,
    )
    raised = reconsent(spend_cap_2z=200, cap_period="month")
    assert raised.status_code == 200, raised.content
    grant.refresh_from_db()
    assert grant.spend_cap_2z == 200
    tokens = flow.exchange(query_of(raised.json()["redirect_to"])["code"]).json()
    claims = decode_access_token(tokens["access_token"], audience=AUD_AI)
    assert "auth_time" in claims and claims["acr"] == "urn:f2z:acr:1fa" and claims["amr"] == ["pwd"]


def test_the_spend_cap_never_fails_open(signed_in, user, web_app, developer):
    """A first consent granting ai:invoke must carry the user's cap choice;
    the pre-selection is an optional per-user suggestion, never a shared quota."""
    from dj.apps.oidc.models import F2ZApplication
    from dj.apps.oidc.scopes import PLATFORM_DEFAULT_SPEND_CAP_2Z

    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid ai:invoke")
    evaluated = flow.evaluate().json()
    # The developer suggests 100/month; the user may choose differently.
    assert evaluated["consent"]["spend_cap"] == {"spend_cap_2z": 100, "cap_period": "month"}
    # Omitting the cap on a first ai:invoke consent is refused, and no grant exists.
    omitted = flow.decide(evaluated)
    assert omitted.status_code == 400 and omitted.json()["error"] == "invalid_request"
    assert "spend_cap_2z" in omitted.json()["error_description"]
    assert not AppAuthorization.objects.filter(user=user, application=web_app).exists()
    # An explicit null is a choice: no cap.
    chosen = flow.decide(flow.evaluate().json(), spend_cap_2z=None, cap_period="month")
    assert chosen.status_code == 200
    grant = AppAuthorization.objects.get(user=user, application=web_app)
    assert grant.spend_cap_2z is None
    # Re-consent pre-selects the EXISTING cap (null here) and may omit it.
    evaluated = flow.evaluate(prompt="consent").json()
    assert evaluated["consent"]["spend_cap"] == {"spend_cap_2z": None, "cap_period": "month"}
    assert flow.decide(evaluated).status_code == 200
    grant.refresh_from_db()
    assert grant.spend_cap_2z is None

    # A larger developer suggestion is not clamped by a platform budget.
    greedy = F2ZApplication.objects.create(
        name="Greedy", user=developer, client_type="public",
        redirect_uris="https://greedy.example.com/cb", allowed_scopes="openid ai:invoke",
        default_spend_cap_2z=50_000, default_cap_period="day",
    )
    greedy_flow = Flow(signed_in, user, greedy, redirect_uri="https://greedy.example.com/cb",
                       scope="openid ai:invoke")
    pre = greedy_flow.evaluate().json()["consent"]["spend_cap"]
    assert pre == {"spend_cap_2z": 50_000, "cap_period": "day"}
    uncapped = F2ZApplication.objects.create(
        name="Uncapped", user=developer, client_type="public",
        redirect_uris="https://uncapped.example.com/cb", allowed_scopes="openid ai:invoke",
        default_spend_cap_2z=None,
    )
    uncapped_flow = Flow(signed_in, user, uncapped, redirect_uri="https://uncapped.example.com/cb",
                         scope="openid ai:invoke")
    pre = uncapped_flow.evaluate().json()["consent"]["spend_cap"]
    assert pre == {"spend_cap_2z": PLATFORM_DEFAULT_SPEND_CAP_2Z, "cap_period": "month"}
    # The user may still explicitly choose higher.
    assert uncapped_flow.decide(uncapped_flow.evaluate().json(), spend_cap_2z=50_000, cap_period="day").status_code == 200
    assert AppAuthorization.objects.get(user=user, application=uncapped).spend_cap_2z == 50_000
    # Negative control: without ai:invoke the cap key is not required.
    plain = Flow(signed_in, user, greedy, redirect_uri="https://greedy.example.com/cb", scope="openid")
    assert plain.decide(plain.evaluate(prompt="consent").json()).status_code == 200


def test_max_age_and_prompt_login_fail_closed_without_an_auth_context(flow):
    unknown = flow.evaluate(max_age="300").json()
    assert (unknown["action"], unknown["reason"]) == ("login", "the session's authentication time is unknown")
    assert flow.evaluate(prompt="login").json()["action"] == "login"
    silent = flow.evaluate(prompt="none", max_age="300").json()
    assert query_of(silent["redirect_to"])["error"] == "login_required"


def test_scope_reduction_on_reconsent_bumps_the_generation(flow, user, web_app):
    tokens = flow.run()
    assert userinfo(tokens["access_token"]).status_code == 200
    evaluated = flow.evaluate(prompt="consent").json()
    assert flow.decide(evaluated, scope=["openid", "offline_access"]).status_code == 200
    grant = AppAuthorization.objects.get(user=user, application=web_app)
    assert grant.generation == 2 and grant.scope == "openid offline_access"
    assert userinfo(tokens["access_token"]).status_code == 401       # agen is behind
    # A refresh that names no scope is narrowed to the grant's CURRENT
    # scopes automatically (spec §5: reduction takes effect immediately)...
    refreshed = flow.refresh(tokens["refresh_token"])
    assert refreshed.status_code == 200, refreshed.content
    assert refreshed.json()["scope"] == "openid offline_access"
    claims = decode_access_token(refreshed.json()["access_token"], audience=AUD_ID)
    assert claims["scope"] == "openid offline_access" and claims["agen"] == 2
    assert userinfo(refreshed.json()["access_token"]).status_code == 200
    #...an explicit narrower request is fine, and an explicit request for
    # the reduced-away scope is invalid_scope.
    narrower = flow.refresh(refreshed.json()["refresh_token"], scope="openid")
    assert narrower.status_code == 200 and narrower.json()["scope"] == "openid"
    wider = flow.refresh(narrower.json()["refresh_token"], scope="openid profile")
    assert wider.status_code == 400 and wider.json()["error"] == "invalid_scope"


def test_minting_publishes_aep_and_agen_for_the_gateway(flow, user, web_app, django_capture_on_commit_callbacks):
    """The gateway's map is warm for every token's lifetime; the internal
    endpoint is a fallback, not the path every first request takes."""
    from dj.apps.oidc.epoch_publish import read_account_epoch, read_grant_generation

    assert read_account_epoch(user.public_id) is None
    with django_capture_on_commit_callbacks(execute=True):
        tokens = flow.run()
    claims = decode_access_token(tokens["access_token"], audience=AUD_ID)
    assert read_account_epoch(user.public_id) == claims["aep"] == 1
    assert read_grant_generation(user.public_id, web_app.client_id) == claims["agen"] == 1
    # A refresh publishes too, at whatever the current values are.
    from django.core.cache import caches
    caches["default"].clear()
    with django_capture_on_commit_callbacks(execute=True):
        assert flow.refresh(tokens["refresh_token"]).status_code == 200
    assert read_account_epoch(user.public_id) == 1
    assert read_grant_generation(user.public_id, web_app.client_id) == 1


def test_a_frozen_app_cannot_authorize_and_its_tokens_die(flow, web_app):
    tokens = flow.run()
    web_app.frozen = True
    web_app.save()
    # A frozen client is not a client at all: fatal, no redirect (the
    # library refuses to load it), and no token exchange either.
    refused = flow.evaluate()
    assert refused.status_code == 400
    assert refused.json()["error"] in ("invalid_client", "invalid_request")
    assert userinfo(tokens["access_token"]).status_code == 401
    assert flow.refresh(tokens["refresh_token"]).status_code in (400, 401)


def test_the_zcash_assertion_grant_is_reserved(web_app):
    response = form_post(APIClient(), "/api/oauth/token", {
        "grant_type": "urn:f2z:grant-type:zcash-signature", "client_id": web_app.client_id,
    })
    assert response.status_code == 400
    assert response.json()["error"] == "unsupported_grant_type"


def test_access_token_claims_helper_matches_the_spec_shape(user, web_app):
    from dj.apps.oidc.tokens import TokenContext

    context = TokenContext(user=user, application=web_app, scopes=("openid", "ai:invoke"),
                           account_epoch=4, grant_generation=2, auth_time=None, acr="", amr=())
    claims = access_token_claims(context, now=1_790_000_000)
    assert claims["exp"] == 1_790_000_300
    assert claims["aud"] == ["f2z-id", "f2z-ai", "f2z-api"]
    assert set(claims) == {"iss", "sub", "aud", "client_id", "scope", "iat", "exp", "jti", "aep", "agen", "app_id"}


def test_developer_suggestion_changes_do_not_replace_existing_user_budget(signed_in, user, web_app):
    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid ai:invoke")
    flow.run(spend_cap_2z=250, cap_period="week")
    grant = AppAuthorization.objects.get(user=user, application=web_app)
    original_generation = grant.generation
    for suggestion in (None, 5000):
        web_app.default_spend_cap_2z = suggestion
        web_app.default_cap_period = "day"
        web_app.save(update_fields=["default_spend_cap_2z", "default_cap_period"])
        response = flow.evaluate(prompt="consent").json()
        assert response["consent"]["spend_cap"] == {"spend_cap_2z": 250, "cap_period": "week"}
        assert flow.decide(response).status_code == 200
        grant.refresh_from_db()
        assert (grant.spend_cap_2z, grant.cap_period, grant.generation) == (250, "week", original_generation)


def test_non_ai_first_consent_does_not_invent_a_budget(flow, user, web_app):
    web_app.default_spend_cap_2z = None
    web_app.save(update_fields=["default_spend_cap_2z"])
    flow.run()
    grant = AppAuthorization.objects.get(user=user, application=web_app)
    assert (grant.spend_cap_2z, grant.cap_period) == (None, "month")


def test_removing_ai_scope_preserves_explicit_uncapped_period(signed_in, user, web_app):
    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid ai:invoke")
    flow.run(spend_cap_2z=None, cap_period="week")
    flow.scope = "openid"
    response = flow.evaluate(prompt="consent").json()
    assert flow.decide(response).status_code == 200
    grant = AppAuthorization.objects.get(user=user, application=web_app)
    assert (grant.spend_cap_2z, grant.cap_period, grant.scope) == (None, "week", "openid")


def test_first_ai_upgrade_requires_its_own_explicit_spend_decision(signed_in, user, web_app):
    web_app.default_spend_cap_2z = None
    web_app.save(update_fields=["default_spend_cap_2z"])
    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid")
    flow.run()
    grant = AppAuthorization.objects.get(user=user, application=web_app)
    assert (grant.scope, grant.spend_cap_2z) == ("openid", None)
    flow.scope = "openid ai:invoke"
    evaluated = flow.evaluate().json()
    missing = flow.decide(evaluated)
    assert missing.status_code == 400
    assert missing.json()["error"] == "invalid_request"
    grant.refresh_from_db()
    assert (grant.scope, grant.spend_cap_2z) == ("openid", None)
    explicit = flow.decide(flow.evaluate().json(), spend_cap_2z=None, cap_period="month")
    assert explicit.status_code == 200
    grant.refresh_from_db()
    assert (grant.scope, grant.spend_cap_2z) == ("openid ai:invoke", None)
    # A revoked AI grant also cannot supply the missing permission decision.
    from django.utils.timezone import now
    grant.revoked_at = now()
    grant.save(update_fields=["revoked_at"])
    assert flow.decide(flow.evaluate().json()).status_code == 400
    grant.refresh_from_db()
    assert grant.revoked_at is not None
