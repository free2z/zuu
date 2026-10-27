"""CANONICAL_ORIGIN is validated before it can misdirect a paying user.

`views.py` builds Stripe's `success_url`/`cancel_url` by concatenating a
request path onto `CANONICAL_ORIGIN`, so a value with a path or a bad scheme
sends the payer somewhere that does not exist *after* the money moves. The
value comes from the per-namespace k8s ConfigMap, which no build-time command
sees, so a check is the only thing standing between a ConfigMap typo and that
outcome.

This check exists because taking `dj.apps.efm` offline  unregistered the
WebAuthn relying-party check, which had been validating `CANONICAL_ORIGIN` by
accident via `prod_settings.WEBAUTHN_EXPECTED_ORIGINS = [CANONICAL_ORIGIN]`.
"""

import pytest
from django.core import checks
from django.test.utils import override_settings

from dj.apps.ztripe.checks import (
    check_canonical_origin,
    check_native_return_origin,
)


def ids(messages):
    return {m.id for m in messages}


def run(origin):
    with override_settings(CANONICAL_ORIGIN=origin):
        return ids(check_canonical_origin(None))


def test_the_check_is_registered():
    """A check nobody runs is not a guard. This is the point of the file."""
    registered = checks.registry.registry.get_checks(include_deployment_checks=True)
    assert check_canonical_origin in registered
    assert check_native_return_origin in registered


@pytest.mark.parametrize(
    ("canonical", "native_return"),
    [
        (
            "https://free2z.cash",
            "https://checkout-return.free2z.cash",
        ),
        (
            "https://stage.free2z.cash",
            "https://checkout-return.stage.free2z.cash",
        ),
        ("http://localhost:3000", "http://localhost:3000"),
    ],
)
def test_native_return_origin_accepts_dedicated_deployment_hosts(
    canonical, native_return
):
    with override_settings(
        CANONICAL_ORIGIN=canonical,
        ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN=native_return,
    ):
        assert check_native_return_origin(None) == []


@pytest.mark.parametrize(
    "native_return",
    [
        "https://stage.free2z.cash",
        "https://other.stage.free2z.cash",
        "http://checkout-return.stage.free2z.cash",
        "https://checkout-return.stage.free2z.cash/path",
        "https://checkout-return.stage.free2z.cash:8443",
        "https://[",
        "",
    ],
)
def test_native_return_origin_rejects_nonisolated_or_malformed_hosts(
    native_return,
):
    with override_settings(
        CANONICAL_ORIGIN="https://stage.free2z.cash",
        ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN=native_return,
    ):
        assert ids(check_native_return_origin(None)) == {"ztripe.E009"}


def test_passes_on_the_real_settings():
    assert check_canonical_origin(None) == []


@pytest.mark.parametrize(
    "origin",
    [
        "https://free2z.cash",
        "https://stage.free2z.cash",
        "http://localhost:3000",  # the local-development default
        "http://127.0.0.1:8000",
    ],
)
def test_accepts_real_deployment_values(origin):
    assert run(origin) == set()


@pytest.mark.parametrize("blank", ["", "   ", None, 3])
def test_flags_a_missing_or_non_string_value(blank):
    assert "ztripe.E001" in run(blank)


@pytest.mark.parametrize("origin", ["free2z.cash", "//free2z.cash", "/app"])
def test_flags_a_value_that_is_not_an_absolute_origin(origin):
    assert "ztripe.E002" in run(origin)


@pytest.mark.parametrize(
    "origin",
    [
        # The exact case codex raised: a ConfigMap that gains a path prefix.
        "https://stage.free2z.cash/app",
        "https://free2z.cash?utm=x",
        "https://free2z.cash#frag",
        "https://user@free2z.cash",
    ],
)
def test_flags_anything_past_the_authority(origin):
    assert "ztripe.E003" in run(origin)


def test_flags_a_misspelled_scheme():
    assert "ztripe.E004" in run("htps://free2z.cash")


def test_flags_a_non_numeric_port():
    assert "ztripe.E005" in run("https://free2z.cash:nope")


def test_flags_plain_http_off_localhost():
    assert "ztripe.E006" in run("http://free2z.cash")


@pytest.mark.parametrize(
    "origin",
    ["https://free2z.cash ", " https://free2z.cash", "https://free2z.cash\t"],
)
def test_flags_whitespace_because_nothing_strips_it_at_runtime(origin):
    """settings.py only rstrips '/', and views.py uses the value verbatim.

    Validating a `.strip()`ed copy would certify a value production never
    sees, so the check looks at the raw setting.
    """
    assert "ztripe.E007" in run(origin)


def test_the_checked_value_is_the_value_the_view_would_use():
    """Guards the above: the check and `_checkout_return_origin` must agree."""
    from dj.apps.ztripe.views import _checkout_return_origin

    class _Req:
        headers: dict = {}

    with override_settings(CANONICAL_ORIGIN="https://free2z.cash ",
                           CSRF_TRUSTED_ORIGINS=[]):
        assert _checkout_return_origin(_Req()) == "https://free2z.cash "
        assert "ztripe.E007" in ids(check_canonical_origin(None))


def test_a_trailing_slash_is_flagged_rather_than_silently_doubling_the_slash():
    """settings.py rstrips it, but an override or a future reader may not.

    'https://free2z.cash/' + '/checkout' is '//checkout' on the host, which is
    a protocol-relative URL to a host named 'checkout'.
    """
    assert "ztripe.E003" in run("https://free2z.cash/")
