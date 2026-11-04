import re
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from dj.apps.ztripe.views import STRIPE_API_VERSION
from dj.free2z.settings import _parse_stripe_checkout_allowed_hosts


CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_preflight"


def _session(create, url=CHECKOUT_URL):
    create.return_value.id = "cs_test_preflight"
    create.return_value.url = url


def test_checkout_host_preflight_verifies_and_expires_live_session(settings):
    settings.STRIPE_SECRET_KEY = "sk_test_preflight"
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = frozenset({"checkout.stripe.com"})
    output = StringIO()

    with (
        patch(
            "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
            "stripe.checkout.Session.create"
        ) as create,
        patch(
            "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
            "stripe.checkout.Session.expire"
        ) as expire_session,
    ):
        _session(create)
        call_command("verify_stripe_checkout_host", stdout=output)

    expire_session.assert_called_once()
    assert expire_session.call_args.args == ("cs_test_preflight",)
    assert "Verified live Stripe Checkout host: checkout.stripe.com" in output.getvalue()

    # The preflight must talk to Stripe exactly the way buyer traffic does --
    # same pinned wire contract, same no-retry boundary, same explicit key --
    # and must carry an idempotency key so an ambiguous failure is recoverable
    # instead of leaving a second live Session behind.
    create_kwargs = create.call_args.kwargs
    assert create_kwargs["stripe_version"] == STRIPE_API_VERSION
    assert create_kwargs["max_network_retries"] == 0
    assert create_kwargs["api_key"] == "sk_test_preflight"
    assert create_kwargs["idempotency_key"].startswith(
        "free2z-checkout-host-preflight-"
    )
    assert expire_session.call_args.kwargs["stripe_version"] == STRIPE_API_VERSION
    assert expire_session.call_args.kwargs["max_network_retries"] == 0


def test_checkout_host_preflight_candidate_custom_domain(settings):
    settings.STRIPE_SECRET_KEY = "sk_test_preflight"
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = frozenset()

    with (
        patch(
            "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
            "stripe.checkout.Session.create"
        ) as create,
        patch(
            "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
            "stripe.checkout.Session.expire"
        ) as expire_session,
    ):
        _session(create, "https://pay.free2z.cash/c/pay/cs_test_preflight")
        call_command(
            "verify_stripe_checkout_host",
            expected_host="pay.free2z.cash",
        )

    assert expire_session.call_args.args == ("cs_test_preflight",)


def test_checkout_host_preflight_rejects_mismatch_after_expiring_session(settings):
    settings.STRIPE_SECRET_KEY = "sk_test_preflight"
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = frozenset({"checkout.stripe.com"})

    with (
        patch(
            "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
            "stripe.checkout.Session.create"
        ) as create,
        patch(
            "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
            "stripe.checkout.Session.expire"
        ) as expire_session,
    ):
        _session(create, "https://pay.free2z.cash/c/pay/cs_test_preflight")
        with pytest.raises(CommandError, match="outside the expected policy"):
            call_command("verify_stripe_checkout_host")

    expire_session.assert_called_once()
    assert expire_session.call_args.args == ("cs_test_preflight",)


def test_checkout_host_preflight_reports_session_when_expiry_fails(settings):
    settings.STRIPE_SECRET_KEY = "sk_test_preflight"
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = frozenset({"checkout.stripe.com"})

    with (
        patch(
            "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
            "stripe.checkout.Session.create"
        ) as create,
        patch(
            "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
            "stripe.checkout.Session.expire",
            side_effect=RuntimeError("provider unavailable"),
        ),
    ):
        _session(create)
        with pytest.raises(CommandError, match="expire cs_test_preflight"):
            call_command("verify_stripe_checkout_host")


def test_checkout_host_preflight_fails_before_stripe_when_policy_is_empty(settings):
    settings.STRIPE_SECRET_KEY = "sk_test_preflight"
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = frozenset()

    with patch(
        "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
        "stripe.checkout.Session.create"
    ) as create:
        with pytest.raises(CommandError, match="policy is unavailable"):
            call_command("verify_stripe_checkout_host")

    create.assert_not_called()


@pytest.mark.parametrize(
    "expected_host",
    ["", "checkout.stripe.com,", "https://checkout.stripe.com", "*.stripe.com"],
)
def test_checkout_host_preflight_rejects_malformed_candidate_host(
    settings, expected_host
):
    settings.STRIPE_SECRET_KEY = "sk_test_preflight"

    with patch(
        "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
        "stripe.checkout.Session.create"
    ) as create:
        with pytest.raises(CommandError, match="one exact DNS hostname"):
            call_command(
                "verify_stripe_checkout_host",
                expected_host=expected_host,
            )

    create.assert_not_called()


# The hosted-checkout host is pinned in five places: the deployed ConfigMap,
# this backend's fallback, and a re-check in every client that navigates
# (SvelteKit form action, SvelteKit page, classic React, and native ZUULI in
# free2z/zuu, which this repo cannot see).
#
# The expensive direction is widening the BACKEND first: it opens a
# CheckoutIntent and creates a live Session on a host every already-loaded tab,
# cached bundle and un-upgraded ZUULI install then refuses to navigate to. No
# card completes and abandoned Sessions accumulate. Widening a CLIENT first
# costs nothing -- it accepts a host the backend never returns yet. So the
# invariant is a subset, not equality, and the compatibility release ships
# first.
#
# ts/svelte/free2z/tests/stripe-checkout-url.test.mjs asserts the same
# invariant, but CI's path filter only runs it for a `ts/` change. This is the
# other direction: `py/*` and `k8s/free2z/config.yaml` run the `backend` job,
# so a backend-side widening cannot merge either. Both are needed; neither
# alone closes the loop.
_REPO_ROOT = Path(__file__).resolve().parents[5]
_CLIENT_HOST_PINS = (
    "ts/svelte/free2z/src/routes/[username]/dashboard/billing/+page.server.ts",
    "ts/svelte/free2z/src/routes/[username]/dashboard/billing/+page.svelte",
    "ts/react/free2z/src/components/StripeCheckoutButton.tsx",
)

_HOST_MOVE_HINT = (
    "Widen the CLIENTS first (a client may accept more than one host), ship "
    "that, then widen the deployed allowlist -- never the other way round. "
    "And remember the ZUULI client in free2z/zuu, which nothing here can see. "
    "See docs/tuzis/README.md."
)
# Only literals inside the RETURN EXPRESSION of isStripeHostedCheckoutUrl
# count. Scanning the whole file would accept a host named in a comment, a dead
# branch, a `CHECKOUT_HOSTS` array the predicate never consults, or an
# unrelated hostname check -- and "the new host appears somewhere in the file"
# is not evidence the client would navigate there. That false evidence is
# exactly how a compatibility PR could widen the deployed allowlist on the
# strength of a change that does nothing, producing the silent outage these
# tests exist to prevent.
#
# A two-host compatibility release therefore writes two comparisons inside that
# expression (`parsed.hostname === "a" || parsed.hostname === "b"`). A genuine
# refactor to a set lookup makes these assertions fail loudly rather than
# quietly believe something -- update the guard in that PR, deliberately.
_CLIENT_PIN_PATTERN = re.compile(r'parsed\.hostname === "([^"]+)"')
_PREDICATE = "function isStripeHostedCheckoutUrl"


def _balanced(source, start, opener, closer, what, relative_path):
    depth = 0
    for index in range(start, len(source)):
        if source[index] == opener:
            depth += 1
        elif source[index] == closer:
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError(f"{relative_path}: unbalanced {what} in {_PREDICATE}")


def _predicate_return_expression(relative_path):
    """Return only the `return ( ... )` of the host check, as source text."""
    source = (_REPO_ROOT / relative_path).read_text(encoding="utf-8")
    assert _PREDICATE in source, (
        f"{relative_path} no longer defines {_PREDICATE}; it is the only thing "
        "standing between a provider-chosen URL and window.location.assign."
    )
    body_start = source.index("{", source.index(_PREDICATE))
    body = _balanced(source, body_start, "{", "}", "braces", relative_path)

    assert "return (" in body, (
        f"{relative_path}: {_PREDICATE} no longer returns a single "
        "parenthesised expression. Update this guard in the same PR -- it "
        "must read the predicate that actually gates navigation."
    )
    expr_start = body.index("(", body.index("return ("))
    return _balanced(body, expr_start, "(", ")", "parentheses", relative_path)


def _client_accepted_hosts(relative_path):
    expression = _predicate_return_expression(relative_path)
    accepted = frozenset(_CLIENT_PIN_PATTERN.findall(expression))
    assert accepted, (
        f"{relative_path}: {_PREDICATE} does not compare parsed.hostname "
        "against any exact hostname literal in its return expression."
    )
    return accepted








@pytest.mark.parametrize("relative_path", _CLIENT_HOST_PINS)
def test_backend_default_is_accepted_by_every_client(relative_path):
    """The fallback must never be a host the shipped clients would refuse."""
    default = _parse_stripe_checkout_allowed_hosts(None)
    accepted = _client_accepted_hosts(relative_path)
    assert default <= accepted, (
        f"{relative_path} accepts {sorted(accepted)!r} but the settings.py "
        f"fallback is {sorted(default)!r}. {_HOST_MOVE_HINT}"
    )




@pytest.mark.parametrize("session_id", [None, "", "not-a-session-id"])
def test_checkout_host_preflight_refuses_to_pass_an_unexpirable_session(
    settings, session_id
):
    """A created-but-unidentifiable Session is a cleanup task, not a success."""
    settings.STRIPE_SECRET_KEY = "sk_test_preflight"
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = frozenset({"checkout.stripe.com"})

    with (
        patch(
            "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
            "stripe.checkout.Session.create"
        ) as create,
        patch(
            "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
            "stripe.checkout.Session.expire"
        ) as expire_session,
    ):
        _session(create)
        create.return_value.id = session_id
        with pytest.raises(CommandError, match="could not be expired"):
            call_command("verify_stripe_checkout_host")

    expire_session.assert_not_called()


def test_checkout_host_preflight_reports_a_possible_orphan_on_create_failure(settings):
    """A failed CALL is not proof that no Session exists.

    The request can reach Stripe and the response be lost. The operator needs
    the idempotency key back, because rerunning with it returns the SAME
    Session (which the command can then expire) instead of creating a second
    live one at 3am.
    """
    settings.STRIPE_SECRET_KEY = "sk_test_preflight"
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = frozenset({"checkout.stripe.com"})

    with patch(
        "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
        "stripe.checkout.Session.create",
        side_effect=RuntimeError("connection reset"),
    ) as create:
        with pytest.raises(CommandError, match="MAY have been created") as excinfo:
            call_command("verify_stripe_checkout_host")

    key = create.call_args.kwargs["idempotency_key"]
    assert key in str(excinfo.value)


def test_checkout_host_preflight_reuses_a_supplied_idempotency_key(settings):
    settings.STRIPE_SECRET_KEY = "sk_test_preflight"
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = frozenset({"checkout.stripe.com"})

    with (
        patch(
            "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
            "stripe.checkout.Session.create"
        ) as create,
        patch(
            "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
            "stripe.checkout.Session.expire"
        ),
    ):
        _session(create)
        call_command(
            "verify_stripe_checkout_host",
            idempotency_key="free2z-checkout-host-preflight-retry-1",
        )

    assert create.call_args.kwargs["idempotency_key"] == (
        "free2z-checkout-host-preflight-retry-1"
    )


@pytest.mark.parametrize("bad_key", ["", "short", "has spaces in it"])
def test_checkout_host_preflight_rejects_a_malformed_idempotency_key(settings, bad_key):
    settings.STRIPE_SECRET_KEY = "sk_test_preflight"
    settings.STRIPE_CHECKOUT_ALLOWED_HOSTS = frozenset({"checkout.stripe.com"})

    with patch(
        "dj.apps.ztripe.management.commands.verify_stripe_checkout_host."
        "stripe.checkout.Session.create"
    ) as create:
        with pytest.raises(CommandError, match="idempotency-key"):
            call_command("verify_stripe_checkout_host", idempotency_key=bad_key)

    create.assert_not_called()
