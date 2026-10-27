"""Test-only URLconf that mounts the (offline) EFM router.

`dj/free2z/urls.py` no longer includes `dj.apps.efm.urls` -- the app is
OFFLINE, see `dj/apps/efm/__init__.py`. The WebAuthn relying-party tests still
need to drive the real views over HTTP, because the thing under test is the
arguments handed to the `py_webauthn` verifier before a public key is
persisted. They point `ROOT_URLCONF` here rather than at the project's, so the
coverage survives the unrouting and would still be there if the app is ever
re-enabled.

Nothing in production imports this module.
"""

from django.urls import include, path

urlpatterns = [
    path("api/efm/", include("dj.apps.efm.urls")),
]
