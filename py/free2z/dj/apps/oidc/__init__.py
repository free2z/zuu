"""Free2Z as an OAuth 2.0 / OpenID Connect identity provider (sdk-v1 I3).

The contract is zuu ``docs/free2z/sdk/spec/oidc.md`` (amended by zuu#1055 for markup
approval). This app implements the IdP side of it on django-oauth-toolkit
3.4.1 with every model swapped into this app, so the whole provider lives in
``oidc_*`` tables and can move with the app later (: new Django apps are
self-contained).

What lives where
----------------
* ``models``          -- ``F2ZApplication`` (the registration, UUID pk),
                         ``AppAuthorization`` (the grant), and the swapped
                         token models with the epoch/generation stamps.
* ``keys``            -- the ES256 + RS256 signing key ring, loaded from the
                         environment; generated only where settings allow.
* ``tokens``          -- the ES256 ``at+jwt`` access-token generator and the
                         verifier resource servers use.
* ``validators``      -- the oauthlib validator: PKCE S256 for everyone,
                         refresh-token families with reuse detection, the
                         stale-epoch refusal, the ID-token claims.
* ``consent``         -- when consent is required, what a consent records,
                         and how a grant is revoked (``agen`` moves here).
* ``ledger_projection`` -- the seam to the ledger's ``ledger_app`` /
                         ``ledger_spend_cap`` projection (L2, not merged).
* ``epoch_publish``   -- ``aep``/``agen`` publication to Redis for resource
                         servers, with the monotonic write.
* ``authentication``  -- ``OAuth2JWTAuthentication`` for tuzi's own API:
                         default-deny on scopes.
* ``views`` / ``urls``-- DRF views for every endpoint, so all of it is in
                         ``f2z.yaml``. The consent UI is the SvelteKit
                         ``/oauth/authorize`` page.
* ``sdk_grant``       -- bearer-only current grant and exact enforcement snapshot;
                         see ``docs/free2z/sdk/GRANTS.md``.
* ``developer``       -- the developer console's API (``/developers/apps``):
                         a developer's own registrations, secret rotation.

Why the endpoints are DRF views and not django-oauth-toolkit's
--------------------------------------------------------------
The library's views are plain Django views. ``dj/apps/test_spec_coverage.py``
ratchets the set of non-DRF routes under ``/api/`` to what exists today,
because a route drf-spectacular cannot see is an endpoint with no contract and
no generated client. The DRF views here delegate to the library's
``OAuthLibMixin`` for the OAuth machinery and add the throttles, the
permission declarations the inventories require, and the JSON contract the
SvelteKit consent screen will call.
"""
