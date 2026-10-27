"""The signed AI model catalogue the f2z-ai gateway prices from.

The contract is zuu ``rs/crates/f2z-ai-proto`` -- ``src/catalog.rs``
(``Catalog``, ``verify_catalog``) and ``src/canonical.rs`` -- and
``docs/free2z/sdk/CATALOG-PRICING-AND-TIMEOUTS.md``. This module is the
platform's signer: it builds a ``Catalog`` from the ACTIVE rate card and the
``AIModel`` rows, leaves out (and alerts on) any MODEL the crate would refuse
or that would misprice -- a  per-image price on a token-billed provider
included -- refuses the whole document only for a key, card or clock problem,
and signs it::

    message   = b"free2z/ai-catalog/v1" || canonical_json(catalog)
    signature = Ed25519-Sign(catalogue key, message)      64 bytes, lowercase hex

Canonical JSON is the crate's RFC 8785 subset: integers only, magnitude
<= 2**53 - 1, object members sorted by UTF-16 code units, no whitespace, JCS
string escaping.:func:`canonical_json` reproduces it byte for byte; the
vendored crate fixture (``tests/fixtures/f2z_ai_proto/catalog/``) and the
Django-produced sample beside it pin that.

Re-signing: stateless, on request
---------------------------------

Nothing is stored and no task runs. Every request builds the catalogue from
the database and signs it; Ed25519 signing is deterministic (RFC 8032), so the
same inputs give the same bytes on every pod, and the ETag is a hash of them.

* ``version`` is in MICROSECONDS: the LATER of the start of the current
  :data:`REISSUE_SECONDS` window (ONE MINUTE) and the content revision --
  ``max(AIModel.updated_at)`` over EVERY row (including rows that just left
  the catalogue), ``max(published_at)`` over EVERY published card, and
  ``max(ProviderModel.availability_changed_at)`` (a model its provider
  started or stopped listing;:func:`content_revision`). ``issued_at`` is
  ``version`` in whole seconds.
  Pods reading the same database at the same moment compute the same value.
  **It is NOT strictly monotone**, and cannot be without shared state (a
  migration): (a) deleting the ``AIModel`` with the newest ``updated_at``
  drops that maximum; (b) two pods straddling a minute boundary, or with
  skewed clocks, serve adjacent windows in either order. Both are bounded:
  every version is ``>= window_start(now)``, and a revision is refused if it
  is more than:data:`FUTURE_REVISION_TOLERANCE_SECONDS` ahead, so a version
  can only ever be LOWER than one already served by at most
  :data:`VERSION_REGRESSION_BOUND_SECONDS` (one window + that tolerance +
  one window of pod clock skew, ~7 min). A card's ``published_at`` never
  lowers it (published cards cannot be unpublished or deleted -- migration
  0002's triggers).

  **Gateway contract (carried to the zuu gateway work):** a verifier that
  refuses every lower version as a replay is still CORRECT here -- the
  window overtakes the higher version within that bound and the newer
  content installs then -- but a change made during that bound is delayed
  by it. A gateway that wants no delay should accept a lower version that is
  within:data:`VERSION_REGRESSION_BOUND_SECONDS` of the one it holds; the
  replay protection it gives up is bounded by the same few minutes.
* Why ``version`` must move: the gateway installs only a HIGHER version.
  An equal one is ``Unchanged`` and a lower one is refused as a replay
  (``f2z-ai/src/catalog.rs`` ``State::install``). So a changed catalogue must
  carry a new, higher version, or a running gateway keeps its old copy.
* How fast a change reaches a running gateway:

  - an ``AIModel`` saved through ``save()`` -- the admin, and the
    ``is_enabled`` kill switch, partial saves included (``AIModel.save``
    always stamps ``updated_at``) -- or a card PUBLISHED: a new version on the
    very next poll (<= 30 s);
  - everything else, within ONE WINDOW (<= 60 s) plus a poll, because the
    window itself mints a new version every minute: a change that leaves no
    stamp (an ``AIModel`` DELETED or written with ``QuerySet.update()``, a
    card activated after it was published or rolled back by deactivation, a
    ``POLICY_DISABLED_PROVIDERS`` deploy), and the timestamp races no stamp
    can close -- a writer that commits AFTER a later-stamped writer (its
    stamp is not a new maximum), or a writer whose clock lags.

  One widening of that bound: a writer whose clock runs AHEAD (up to
  :data:`FUTURE_REVISION_TOLERANCE_SECONDS`, 5 min; beyond it the catalogue
  is refused as ``future_revision``) sets a maximum that later, correctly
  clocked saves do not exceed, so they wait until the window passes it --
  worst case about six minutes. Accepted (codex round 7, low severity):
  cluster clocks are NTP-synchronized to well under a second.

  Closing that last minute completely needs a revision counter serialized
  with every catalogue-affecting write -- a table, so a migration -- which
  this change deliberately does not add (codex review of; see the PR).
* The revision is read inside ONE read-only REPEATABLE READ snapshot with
  the content (:func:`build_catalog`), and before it, so a concurrent commit
  is either wholly in a catalogue or wholly absent and never lends its
  revision to content it is not part of.
* Microseconds, not seconds, so two saves in one second get two versions;
  the value stays below 2**53 until the year 2255.
* ``expires_at = issued_at + 72 h`` (:data:`VALIDITY_SECONDS`), the v1
  default -- re-issued every minute, far inside the v1 "re-sign every 24 h"
  rule. A freshly served catalogue always has more than 71 h left; the only
  way the gateway's copy drops below 48 h is that this endpoint has not
  answered it for a day, which is what the monitoring watches
  (``monitoring/alert-policies/ai-catalog-not-served.json``).
* The cost of a one-minute window: the ETag changes every minute, so a
  gateway polling every 30 s gets a 304 about half the time and re-verifies
  one signature a minute otherwise. Negligible.

Why not a periodic task: it would need somewhere to put the signed document
(a migration, or a shared cache this platform does not have), a new
procrastinate task (register-first, so a release before it could run), and it
would add a failure mode -- a stuck task -- that an on-request signer cannot
have. The cost of on-request is one small query per poll and one Ed25519
signature (~50 us).
"""
from __future__ import annotations

import datetime
import hashlib
import json
import logging
import time
from dataclasses import dataclass

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.conf import settings
from .provider_billing import TOKEN_BILLED_IMAGE_PROVIDERS

logger = logging.getLogger(__name__)

#Domain-separation prefix of the signing message (crate
#``CATALOG_SIGNING_LABEL``).
CATALOG_SIGNING_LABEL = b"free2z/ai-catalog/v1"
#The only catalogue schema the crate understands (``CATALOG_SCHEMA``).
CATALOG_SCHEMA = 1
#Every ``capabilities`` member a schema-1 model may carry, each a bool.
#``structured_output`` (zuu#1128), ``strict_tools`` (zuu#1142) and
#``reasoning_effort`` (zuu#1170) are additive: unknown to older gateways,
#which ignore them (``ModelCapabilities`` does not deny unknown members).
CAPABILITY_MEMBERS = frozenset(
    {"vision", "tools", "reasoning", "structured_output", "strict_tools",
     "reasoning_effort"})
#Every member a model's optional ``controls`` object may carry (crate
#``ModelControls``, zuu#1170). Additive: an older gateway's ``CatalogModel``
#does not deny unknown members, so it ignores the whole object.
CONTROLS_MEMBERS = frozenset({"effort_levels"})
#``controls.effort_levels`` vocabulary: every level a provider documents.
#A level the gateway's wire cannot express (``xhigh``, ``none``, ``max``)
#is kept and inert there (crate ``ModelControls::effort_levels``), so one
#newer level never makes a gateway refuse the catalogue. Same set as
#``dj.apps.openai.models.REASONING_EFFORT_LEVELS``.
EFFORT_LEVELS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max"})
#Crate ``MAX_PLATFORM_MARGIN_BPS``.
MAX_PLATFORM_MARGIN_BPS = 100_000
#Crate ``canonical::MAX_SAFE_INTEGER`` (I-JSON's bound).
MAX_SAFE_INTEGER = 9_007_199_254_740_991
#10 000 bps = 1.0; a safety factor never scales an estimate down.
BPS_DENOMINATOR = 10_000
#``ApiStyle`` values the crate can call (``Unknown`` is deserialize-only).
API_STYLES = ("openai_responses", "openai_chat", "anthropic_messages")

HOUR = 3600
#v1 (zuu docs/free2z/ai-gateway): ``expires_at = issued_at + 72 h``.
VALIDITY_SECONDS = 72 * HOUR
#How often a new ``issued_at``/``version`` is minted, whatever changed. v1
#requires at most 24 h; one minute also bounds how long any change that
#leaves no timestamp takes to reach a running gateway (module docstring).
REISSUE_SECONDS = 60
#How far ahead of this pod's clock a revision stamp may be (writer clock
#skew) before the catalogue is refused rather than signed.
FUTURE_REVISION_TOLERANCE_SECONDS = 300
#How much LOWER than an already-served version a later one can be (module
#docstring, "It is NOT strictly monotone"): a window of re-issue, the
#future tolerance, and a window of pod clock skew.
VERSION_REGRESSION_BOUND_SECONDS = 2 * REISSUE_SECONDS + FUTURE_REVISION_TOLERANCE_SECONDS
#``version`` is Unix MICROSECONDS (``issued_at`` stays in seconds).
VERSION_UNITS_PER_SECOND = 1_000_000
#v1: alert when the live catalogue has less than 48 h left.
ALERT_REMAINING_SECONDS = 48 * HOUR

#Public half of RFC 8032 section 7.1 TEST 1 -- the key the crate's fixtures
#are signed with, and whose seed is printed in the RFC. Tests only:
#:func:`load_signing_key` refuses it unless
#``settings.AI_CATALOG_ALLOW_TEST_KEY`` is set.
RFC8032_TEST1_PUBLIC_HEX = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"

#One structured line per refusal; the alert policy
#``monitoring/alert-policies/ai-catalog-refused.json`` matches it.
AI_CATALOG_REFUSED_EVENT = "ai_catalog_refused"
#One line per model left out of a catalogue (per build); alerted.
AI_CATALOG_MODEL_EXCLUDED_EVENT = "ai_catalog_model_excluded"
#One WARNING per build per enabled GA model its provider does not list
#(``AIModelQuerySet.discovered``). Not alerted: see log_model_not_discovered.
AI_CATALOG_MODEL_NOT_DISCOVERED_EVENT = "ai_catalog_model_not_discovered"
#The key is not provisioned: 404, logged, NOT alerted.
AI_CATALOG_NOT_PROVISIONED_EVENT = "ai_catalog_not_provisioned"
#Whole-document refusals the view answers 404 (not 409): only "no key yet".
NOT_PROVISIONED_REASONS = frozenset({"signing_key_unconfigured"})
#One structured line per process per clock hour per client class it serves
#(:func:`log_served_once`). The log metric ``ai_catalog_served`` counts every
#one; ``ai_catalog_served_to_gateway`` counts only ``client="f2z-ai"``, and
#``ai-catalog-not-served.json`` pages on THAT one's absence while the f2z-ai
#Deployment wants replicas.
AI_CATALOG_SERVED_EVENT = "ai_catalog_served"
#The ``User-Agent`` product token the f2z-ai gateway's catalogue poller must
#send (``User-Agent: f2z-ai/<version>``, the shape f2z-sdk already uses for
#``f2z-sdk/<version>``). It is the only thing that tells the gateway apart
#from a person, a scanner or a verification script fetching the same public
#URL -- and only the gateway holds a copy whose expiry the alert counts down.
GATEWAY_USER_AGENT_PRODUCT = "f2z-ai"
#``client`` on the served line when the request came from the gateway.
SERVED_CLIENT_GATEWAY = "f2z-ai"
#``client`` on the served line for every other caller.
SERVED_CLIENT_OTHER = "other"


class CanonicalError(ValueError):
    """A value with no canonical form (crate ``CanonicalError``)."""


class CatalogRefused(Exception):
    """The catalogue must not be published. ``reason`` is a stable code."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


# ---------------------------------------------------------------------------
# Canonical JSON -- the crate's `canonical::to_canonical_json`, in Python.
# ---------------------------------------------------------------------------

_SHORT_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def _write_string(out: list, s: str) -> None:
    out.append('"')
    for ch in s:
        esc = _SHORT_ESCAPES.get(ch)
        if esc is not None:
            out.append(esc)
        elif ord(ch) < 0x20:
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append('"')


def _utf16_key(name: str) -> bytes:
    # Big-endian UTF-16 bytes compare exactly as the sequence of code units.
    return name.encode("utf-16-be", "surrogatepass")


def _write_value(out: list, value) -> None:
    # bool before int: True is an int in Python and must not print as 1.
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise CanonicalError(f"integer outside the I-JSON safe range: {value}")
        out.append(str(int(value)))
    elif isinstance(value, float):
        raise CanonicalError("canonical JSON admits integers only")
    elif isinstance(value, str):
        _write_string(out, value)
    elif isinstance(value, (list, tuple)):
        out.append("[")
        for i, item in enumerate(value):
            if i:
                out.append(",")
            _write_value(out, item)
        out.append("]")
    elif isinstance(value, dict):
        for name in value:
            if not isinstance(name, str):
                raise CanonicalError(f"object member name is not a string: {name!r}")
        out.append("{")
        for i, name in enumerate(sorted(value, key=_utf16_key)):
            if i:
                out.append(",")
            _write_string(out, name)
            out.append(":")
            _write_value(out, value[name])
        out.append("}")
    else:
        raise CanonicalError(f"no canonical form for {type(value).__name__}")


def canonical_json(value) -> bytes:
    """The crate's canonical encoding of ``value``, as UTF-8 bytes."""
    out: list = []
    _write_value(out, value)
    try:
        return "".join(out).encode("utf-8")
    except UnicodeEncodeError as exc:  # a lone surrogate has no UTF-8 form
        raise CanonicalError(f"string is not valid Unicode: {exc}") from None


def signing_message(catalog: dict) -> bytes:
    """``CATALOG_SIGNING_LABEL || canonical_json(catalog)`` (crate
    ``catalog_signing_message``)."""
    return CATALOG_SIGNING_LABEL + canonical_json(catalog)


# ---------------------------------------------------------------------------
# Validation -- the crate's `Catalog::validate`, plus the platform's own
# publish rules.
# ---------------------------------------------------------------------------

_PRICE_MEMBERS = (
    "input_nusd_per_mtok",
    "cached_input_nusd_per_mtok",
    "cache_write_nusd_per_mtok",
    "output_nusd_per_mtok",
    "image_nusd",
    "tool_call_nusd",
)


def _uint(value, name: str, bits: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise CatalogRefused("invalid_catalog", f"{name} is not an integer")
    if value < 0 or value >= 1 << bits:
        raise CatalogRefused("invalid_catalog", f"{name} does not fit u{bits}: {value}")


def validate_model(model: dict, disabled_providers=()) -> None:
    """Refuse ONE model (:class:`CatalogRefused`; the caller excludes it).

    ``Catalog::validate``'s per-model checks, plus the typed ranges serde
    enforces on the gateway, a known ``api_style``, no policy-disabled
    provider, every integer inside the canonical range, and the  image
    rule. Per-model problems never take the whole document down: that would
    block every other change -- an emergency kill switch included -- for up
    to 72 h. That includes the  image rule: the
    ``pricing_ratecard`` trigger refuses to PUBLISH such a card, but an
    ``AIModel`` provider edit after publication can still create one, and the
    remedy must stay "exclude that model", never "freeze every gateway"
   .
    """
    model_id = model.get("id")
    if not isinstance(model_id, str) or not model_id:
        raise CatalogRefused("invalid_model", "empty model id")
    if model.get("provider") in set(disabled_providers):
        raise CatalogRefused(
            "disabled_provider_model",
            f"{model_id} is from policy-disabled provider {model.get('provider')}",
        )
    if model.get("api_style") not in API_STYLES:
        raise CatalogRefused(
            "invalid_model", f"{model_id}: unknown api_style {model.get('api_style')!r}")
    for name in ("provider", "provider_model_id"):
        if not isinstance(model.get(name), str) or not model.get(name):
            raise CatalogRefused("invalid_model", f"{model_id}: empty {name}")
    capabilities = model.get("capabilities", {})
    if (not isinstance(capabilities, dict)
            or set(capabilities) - CAPABILITY_MEMBERS
            or any(type(value) is not bool for value in capabilities.values())):
        raise CatalogRefused("invalid_model", f"{model_id}: invalid capabilities")
    if "controls" in model:
        controls = model["controls"]
        if not isinstance(controls, dict) or set(controls) - CONTROLS_MEMBERS:
            raise CatalogRefused("invalid_model", f"{model_id}: invalid controls")
        if "effort_levels" in controls:
            levels = controls["effort_levels"]
            if (not isinstance(levels, list) or not levels
                    or any(type(level) is not str or level not in EFFORT_LEVELS
                           for level in levels)
                    or len(set(levels)) != len(levels)):
                raise CatalogRefused(
                    "invalid_model", f"{model_id}: invalid controls.effort_levels")
            # A list on a model without the capability is never a grant
            # (the gateway ignores it) but reads like one: refuse it.
            if capabilities.get("reasoning_effort") is not True:
                raise CatalogRefused(
                    "invalid_model",
                    f"{model_id}: controls.effort_levels without reasoning_effort")
    prices = model.get("prices") or {}
    if set(prices) != set(_PRICE_MEMBERS):
        raise CatalogRefused("invalid_model", f"{model_id}: price members {sorted(prices)}")
    try:
        for name in _PRICE_MEMBERS:
            _uint(prices[name], f"{model_id}.prices.{name}", 64)
        for name in (
            "min_charge_2z", "context_window", "max_output_tokens",
            "ttfb_timeout_ms",
        ):
            _uint(model.get(name), f"{model_id}.{name}", 64)
        # Old schema-1 documents did not carry this additive field. The
        # producer always includes it; treating absence as the default keeps
        # already signed schema-1 documents valid during gateway rollout.
        _uint(model.get("idle_timeout_ms", 60_000), f"{model_id}.idle_timeout_ms", 64)
        _uint(model.get("safety_factor_bps"), f"{model_id}.safety_factor_bps", 32)
    except CatalogRefused as exc:
        raise CatalogRefused("invalid_model", exc.detail) from None
    if not isinstance(model.get("enabled"), bool):
        raise CatalogRefused("invalid_model", f"{model_id}: enabled is not a boolean")
    if model["safety_factor_bps"] < BPS_DENOMINATOR:
        raise CatalogRefused("invalid_model", f"{model_id}: safety factor below 1.0")
    if model["min_charge_2z"] < 1:
        raise CatalogRefused("invalid_model", f"{model_id}: min_charge_2z below 1")
    if model["max_output_tokens"] > model["context_window"]:
        raise CatalogRefused(
            "invalid_model", f"{model_id}: max_output_tokens exceeds context_window")
    if not 1 <= model.get("idle_timeout_ms", 60_000) <= 300_000:
        raise CatalogRefused(
            "invalid_model", f"{model_id}: idle_timeout_ms must be between 1 and 300000")
    if all(prices[name] == 0 for name in _PRICE_MEMBERS):
        raise CatalogRefused("all_zero_prices", model_id)
    if model["provider"] in TOKEN_BILLED_IMAGE_PROVIDERS and prices["image_nusd"] > 0:
        raise CatalogRefused(
            "image_billed_as_tokens",
            f"{model_id}: image_nusd={prices['image_nusd']} but {model['provider']} "
            "bills images inside input tokens (#2232)",
        )
    try:
        canonical_json(model)
    except CanonicalError as exc:
        raise CatalogRefused("invalid_model", f"{model_id}: {exc}") from None


def validate_catalog(catalog: dict) -> None:
    """Refuse (:class:`CatalogRefused`) a DOCUMENT the gateway would refuse.

    The document-level half of ``Catalog::validate`` (schema, ranges, expiry
    after issue, margin bound, unique ids) plus:func:`validate_model` on
    every model. The builder excludes bad models before calling this, so on
    the serving path a failure here is a builder bug.

    An EMPTY model list is valid and is published (the crate accepts it). It
    is how "every model is off" reaches the gateway.
    """
    if catalog.get("schema") != CATALOG_SCHEMA:
        raise CatalogRefused("invalid_catalog", "unsupported catalogue schema")
    for name in ("version", "issued_at", "expires_at", "rate_card_version"):
        _uint(catalog.get(name), name, 64)
    _uint(catalog.get("platform_margin_bps"), "platform_margin_bps", 32)
    if catalog["expires_at"] <= catalog["issued_at"]:
        raise CatalogRefused("invalid_catalog", "expires_at not after issued_at")
    if catalog["platform_margin_bps"] > MAX_PLATFORM_MARGIN_BPS:
        raise CatalogRefused("invalid_catalog", "platform margin above the sane bound")
    models = catalog.get("models")
    if not isinstance(models, list):
        raise CatalogRefused("invalid_catalog", "models is not a list")
    seen = set()
    for model in models:
        validate_model(model, catalog.get("disabled_providers", ()))
        if model["id"] in seen:
            raise CatalogRefused("duplicate_model_id", model["id"])
        seen.add(model["id"])
    try:
        canonical_json(catalog)
    except CanonicalError as exc:
        raise CatalogRefused("invalid_catalog", str(exc)) from exc


# ---------------------------------------------------------------------------
# Building
# ---------------------------------------------------------------------------


def now_unix() -> int:
    """The signer's clock, in Unix seconds (a seam for tests)."""
    return int(time.time())


def window_start(now_unix: int) -> int:
    """``issued_at`` (and ``version``) for a catalogue served at ``now_unix``."""
    return now_unix - now_unix % REISSUE_SECONDS


def active_rate_card():
    """The card new holds are admitted on: the newest ACTIVE card.

    More than one card may be active during a rotation; the catalogue carries
    one ``rate_card_version``, and it is the newest, so the gateway moves to
    the new prices as soon as they are published and activated.
    """
    from .models import RateCard

    card = (
        RateCard.objects.filter(active=True, published_at__isnull=False)
        .order_by("-version")
        .first()
    )
    if card is None:
        raise CatalogRefused("no_active_rate_card", "no published, active rate card")
    return card


def catalogue_models():
    """The ``AIModel`` rows the catalogue lists: policy-enabled (which
    excludes every ``POLICY_DISABLED_PROVIDERS`` provider), in the GA
    lineup, and DISCOVERED -- the provider's own model list names the
    upstream id (``AIModelQuerySet.discovered``; fail-open for a provider
    with no recorded listing yet). NOT filtered by ``configured()``: that
    asks whether THIS Django process has a provider key, and the gateway
    holds its own."""
    from dj.apps.openai.models import AIModel

    return list(
        AIModel.objects.enabled().discovered().filter(is_ga=True)
        .order_by("model", "provider")
    )


def undiscovered_models():
    """The enabled GA rows:func:`catalogue_models` leaves out for lack of
    a provider listing, for the per-build exclusion line."""
    from dj.apps.openai.models import AIModel

    gated = AIModel.objects.enabled().filter(is_ga=True)
    discovered_pks = set(gated.discovered().values_list("pk", flat=True))
    return [row for row in gated.order_by("model", "provider") if row.pk not in discovered_pks]


def model_cost_floor_nusd(ai_model) -> tuple:
    """``(input, output)`` nano-USD per Mtok the Django row records as the
    provider's cost -- the independent record a card row is checked against.
    ``None`` when a price does not convert exactly (nothing to compare)."""
    from .ai import nusd_per_mtok_from_usd_per_token

    try:
        return (
            nusd_per_mtok_from_usd_per_token(ai_model.input_price),
            nusd_per_mtok_from_usd_per_token(ai_model.output_price),
        )
    except (ValueError, ArithmeticError):
        return None


def _micros(stamp) -> int:
    delta = stamp - datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
    return (delta.days * 86_400 + delta.seconds) * VERSION_UNITS_PER_SECOND + delta.microseconds


def content_revision(card) -> int:
    """Unix MICROSECONDS of the newest change that can alter the catalogue's
    content: the latest ``AIModel.updated_at`` over ALL rows (a row that has
    just been disabled or taken out of the lineup is exactly the change that
    must propagate) and the latest ``published_at`` over ALL published cards,
    not just the served one, so deactivating the newest card (a rollback)
    can never LOWER the version -- a lower one is refused as a replay. Exact
    integer arithmetic, no float. ``card`` is unused; it is the call's
    context for readers and tests. See the module docstring for what leaves
    no stamp and why this is read before the content."""
    from django.db.models import Max

    from dj.apps.openai.models import AIModel

    from .models import RateCard

    from dj.apps.openai.models import ProviderModel

    stamps = [
        RateCard.objects.aggregate(t=Max("published_at"))["t"],
        AIModel.objects.aggregate(t=Max("updated_at"))["t"],
        # Discovery changes the set only when an id appears, vanishes or
        # comes back; ``availability_changed_at`` moves then and only then
        # (``last_seen_at`` moves every run and is deliberately NOT here).
        ProviderModel.objects.aggregate(t=Max("availability_changed_at"))["t"],
    ]
    return max((_micros(s) for s in stamps if s is not None), default=0)


def build_catalog(now_unix: int) -> dict:
    """The unsigned catalogue for ``now_unix``. Raises:class:`CatalogRefused`.

    Every read -- the card, the revision, the rows, the models -- comes from
    ONE read-only REPEATABLE READ snapshot, so a card published or a model
    saved while this runs is either wholly in the catalogue or wholly absent,
    and can never lend its revision to content it is not part of (codex
    review of: card A's prices signed under a revision that already
    counted card B's publication). Postgres takes the snapshot at the first
    statement after ``SET TRANSACTION``. Inside an enclosing transaction
    (only tests call this from one; a GET runs in autocommit) the isolation
    level can no longer be set, and the enclosing transaction's own
    consistency applies instead.
    """
    from django.db import connection, transaction

    with transaction.atomic():
        if not _in_outer_transaction():
            with connection.cursor() as cursor:
                cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        return _build_catalog_in_snapshot(now_unix)


def _in_outer_transaction() -> bool:
    """True when ``transaction.atomic()`` just opened a SAVEPOINT rather than
    a new transaction -- i.e. queries may already have run in it."""
    from django.db import connection

    # Called inside our own atomic(): one block is ours; more is an outer one.
    return len(connection.atomic_blocks) > 1


def _build_catalog_in_snapshot(now_unix: int) -> dict:
    from f2z.ai.providers import POLICY_DISABLED_PROVIDERS

    card = active_rate_card()
    # BEFORE the content -- see the module docstring. Do not move.
    revision = content_revision(card)
    rows = {row.model_id: row for row in card.model_rows.all()}
    disabled = sorted(POLICY_DISABLED_PROVIDERS)
    candidates = []
    for ai_model in undiscovered_models():
        log_model_not_discovered(ai_model)
    for ai_model in catalogue_models():
        row = rows.get(ai_model.model)
        if row is None:
            log_model_excluded(
                ai_model.model, ai_model.provider, "model_without_rate",
                f"no row on rate card v{card.version}")
            continue
        # NEVER BELOW COST. The card is immutable and the AIModel row is the
        # independently maintained record of the provider's price (the chat
        # path charges on it); a card row under it is a stale card (
        # found grok-4.5 at 1.6x / 2.4x under) and is not sold until a new
        # card lands. Per-model, never document-wide: one stale row must not
        # take gpt-4o off the shelf.
        floor = model_cost_floor_nusd(ai_model)
        if floor is not None and (
                row.input_nusd_per_mtok < floor[0] or row.output_nusd_per_mtok < floor[1]):
            log_model_excluded(
                ai_model.model, ai_model.provider, "card_below_model_cost",
                f"card v{card.version} input/output {row.input_nusd_per_mtok}/"
                f"{row.output_nusd_per_mtok} nUSD/Mtok is below the AIModel row's "
                f"{floor[0]}/{floor[1]}; publish a new card")
            continue
        candidates.append({
            "id": ai_model.model,
            "provider": ai_model.provider,
            "provider_model_id": ai_model.upstream_model_id,
            "api_style": ai_model.effective_api_style,
            # Catalogue schema 1 has one cache-write price: the 5-minute one
            # (the TTL a bare cache_control gets). See pricing.models.
            "prices": {
                "input_nusd_per_mtok": row.input_nusd_per_mtok,
                "cached_input_nusd_per_mtok": row.cached_input_nusd_per_mtok,
                "cache_write_nusd_per_mtok": row.cache_write_5m_nusd_per_mtok,
                "output_nusd_per_mtok": row.output_nusd_per_mtok,
                "image_nusd": row.image_nusd,
                "tool_call_nusd": row.tool_call_nusd,
            },
            "min_charge_2z": row.min_charge_2z,
            "safety_factor_bps": ai_model.safety_factor_bps,
            "context_window": ai_model.context_window,
            "max_output_tokens": ai_model.catalogue_max_output_tokens,
            "ttfb_timeout_ms": ai_model.ttfb_timeout_ms,
            "idle_timeout_ms": ai_model.idle_timeout_ms,
            "enabled": True,
        })
        # Always present, every member explicit. ``vision``/``tools``/
        # ``reasoning`` read absent as false, but the gateway reads an absent
        # ``structured_output`` (zuu#1128) or ``strict_tools`` (zuu#1142) as
        # "catalogue silent" and applies its interim rule (``provider ==
        # "openai"``) -- so false must be SIGNED to be a refusal. Still schema 1: an older gateway's
        # ``ModelCapabilities`` is ``#[serde(default)]`` without
        # ``deny_unknown_fields``, so it ignores the new member, and the
        # signature covers the raw tree either way.
        candidates[-1]["capabilities"] = {
            "tools": ai_model.supports_tools,
            "vision": ai_model.supports_vision,
            "reasoning": ai_model.supports_reasoning,
            "structured_output": ai_model.supports_structured_output,
            "strict_tools": ai_model.supports_strict_tools,
            # zuu#1170. Absent reads as false there (not tri-state); signed
            # explicitly like every member.
            "reasoning_effort": ai_model.supports_reasoning_effort,
        }
        # Signed narrowing, only where the capability is on and a list is
        # recorded: a list left on a row whose capability an operator turned
        # off is simply not signed (never a reason to exclude the model).
        # Absent otherwise (``[]``, the default), so a model without it signs
        # exactly as before. The stored value is passed through UNCOERCED:
        # ``QuerySet.update()`` skips the field validator, and a malformed
        # value (``1``, ``true``, ``null``, ``{"low": true}``) must reach
        # ``validate_model`` and exclude THIS model -- never crash the build
        # (one row would stop every catalogue, kill switches included) and
        # never be silently reshaped into a list (codex round 1).
        levels = ai_model.reasoning_effort_levels
        if ai_model.supports_reasoning_effort and levels != []:
            candidates[-1]["controls"] = {
                "effort_levels": list(levels) if isinstance(levels, list) else levels,
            }
    # Per-model problems EXCLUDE the model (callable=false by omission) and
    # raise an alerted line; they never refuse the document (review of
    #one unpriced model blocked an emergency kill switch for 72 h).
    # A duplicated id excludes EVERY row sharing it: which one is meant
    # cannot be decided here, and signing either would be a guess.
    counts = {}
    for model in candidates:
        counts[model["id"]] = counts.get(model["id"], 0) + 1
    models = []
    for model in candidates:
        if counts[model["id"]] > 1:
            log_model_excluded(
                model["id"], model["provider"], "duplicate_model_id",
                f"{counts[model['id']]} enabled GA AIModel rows share this id")
            continue
        try:
            validate_model(model, disabled)
        except CatalogRefused as exc:
            log_model_excluded(model["id"], model["provider"], exc.reason, exc.detail)
            continue
        models.append(model)
    # A stamp from the future would become a version the gateway holds until
    # the wall clock catches up, and every correction in between would be
    # ignored as Unchanged -- refuse and alert instead (codex round 6).
    horizon = (now_unix + FUTURE_REVISION_TOLERANCE_SECONDS) * VERSION_UNITS_PER_SECOND
    if revision > horizon:
        raise CatalogRefused(
            "future_revision",
            f"a model updated_at or card published_at is "
            f"{(revision // VERSION_UNITS_PER_SECOND) - now_unix}s in the future",
        )
    version = max(window_start(now_unix) * VERSION_UNITS_PER_SECOND, revision)
    issued_at = version // VERSION_UNITS_PER_SECOND
    catalog = {
        "schema": CATALOG_SCHEMA,
        "version": version,
        "issued_at": issued_at,
        "expires_at": issued_at + VALIDITY_SECONDS,
        "rate_card_version": card.version,
        "platform_margin_bps": card.platform_margin_bps,
        "disabled_providers": disabled,
        "models": models,
    }
    validate_catalog(catalog)
    return catalog


# ---------------------------------------------------------------------------
# Signing
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SigningKey:
    key_id: str
    private_key: Ed25519PrivateKey
    public_key_hex: str

    def sign(self, message: bytes) -> bytes:
        return self.private_key.sign(message)

    def __repr__(self) -> str:  # never print the key
        return f"SigningKey(key_id={self.key_id!r}, public_key_hex={self.public_key_hex!r})"


def load_signing_key() -> SigningKey:
    """The catalogue key from settings. Raises:class:`CatalogRefused`.

    ``AI_CATALOG_SIGNING_KEY`` is the 32-byte Ed25519 SEED as 64 hex
    characters (owner-provisioned; never committed), ``AI_CATALOG_KEY_ID`` the
    id the gateway's trusted-key list names it by.
    """
    seed_hex = (getattr(settings, "AI_CATALOG_SIGNING_KEY", "") or "").strip()
    key_id = (getattr(settings, "AI_CATALOG_KEY_ID", "") or "").strip()
    if not seed_hex or not key_id:
        raise CatalogRefused(
            "signing_key_unconfigured",
            "AI_CATALOG_SIGNING_KEY and AI_CATALOG_KEY_ID must both be set",
        )
    try:
        seed = bytes.fromhex(seed_hex)
        if len(seed) != 32:
            raise ValueError("not 32 bytes")
        private_key = Ed25519PrivateKey.from_private_bytes(seed)
    except ValueError:
        # Never echo the value.
        raise CatalogRefused(
            "signing_key_malformed", "AI_CATALOG_SIGNING_KEY is not 64 hex characters"
        ) from None
    public_key_hex = private_key.public_key().public_bytes_raw().hex()
    if public_key_hex == RFC8032_TEST1_PUBLIC_HEX and not getattr(
        settings, "AI_CATALOG_ALLOW_TEST_KEY", False
    ):
        raise CatalogRefused(
            "test_key_not_allowed",
            "the public RFC 8032 test key is configured outside tests",
        )
    return SigningKey(key_id=key_id, private_key=private_key, public_key_hex=public_key_hex)


@dataclass(frozen=True)
class SignedCatalog:
    catalog: dict
    canonical: bytes
    key_id: str
    signature_hex: str
    body: bytes
    etag: str


def sign_catalog(catalog: dict, key: SigningKey) -> SignedCatalog:
    """Sign ``catalog`` and render the served document.

    The body is ``{"catalog": <canonical bytes>, "signature": {...}}`` with the
    catalogue member written in canonical form, so the bytes a consumer
    extracts for ``verify_catalog`` are exactly the signed ones (any other
    spelling would verify too -- the crate canonicalizes -- but there is no
    reason to serve one).
    """
    canonical = canonical_json(catalog)
    signature = key.sign(CATALOG_SIGNING_LABEL + canonical)
    signature_hex = signature.hex()
    envelope_signature = canonical_json({"key_id": key.key_id, "signature_hex": signature_hex})
    body = b'{"catalog":' + canonical + b',"signature":' + envelope_signature + b"}"
    etag = '"' + hashlib.sha256(body).hexdigest() + '"'
    return SignedCatalog(
        catalog=catalog,
        canonical=canonical,
        key_id=key.key_id,
        signature_hex=signature_hex,
        body=body,
        etag=etag,
    )


def signed_catalog(now_unix: int) -> SignedCatalog:
    """Build, validate and sign the catalogue for ``now_unix``."""
    key = load_signing_key()
    return sign_catalog(build_catalog(now_unix), key)


# ---------------------------------------------------------------------------
# Observability
# ---------------------------------------------------------------------------

_served_hours: set = set()


def log_refused(exc: CatalogRefused) -> None:
    logger.error(json.dumps({
        "severity": "ERROR",
        "message": (
            "AI catalogue refused: " + exc.reason
            + ". The gateway keeps its last verified copy until it expires "
            "(72h after issue) and then refuses every new call."
        ),
        "event": AI_CATALOG_REFUSED_EVENT,
        "reason": exc.reason,
        "detail": exc.detail,
    }, separators=(",", ":")))


def log_model_excluded(model_id, provider, reason: str, detail: str) -> None:
    """One ERROR line per excluded model per build; alerted (email tier) by
    ``monitoring/alert-policies/ai-catalog-model-excluded.json``."""
    logger.error(json.dumps({
        "severity": "ERROR",
        "message": (
            f"AI catalogue: model {model_id} ({provider}) excluded: {reason}. "
            "It is not callable through the gateway until fixed; every other "
            "model is still published."
        ),
        "event": AI_CATALOG_MODEL_EXCLUDED_EVENT,
        "model": model_id,
        "provider": provider,
        "reason": reason,
        "detail": detail,
    }, separators=(",", ":")))


def log_model_not_discovered(ai_model) -> None:
    """One WARNING line per build, deliberately NOT the alerted exclusion
    event: a model the provider retired, or one this key's tier cannot reach,
    is an expected steady state until a human prices or retires the row --
    paging on every catalogue build would teach everyone to ignore the page.
    ``manage.py discover_ai_models --report`` is where that human looks."""
    logger.warning(json.dumps({
        "severity": "WARNING",
        "message": (
            f"AI catalogue: model {ai_model.model} ({ai_model.provider}) not sold: the "
            f"provider does not list {ai_model.upstream_model_id}. Retire the row "
            "(is_ga=False) or fix provider_model_id; see discover_ai_models --report."
        ),
        "event": AI_CATALOG_MODEL_NOT_DISCOVERED_EVENT,
        "model": ai_model.model,
        "provider": ai_model.provider,
        "upstream_model_id": ai_model.upstream_model_id,
    }, separators=(",", ":")))


def log_not_provisioned(exc: CatalogRefused) -> None:
    """WARNING, deliberately NOT alerted: an unprovisioned key is the expected
    state until the owner provisions it, and the URL is public."""
    logger.warning(json.dumps({
        "severity": "WARNING",
        "message": "AI catalogue not provisioned: " + exc.detail,
        "event": AI_CATALOG_NOT_PROVISIONED_EVENT,
        "reason": exc.reason,
    }, separators=(",", ":")))


def served_client(user_agent: str | None) -> str:
    """Which client class a catalogue request came from, by its User-Agent.

    :data:`SERVED_CLIENT_GATEWAY` only when the FIRST product token is exactly
    ``f2z-ai/<non-empty version>``. Anything else -- ``curl/8.7.1``, a
    browser, a scanner, no header at all, ``f2z-ai`` with no version, a token
    that merely contains ``f2z-ai`` -- is:data:`SERVED_CLIENT_OTHER`.

    A monitoring label, not authentication: anyone can send the header.
    Spoofing it can keep the absence alert quiet or arm it early; neither
    moves money -- the catalogue is public, and the gateway trusts its
    signature, never its fetcher.
    """
    tokens = (user_agent or "").split()
    if not tokens:
        return SERVED_CLIENT_OTHER
    name, sep, version = tokens[0].partition("/")
    if name == GATEWAY_USER_AGENT_PRODUCT and sep and version:
        return SERVED_CLIENT_GATEWAY
    return SERVED_CLIENT_OTHER


def log_served_once(signed: SignedCatalog, now_unix: int, client: str) -> None:
    """At most one line per process per clock HOUR per ``client`` class --
    the version changes every minute, so keying on it would be 1440 lines a
    day per pod for a signal that only needs to prove "still being served".

    Only ``client="f2z-ai"`` lines feed the absence alert: their
    absence for a day means the gateway's newest copy has under 48 h left.
    A line from anything else says nothing about the gateway's copy -- a
    manual ``curl`` used to arm a Critical page that fired 23 h later with no
    gateway deployed. Keyed by client as well as hour so that such a request
    early in an hour cannot use up the slot and hide that hour's gateway
    serve from the gateway-only metric."""
    version = signed.catalog["version"]
    hour = now_unix // HOUR
    key = (hour, client)
    if key in _served_hours:
        return
    _served_hours.add(key)
    # Bounded: forget hours older than the validity window.
    for old in [k for k in _served_hours if k[0] < hour - VALIDITY_SECONDS // HOUR]:
        _served_hours.discard(old)
    logger.info(json.dumps({
        "severity": "INFO",
        "message": "AI catalogue served.",
        "event": AI_CATALOG_SERVED_EVENT,
        "client": client,
        "version": version,
        "rate_card_version": signed.catalog["rate_card_version"],
        "expires_at": signed.catalog["expires_at"],
        "remaining_seconds": signed.catalog["expires_at"] - now_unix,
        "models": len(signed.catalog["models"]),
        "key_id": signed.key_id,
    }, separators=(",", ":")))
