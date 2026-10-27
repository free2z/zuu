"""``GET /api/languages/`` — the language catalog, named for the viewer.

The point of this endpoint is stated in  item 2: the sellable language set
is mirrored by hand into the frontend today, so **a language cannot ship
without a frontend release**. Serving it turns "add Cantonese" into a registry
change plus a backend deploy, and turns "demote a language whose quality is
bad" into the same cheap operation — which  item 9 needs it to be.

Three things about the design are deliberate.

**It is a pure read, and the locale is a representation selector.** ``?locale=``
picks which language the *names* come out in. It touches nothing persistent,
which is why a query parameter is allowed to shape the answer at all (see the
"A URL never dictates what goes in the database" rule in CLAUDE.md, ). It is
declared in ``f2z.yaml`` with its failure mode, and that failure mode is
**degrade, never refuse**: a malformed or unknown locale is named in English. A
representation hint must not be able to fail a read.

**It is cacheable, and says so precisely.** The editor loads this on every open.
The body is a pure function of the registry and the naming locale, so it gets a
strong ``ETag`` computed from the payload, a short ``max-age`` with a long
``stale-while-revalidate`` (a language added today reaching a warm client five
minutes late is fine; a cold editor blocking on this is not), and ``Vary`` on
the two request headers that can change the bytes.

**It authenticates nobody.** ``authentication_classes = []`` is not decoration:
touching ``request.user`` runs ``SessionAuthentication``, which reads the
session, which makes ``SessionMiddleware`` stamp ``Vary: Cookie`` on the
response — and a ``public`` response that varies on ``Cookie`` is one no shared
cache can reuse between two visitors. The catalog does not depend on who is
asking, so it must not look as though it does.
"""

import hashlib
import json

from django.http import HttpResponseNotModified
from django.utils.cache import patch_vary_headers
from django.utils.http import parse_etags
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from f2z import language_catalog

#Long enough that a burst of editor loads costs one request, short enough
#that a registry change is live everywhere within minutes. The
#``stale-while-revalidate`` is the half that matters for the user: after five
#minutes a client serves the catalog it already has and refreshes in the
#background, so growing the language set never makes an editor wait.
CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=86400"


class LanguageEntrySerializer(serializers.Serializer):
    """One language, with everything a picker needs and nothing it does not."""

    tag = serializers.CharField(
        help_text="Canonical BCP-47 tag, e.g. `pt-BR`, `zh-Hant`."
    )
    name = serializers.CharField(
        help_text=(
            "The language's name in the response's `locale`. Never a raw "
            "subtag (#806)."
        )
    )
    autonym = serializers.CharField(
        help_text=(
            "The language's name written in itself (`日本語`). Falls back to "
            "the English name where CLDR has no endonym."
        )
    )
    script = serializers.CharField(
        allow_null=True,
        help_text=(
            "ISO 15924 script the tag is written in, from CLDR likely "
            "subtags — `zh-TW` answers `Hant` even though it does not spell "
            "it. `null` when unanswerable, which means *no constraint*, not "
            "*Latin*."
        ),
    )
    direction = serializers.ChoiceField(
        choices=[("ltr", "ltr"), ("rtl", "rtl")],
        help_text=(
            "Text direction for `script`. Derived from the script, not the "
            "language: `ku` is `ltr` and `ckb` is `rtl`."
        ),
    )
    translatable = serializers.BooleanField(
        help_text=(
            "Whether we sell an AI translation into this language. Every "
            "entry currently served is `true`; the flag exists so that a "
            "language listed but demoted to detect-only stops being offered "
            "without a client release."
        )
    )


class LanguageCatalogSerializer(serializers.Serializer):
    """The catalog, plus the locale its names are actually in."""

    locale = serializers.CharField(
        help_text=(
            "The locale `name` is written in — the *resolved* one, which may "
            "differ from what was requested (`es-MX` resolves to `es`, an "
            "unknown locale to `en`). Cache the catalog under this value, not "
            "under the one you asked for."
        )
    )
    languages = LanguageEntrySerializer(many=True)


def _accept_language_candidates(header):
    """Language tags from an ``Accept-Language`` header, best first.

    Hand-rolled rather than reaching for ``django.utils.translation.trans_real
    .parse_accept_lang_header``, which is private and tied to the ``LANGUAGES``
    setting — the product-UI locale list, which is emphatically not the same
    question as "what language should these names be in" ( §3.3).

    ``q=0`` means "not this one" and is dropped rather than ranked last.
    ``*`` is skipped: it expresses no preference, so it should fall through to
    the next candidate and then to English. Anything malformed is skipped, not
    fatal — a header we cannot parse must not fail the read.
    """
    candidates = []
    for index, part in enumerate(header.split(",")):
        piece, _, params = part.strip().partition(";")
        tag = piece.strip()
        if not tag or tag == "*":
            continue
        quality = 1.0
        for param in params.split(";"):
            key, _, value = param.partition("=")
            if key.strip().lower() != "q":
                continue
            try:
                quality = float(value.strip())
            except ValueError:
                quality = 0.0
            break
        if quality <= 0:
            continue
        # Index keeps the sort total and stable, so equal-q tags stay in the
        # order the client listed them.
        candidates.append((-quality, index, tag))
    return [tag for _quality, _index, tag in sorted(candidates)]


def _requested_locale(request):
    """Which naming locale this request asks for, before resolution.

    ``?locale=`` wins outright when present: it is an explicit instruction from
    the caller, and the header is a default. An empty ``?locale=`` is treated
    as absent rather than as a request for English — a client building the
    query string from an unset variable meant "no preference".
    """
    explicit = (request.query_params.get("locale") or "").strip()
    if explicit:
        return language_catalog.naming_locale(explicit)
    header = request.headers.get("Accept-Language") or ""
    return language_catalog.match_naming_locale(
        _accept_language_candidates(header)
    )


def _etag_for(payload, media_type):
    """A strong validator for these exact bytes.

    Hashes the payload rather than the rendered body so the ETag can be known
    before rendering, and includes the negotiated media type because the JSON
    and the browsable-HTML representations of the same payload are different
    bytes under the same URL. ``Vary: Accept`` tells caches the same thing; the
    two together mean a client cannot be handed a 304 for a representation it
    does not hold.
    """
    canonical = json.dumps(
        payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )
    digest = hashlib.sha256(
        f"{media_type}\n{canonical}".encode("utf-8")
    ).hexdigest()
    return f'"{digest[:32]}"'


def _opaque_tag(etag):
    """An ETag with any ``W/`` weakness prefix removed, for weak comparison."""
    return etag[2:] if etag.startswith("W/") else etag


def _if_none_match_hits(request, etag):
    """Does the caller already hold ``etag``?

    RFC 9110 §13.1.2: ``If-None-Match`` uses the **weak** comparison function,
    so ``W/"x"`` and ``"x"`` match. ``*`` matches any existing representation.
    """
    header = request.headers.get("If-None-Match")
    if not header:
        return False
    if header.strip() == "*":
        return True
    held = parse_etags(header)
    mine = _opaque_tag(etag)
    return any(_opaque_tag(candidate) == mine for candidate in held)


class LanguageCatalogView(APIView):
    """The languages we sell a translation into, named for the viewer.

    Public and unauthenticated on purpose: the picker is on screen before a
    visitor signs in, and the answer is the same for everyone.
    """

    permission_classes = [AllowAny]
    # See the module docstring: authenticating here would stamp `Vary: Cookie`
    # on a response that is identical for every caller.
    authentication_classes = []

    @extend_schema(
        operation_id="languages_catalog",
        tags=["languages"],
        parameters=[
            OpenApiParameter(
                name="locale",
                type=str,
                required=False,
                location=OpenApiParameter.QUERY,
                description=(
                    "BCP-47 locale to name the languages in. A pure "
                    "representation selector: it changes nothing stored and "
                    "**never fails the request**. A locale we have no name "
                    "table for degrades to the closest one we do "
                    "(`es-MX` -> `es`), and an unknown or malformed value "
                    "degrades to `en` — never a 4xx. The locale actually used "
                    "is returned as `locale`. Omit it to negotiate from "
                    "`Accept-Language`."
                ),
            ),
            OpenApiParameter(
                name="Accept-Language",
                type=str,
                required=False,
                location=OpenApiParameter.HEADER,
                description=(
                    "Fallback naming locale when `locale` is absent, parsed "
                    "with `q` weights. Same degrade-never-refuse contract. "
                    "Note that orval emits no code for header parameters, so "
                    "a generated TypeScript client will not send this unless "
                    "the call site passes it through the request options."
                ),
            ),
            OpenApiParameter(
                name="If-None-Match",
                type=str,
                required=False,
                location=OpenApiParameter.HEADER,
                description=(
                    "Conditional GET. Send back the `ETag` from a previous "
                    "response to get `304 Not Modified` with no body."
                ),
            ),
        ],
        responses={
            200: LanguageCatalogSerializer,
            304: OpenApiResponse(
                description=(
                    "The caller's `If-None-Match` matches the current "
                    "catalog. No body."
                )
            ),
        },
    )
    def get(self, request, *args, **kwargs):
        locale, rows = language_catalog.catalog(_requested_locale(request))
        payload = {"locale": locale, "languages": rows}
        media_type = getattr(request, "accepted_media_type", None) or (
            "application/json"
        )
        etag = _etag_for(payload, media_type)

        if _if_none_match_hits(request, etag):
            response = HttpResponseNotModified()
        else:
            response = Response(payload)

        response["ETag"] = etag
        response["Cache-Control"] = CACHE_CONTROL
        # `Accept-Language` selects the naming locale; `Accept` selects the
        # representation, and DRF still has the browsable renderer wired up, so
        # the same URL really can answer two different byte streams.
        patch_vary_headers(response, ("Accept-Language", "Accept"))
        return response
