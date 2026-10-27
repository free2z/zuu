"""Structural guard for "a URL never dictates what goes in the database".

``CLAUDE.md`` says it in one line:

    Query parameters and path segments **select a representation** or
    **identify a resource**. Body fields **mutate state**. Nothing else.

 audited the codebase against that rule and found seven violations -- a
query parameter permanently branding an article's language, a representation
selector silently suppressing a publish side effect, a URL path segment
inventing enum values and paying for provider calls, a DELETE whose target came
from a query string, and more. All seven are fixed. This file exists so the
eighth is caught by CI instead of by an audit.

Two invariants, both walked over the AST of every non-test module under ``py/``:

**Rule A -- request metadata must not reach a write.**
  ``request.query_params`` / ``request.GET`` / ``request.headers`` /
  ``request.COOKIES`` / ``request.META`` / ``request.get_host()`` read inside a
  serializer ``create`` / ``update`` / ``validate*`` / ``save``, a
  ``perform_create`` / ``perform_update`` / ``perform_destroy``, any handler for
  an unsafe verb, any ``@action`` / ``@api_view`` / django-ninja route bound to
  one, or any URLconf function view that pins no verb at all (Django dispatches
  every method to those).

**Rule B -- a read must not write.**
  Any ORM write (``.save()``, ``.create()``, ``.delete()``, ``.update()``,
  ``get_or_create``, ``update_or_create``, ``bulk_*``, m2m ``.add()/.remove()``
  ``/.set()/.clear()``, an ``F()`` increment assigned to a field, raw
  ``INSERT``/``UPDATE``/``DELETE`` SQL) inside a ``get`` / ``list`` /
  ``retrieve`` handler, any route declaring a safe verb -- **including** one
  that also declares an unsafe verb, since ``methods=['GET', 'POST']`` is still
  reachable by GET -- or an unpinned URLconf function view.

Both rules follow calls: the offending expression is almost never in the handler
itself (six of the eight findings below live in a helper), so the analysis walks
the call graph -- ``self.method()``, methods inherited from a base class,
module-level functions, imported names, names re-exported through a package
``__init__``, and ``from. import service`` submodules -- to a bounded depth,
and reports the chain it took.

**The allowlist is as much the deliverable as the check.** Every entry names one
function and one *parameter* -- ``request.headers['Idempotency-Key']``, never a
bare ``request.headers`` -- carries a reason, and is asserted to still be live.
A stale entry fails just as loudly as a new violation, so the list cannot rot
into a blanket amnesty. Blessing a whole module is what let 's review catch
an over-blessed billing route; do not do it here.

``KNOWN_UNFIXED`` is a third bucket: reviewed, judged **wrong**, and left for its
own PR. It is reported as a strict ``xfail``, not an allowlist entry, so every CI
run says out loud that an open finding exists, and the build breaks the moment
the code is fixed and the entry is not deleted.

The detector has its own tests (``test_detector_*``). A guard that looks
thorough and isn't is worse than no guard, because it buys false confidence, so
each violation shape -- and each evasion of it -- is injected as source and the
check must see it. Those tests, plus the codex adversarial review, found seven
real holes while this file was being written: ``self.context['request']`` (the
exact spelling  F1 used), re-exported helpers, helpers inherited from a
mixin, ``from. import service`` submodules, package-relative re-exports,
undecorated function views, ``as_view({'get': 'claim'})`` method maps,
mixed-verb routes, per-container rather than per-parameter allowlist keys,
``import a.b.c`` binding the wrong module, aliased route decorators, imports
from every lexical scope flattened into one map, a helper whose request
parameter simply had a different name, a one-line ``incoming = request`` alias,
a ``dispatch()`` override, a decorator aliased by assignment, a GET that
reached a write without Rule A ever looking at it, and an allowlist that blessed
a callee
without regard to which route reached it -- which would have let a future GET
inherit the Stripe webhook's licence to mint 2Z. Most of those were found only
because an independent reviewer went hunting for false negatives across five
rounds; assume more remain.

WHAT THIS CANNOT CATCH -- read before trusting it
-------------------------------------------------
1. **Metadata reaching a write through an object we cannot resolve.** The call
   graph follows ``self.method()``, module-level functions and imported names.
   It does not follow ``serializer.save()``, ``form.save()`` or a property.
    **F2 would not be caught**: a ``PUT`` handler read ``serializer.data``,
   whose ``to_representation`` consulted ``?lang`` and thereby suppressed a
   publish side effect. Metadata reaching a write through a *serializer
   instance* is a live blind spot.
2. **Metadata stashed and read later** -- thread-locals, middleware writing onto
   ``request.user``, a value put on ``self`` in ``dispatch`` and read in
   ``create``. Only the read site is seen, and the read site is in ``dispatch``.
3. **Dynamic access**: ``getattr(request, 'query_params')``, ``request.__dict__``,
   ``**request.GET.dict()`` spread through a variable.
4. **Writes we do not name**: ``qs.in_bulk``, ``objects.bulk_*`` aliases we
   missed, ``connection.cursor()`` with a computed (non-literal) SQL string, a
   Celery task queued from a GET that writes in another process.
5. **Path segments.** The rule covers them, this check does not: a path segment
   arrives as an ordinary ``kwargs`` value with nothing structurally marking it
   as request-derived.  F3 (``<str:type>`` persisted as an unvalidated enum)
   would not be caught. Constrain path segments with a converter or an explicit
   validation step; nothing here will tell you that you forgot.
6. **The frontend.** SvelteKit ``+server.ts`` / ``+page.server.ts`` writes are
   not analysed at all ( F7 lived there).

Run ``pytest -q dj/apps/test_url_write_guard.py`` -- no database required.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path

import pytest

#Root of the Python tree we analyse (``py/``).
PY_ROOT = Path(__file__).resolve().parents[2]

CLAUDE_MD_SECTION = (
    "CLAUDE.md -> 'A URL never dictates what goes in the database' (#985)"
)

#How far to follow the call graph out of a handler. Most of the live
#exceptions sit one or two hops away in a helper; five is slack.
MAX_DEPTH = 5


# ===========================================================================
# The allowlist. One function + one expression per entry, each with a reason.
# ===========================================================================

#Rule A exceptions: request metadata that legitimately shapes a write.
#``CLAUDE.md``'s price of admission is that it is declared in ``f2z.yaml``;
#the two provider-webhook entries are outside the client contract entirely.
ALLOWED_METADATA_IN_WRITE = {
    (
        "dj/apps/ztripe/views.py::native_checkout_success -> dj/apps/ztripe/views.py::_one_query",
        "request.GET",
    ): "The declared signed Stripe return query selects validation input only; "
       "the sole write is releasing this GET's internal token-owned cache "
       "semaphore, and no query value is persisted.",
    (
        "dj/apps/oidc/views.py::IntrospectView.post -> dj/apps/oidc/views.py::_basic_client_credentials",
        "request.headers['Authorization']",
    ): "RFC 7662 §2.1 client authentication (`client_secret_basic`) for token "
       "introspection (#2233): names the confidential client asking, declared "
       "as a header OpenApiParameter with its 401 failure mode; nothing from "
       "it is stored and the endpoint writes nothing.",
    (
        "dj/apps/dyte/views.py::webhook -> dj/apps/dyte/views.py::authenticate_dyte_webhook",
        "request.headers['dyte-signature']",
    ): "Dyte webhook HMAC signature — provider auth, outside the client "
       "contract.",
    (
        "dj/apps/dyte/views.py::webhook -> dj/apps/dyte/views.py::authenticate_dyte_webhook",
        "request.headers['rtk-signature']",
    ): "The legacy RealtimeKit spelling of the same HMAC signature header.",
    (
        "dj/apps/dyte/views.py::webhook -> dj/apps/dyte/views.py::get_provider_event_id",
        "request.headers['dyte-uuid']",
    ): "The provider's event id, stored as the replay-suppression primary "
       "key.",
    (
        "dj/apps/dyte/views.py::webhook -> dj/apps/dyte/views.py::get_provider_event_id",
        "request.headers['rtk-uuid']",
    ): "The legacy RealtimeKit spelling of the same provider event id.",
    (
        "dj/apps/dyte/views.py::webhook_recording_status_update -> dj/apps/dyte/views.py::authenticate_dyte_webhook",
        "request.headers['dyte-signature']",
    ): "Dyte webhook HMAC signature — provider auth, outside the client "
       "contract.",
    (
        "dj/apps/dyte/views.py::webhook_recording_status_update -> dj/apps/dyte/views.py::authenticate_dyte_webhook",
        "request.headers['rtk-signature']",
    ): "The legacy RealtimeKit spelling of the same HMAC signature header.",
    (
        "dj/apps/dyte/views.py::webhook_recording_status_update -> dj/apps/dyte/views.py::get_provider_event_id",
        "request.headers['dyte-uuid']",
    ): "The provider's event id, stored as the replay-suppression primary "
       "key.",
    (
        "dj/apps/dyte/views.py::webhook_recording_status_update -> dj/apps/dyte/views.py::get_provider_event_id",
        "request.headers['rtk-uuid']",
    ): "The legacy RealtimeKit spelling of the same provider event id.",
    (
        "dj/apps/dyte/views.py::webhook -> dj/apps/dyte/views.py::_webhook_identity",
        "request.headers['dyte-uuid']",
    ): "Log-only (#2102): the same provider event id, copied bounded into "
       "the outcome log line; never written to the database.",
    (
        "dj/apps/dyte/views.py::webhook -> dj/apps/dyte/views.py::_webhook_identity",
        "request.headers['rtk-uuid']",
    ): "Log-only (#2102): the RealtimeKit spelling of the same event id, "
       "copied into the outcome log line; never written to the database.",
    (
        "dj/apps/dyte/views.py::webhook_recording_status_update -> dj/apps/dyte/views.py::_webhook_identity",
        "request.headers['dyte-uuid']",
    ): "Log-only (#2102): the same provider event id, copied bounded into "
       "the outcome log line; never written to the database.",
    (
        "dj/apps/dyte/views.py::webhook_recording_status_update -> dj/apps/dyte/views.py::_webhook_identity",
        "request.headers['rtk-uuid']",
    ): "Log-only (#2102): the RealtimeKit spelling of the same event id, "
       "copied into the outcome log line; never written to the database.",
    (
        "dj/apps/emails/views.py::ConfirmEmailView.post -> dj/apps/emails/views.py::_posted_token",
        "request.query_params['token']",
    ): "RFC 8058 one-click unsubscribe POSTs a fixed body to a URL we "
       "published, so the token can only travel in the query string. Body "
       "first, query as the documented fallback; declared as "
       "LINK_TOKEN_PARAMETER (#1001).",
    (
        "dj/apps/emails/views.py::OptOutEmailView.post -> dj/apps/emails/views.py::_posted_token",
        "request.query_params['token']",
    ): "RFC 8058 one-click unsubscribe POSTs a fixed body to a URL we "
       "published, so the token can only travel in the query string. Body "
       "first, query as the documented fallback; declared as "
       "LINK_TOKEN_PARAMETER (#1001).",
    (
        "dj/apps/g12f/views/series.py::zPageClearLegacyView.delete",
        "request.query_params['free2zaddr']",
    ): "Deprecated alias kept for browser-cached classic bundles; carries "
       "an explicit OpenApiParameter and deprecated:true, superseded by "
       "the path form (#991). Remove with the classic UI (#953).",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.destroy_translation -> dj/apps/g12f/views/zpage.py::zPageView._stale_translation_editor_response",
        "request.headers['X-Free2Z-Source-Language']",
    ): "If-Match-style precondition; documented in f2z.yaml with the 409 "
       "spelled out. The model every other header exception should copy.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.translation -> dj/apps/g12f/views/zpage.py::zPageView._stale_translation_editor_response",
        "request.headers['X-Free2Z-Source-Language']",
    ): "If-Match-style precondition; documented in f2z.yaml with the 409 "
       "spelled out. The model every other header exception should copy.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.update -> dj/apps/g12f/views/zpage.py::_claimed_source_language",
        "request.headers['X-Free2Z-Source-Language']",
    ): "#2179: the label the client last read, which only decides whether an "
       "If-Match that differs solely by a background detector relabel may "
       "pass (never when the write sets source_language). Cannot supply a "
       "value to persist; declared in f2z.yaml as "
       "TRANSLATION_SOURCE_LANGUAGE_PARAMETER with the semantics spelled out.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.translation -> dj/apps/g12f/views/zpage.py::_claimed_source_language",
        "request.headers['X-Free2Z-Source-Language']",
    ): "#2179: the label the client last read, which only decides whether an "
       "If-Match that differs solely by a background detector relabel may "
       "pass (never when the write sets source_language). Cannot supply a "
       "value to persist; declared in f2z.yaml as "
       "TRANSLATION_SOURCE_LANGUAGE_PARAMETER with the semantics spelled out.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.variant_update -> dj/apps/g12f/views/zpage.py::_claimed_source_language",
        "request.headers['X-Free2Z-Source-Language']",
    ): "#2179: the label the client last read, which only decides whether an "
       "If-Match that differs solely by a background detector relabel may "
       "pass (never when the write sets source_language). Cannot supply a "
       "value to persist; declared in f2z.yaml as "
       "TRANSLATION_SOURCE_LANGUAGE_PARAMETER with the semantics spelled out.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.variant_partial_update -> dj/apps/g12f/views/zpage.py::_claimed_source_language",
        "request.headers['X-Free2Z-Source-Language']",
    ): "#2179: the label the client last read, which only decides whether an "
       "If-Match that differs solely by a background detector relabel may "
       "pass (never when the write sets source_language). Cannot supply a "
       "value to persist; declared in f2z.yaml as "
       "TRANSLATION_SOURCE_LANGUAGE_PARAMETER with the semantics spelled out.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.destroy -> dj/apps/g12f/preconditions.py::check_if_match",
        "request.headers['If-Match']",
    ): "The If-Match precondition (#1039). It cannot supply a value to "
       "persist -- it only decides whether the write happens at all -- and "
       "it is declared in f2z.yaml as IF_MATCH_PARAMETER with the 412 "
       "spelled out. Exactly the shape the X-Free2Z-Source-Language "
       "entries above set as the model.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.destroy -> dj/apps/g12f/views/zpage.py::zPageView._lock_and_check_precondition",
        "self.request.headers",
    ): "Presence check for the same declared If-Match precondition (#1039): "
       "the lock and the extra validator queries are skipped entirely when "
       "the header is absent, so an unconditional write keeps the exact "
       "query and lock profile it had before. Reads no value.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.destroy_translation -> dj/apps/g12f/preconditions.py::check_if_match",
        "request.headers['If-Match']",
    ): "The If-Match precondition (#1039). It cannot supply a value to "
       "persist -- it only decides whether the write happens at all -- and "
       "it is declared in f2z.yaml as IF_MATCH_PARAMETER with the 412 "
       "spelled out. Exactly the shape the X-Free2Z-Source-Language "
       "entries above set as the model.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.destroy_translation -> dj/apps/g12f/views/zpage.py::zPageView._delete_variant",
        "self.request.headers",
    ): "Presence check for the same declared If-Match precondition (#1039): "
       "the lock and the extra validator queries are skipped entirely when "
       "the header is absent, so an unconditional write keeps the exact "
       "query and lock profile it had before. Reads no value.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.translation -> dj/apps/g12f/preconditions.py::check_if_match",
        "request.headers['If-Match']",
    ): "The If-Match precondition (#1039). It cannot supply a value to "
       "persist -- it only decides whether the write happens at all -- and "
       "it is declared in f2z.yaml as IF_MATCH_PARAMETER with the 412 "
       "spelled out. Exactly the shape the X-Free2Z-Source-Language "
       "entries above set as the model.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.translation -> dj/apps/g12f/views/zpage.py::zPageView._save_variant",
        "request.headers",
    ): "Presence check for the same declared If-Match precondition (#1039): "
       "the lock and the extra validator queries are skipped entirely when "
       "the header is absent, so an unconditional write keeps the exact "
       "query and lock profile it had before. Reads no value.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.update -> dj/apps/g12f/preconditions.py::check_if_match",
        "request.headers['If-Match']",
    ): "The If-Match precondition (#1039). It cannot supply a value to "
       "persist -- it only decides whether the write happens at all -- and "
       "it is declared in f2z.yaml as IF_MATCH_PARAMETER with the 412 "
       "spelled out. Exactly the shape the X-Free2Z-Source-Language "
       "entries above set as the model.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.update -> dj/apps/g12f/views/zpage.py::zPageView._lock_and_check_precondition",
        "self.request.headers",
    ): "Presence check for the same declared If-Match precondition (#1039): "
       "the lock and the extra validator queries are skipped entirely when "
       "the header is absent, so an unconditional write keeps the exact "
       "query and lock profile it had before. Reads no value.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.variant_destroy -> dj/apps/g12f/preconditions.py::check_if_match",
        "request.headers['If-Match']",
    ): "The If-Match precondition (#1039). It cannot supply a value to "
       "persist -- it only decides whether the write happens at all -- and "
       "it is declared in f2z.yaml as IF_MATCH_PARAMETER with the 412 "
       "spelled out. Exactly the shape the X-Free2Z-Source-Language "
       "entries above set as the model.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.variant_destroy -> dj/apps/g12f/views/zpage.py::zPageView._delete_variant",
        "self.request.headers",
    ): "Presence check for the same declared If-Match precondition (#1039): "
       "the lock and the extra validator queries are skipped entirely when "
       "the header is absent, so an unconditional write keeps the exact "
       "query and lock profile it had before. Reads no value.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.variant_partial_update -> dj/apps/g12f/preconditions.py::check_if_match",
        "request.headers['If-Match']",
    ): "The If-Match precondition (#1039). It cannot supply a value to "
       "persist -- it only decides whether the write happens at all -- and "
       "it is declared in f2z.yaml as IF_MATCH_PARAMETER with the 412 "
       "spelled out. Exactly the shape the X-Free2Z-Source-Language "
       "entries above set as the model.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.variant_partial_update -> dj/apps/g12f/views/zpage.py::zPageView._save_variant",
        "request.headers",
    ): "Presence check for the same declared If-Match precondition (#1039): "
       "the lock and the extra validator queries are skipped entirely when "
       "the header is absent, so an unconditional write keeps the exact "
       "query and lock profile it had before. Reads no value.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.variant_update -> dj/apps/g12f/preconditions.py::check_if_match",
        "request.headers['If-Match']",
    ): "The If-Match precondition (#1039). It cannot supply a value to "
       "persist -- it only decides whether the write happens at all -- and "
       "it is declared in f2z.yaml as IF_MATCH_PARAMETER with the 412 "
       "spelled out. Exactly the shape the X-Free2Z-Source-Language "
       "entries above set as the model.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.variant_update -> dj/apps/g12f/views/zpage.py::zPageView._save_variant",
        "request.headers",
    ): "Presence check for the same declared If-Match precondition (#1039): "
       "the lock and the extra validator queries are skipped entirely when "
       "the header is absent, so an unconditional write keeps the exact "
       "query and lock profile it had before. Reads no value.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.translation -> dj/apps/g12f/preconditions.py::check_if_none_match",
        "request.headers",
    ): "Presence check for the declared If-None-Match precondition (#1363): "
       "presence, not truthiness, so an empty value is a 400 rather than a "
       "precondition that silently evaporated. Reads no value.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.translation -> dj/apps/g12f/preconditions.py::check_if_none_match",
        "request.headers['If-None-Match']",
    ): "The create-only twin of If-Match (#1363): `*` refuses the write with "
       "412 when the variant already exists, under the same lock. It cannot "
       "supply a value to persist -- only whether the write happens -- and "
       "is declared in f2z.yaml as IF_NONE_MATCH_PARAMETER with the 412 and "
       "the 400 spelled out.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.variant_partial_update -> dj/apps/g12f/preconditions.py::check_if_none_match",
        "request.headers",
    ): "Presence check for the declared If-None-Match precondition (#1363): "
       "presence, not truthiness, so an empty value is a 400 rather than a "
       "precondition that silently evaporated. Reads no value.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.variant_partial_update -> dj/apps/g12f/preconditions.py::check_if_none_match",
        "request.headers['If-None-Match']",
    ): "The create-only twin of If-Match (#1363): `*` refuses the write with "
       "412 when the variant already exists, under the same lock. It cannot "
       "supply a value to persist -- only whether the write happens -- and "
       "is declared in f2z.yaml as IF_NONE_MATCH_PARAMETER with the 412 and "
       "the 400 spelled out.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.variant_update -> dj/apps/g12f/preconditions.py::check_if_none_match",
        "request.headers",
    ): "Presence check for the declared If-None-Match precondition (#1363): "
       "presence, not truthiness, so an empty value is a 400 rather than a "
       "precondition that silently evaporated. Reads no value.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.variant_update -> dj/apps/g12f/preconditions.py::check_if_none_match",
        "request.headers['If-None-Match']",
    ): "The create-only twin of If-Match (#1363): `*` refuses the write with "
       "412 when the variant already exists, under the same lock. It cannot "
       "supply a value to persist -- only whether the write happens -- and "
       "is declared in f2z.yaml as IF_NONE_MATCH_PARAMETER with the 412 and "
       "the 400 spelled out.",
    (
        "dj/apps/g12f/views/translate.py::ZPageTranslationView.post -> dj/apps/g12f/views/translate.py::_idempotency_key",
        "request.headers['Idempotency-Key']",
    ): "Retry precondition for the paid AI translation purchase (#980 P8); "
       "REQUIRED in f2z.yaml and bound to the article, target language, "
       "content digest and confirmed price before any debit. The target "
       "language and the article come from the PATH, which identifies the "
       "resource; nothing about the charge comes from a URL.",
    (
        "dj/apps/g12f/views/translate_batch.py::ZPageTranslationJobsView.post -> dj/apps/g12f/views/translate.py::_idempotency_key",
        "request.headers['Idempotency-Key']",
    ): "Retry precondition for the BULK AI translation purchase (#2348); "
       "REQUIRED in f2z.yaml and bound to the article, the source digest and "
       "the exact set of (language, price) pairs before any debit. It names "
       "the batch and becomes each charge's `batch_id`; the article comes from "
       "the PATH and every language and price from the BODY.",
    (
        "dj/apps/tuzis/views.py::ConfirmedSubscribeView.post -> dj/apps/tuzis/views.py::_superseded_idempotency_key",
        "request.headers['X-Superseded-Idempotency-Key']",
    ): "The RETIRED half of the same retry precondition (#1585): a key a "
       "browser can no longer send as Idempotency-Key because it predates "
       "the UUIDv4 rule. Declared in f2z.yaml as "
       "SUPERSEDED_IDEMPOTENCY_KEY_PARAMETER with its failure mode. The "
       "retired VALUE is only ever looked up: it can replay a committed "
       "purchase, and it is never claimed, never bound to a price and never "
       "charged, and an unusable value is ignored rather than failing the "
       "write. A successful lookup does end the intent under the "
       "REPLACEMENT Idempotency-Key -- the body-derived receipt is recorded "
       "there so an older tab cannot spend it again -- which moves no 2Z "
       "and persists nothing the header supplied.",
    (
        "dj/apps/tuzis/views.py::CreatorSubscribeView.post -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "Idempotency-Key on the money path; documented in f2z.yaml as of "
       "#997. Blessed for this handler and this ONE header — the rest of "
       "tuzis/views.py moves money and stays under the rule, and so does "
       "any other header added here.",
    (
        "dj/apps/openai/views.py::ImageView.post",
        "request.headers['Idempotency-Key']",
    ): "The image-operation retry key, declared in OpenAPI/f2z.yaml with "
       "UUIDv4 validation and failure semantics. Its value is stored as an "
       "opaque receipt identifier scoped to the authenticated actor and exact "
       "image intent; it supplies no prompt, image, model, provider-choice, "
       "or billing data.",
    (
        "dj/apps/tuzis/views.py::CreatorSubscribeView.post",
        "request.headers['Idempotency-Key']",
    ): "The subscribe handler validates the documented Idempotency-Key "
       "before its shared parser; it selects the retry receipt and cannot "
       "supply subscription or charge data.",
    (
        "dj/apps/purchases/views.py::PurchaseIntentCreateView.post",
        "request.headers['Idempotency-Key']",
    ): "Spec-required retry key for creating a purchase intent (#2239, "
       "zuu purchase.md §1); REQUIRED in f2z.yaml via "
       "PURCHASE_IDEMPOTENCY_KEY_PARAMETER with its 400/409 failure modes. It "
       "selects the replay receipt only; price and quantity come from the "
       "body and the server's card_quote.",
    (
        "dj/apps/e2ee/views.py::ChatRequestView.post -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "Retry precondition for the paid encrypted chat request "
       "(free2z/zuu#1022); REQUIRED UUIDv4 in f2z.yaml via "
       "CONFIRMED_IDEMPOTENCY_KEY_PARAMETER and bound to the recipient before "
       "any debit. It only selects the replay receipt; the price is a "
       "server setting and the recipient comes from the path.",
    (
        "dj/apps/comments/views.py::CommentListCreateAPIView.create -> dj/apps/comments/views.py::_required_comment_key",
        "request.headers['Idempotency-Key']",
    ): "Retry precondition for paid zPage comments; the UUIDv4 key is "
       "declared in f2z.yaml and only selects the idempotency receipt.",
    (
        "dj/apps/comments/views.py::CommentListCreateAPIView.create -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "The shared UUIDv4 parser for the paid comment retry receipt; it "
       "does not provide a value persisted by the comment write.",
    (
        "dj/apps/comments/views.py::CommentViewSet.create -> dj/apps/comments/views.py::_required_comment_key",
        "request.headers['Idempotency-Key']",
    ): "Retry precondition for paid root comments; the key only selects "
       "the declared idempotency receipt.",
    (
        "dj/apps/comments/views.py::CommentViewSet.create -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "The shared UUIDv4 parser for the paid root-comment receipt; the key "
       "is not persisted as comment content.",
    (
        "dj/apps/comments/views.py::ParentCommentListCreateAPIView.create -> dj/apps/comments/views.py::_required_comment_key",
        "request.headers['Idempotency-Key']",
    ): "Retry precondition for paid replies; the key only selects the "
       "declared idempotency receipt.",
    (
        "dj/apps/comments/views.py::ParentCommentListCreateAPIView.create -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "The shared UUIDv4 parser for the paid reply receipt; it does not "
       "supply a value to the reply write.",
    (
        "dj/apps/comments/views.py::vote_comment -> dj/apps/comments/views.py::_required_comment_key",
        "request.headers['Idempotency-Key']",
    ): "Retry precondition for paid comment votes; the key only selects "
       "the declared idempotency receipt.",
    (
        "dj/apps/comments/views.py::vote_comment -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "The shared UUIDv4 parser for the paid comment-vote receipt; the key "
       "is not a vote value.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.create -> dj/apps/g12f/views/zpage.py::_required_page_key",
        "request.headers['Idempotency-Key']",
    ): "Optional retry key for page creation (#2079); declared in f2z.yaml "
       "as ZPAGE_CREATE_IDEMPOTENCY_PARAMETER with its 400/409 failure "
       "modes. It only selects the receipt that says which page an earlier "
       "create made; no value from it is written to the page.",
    (
        "dj/apps/g12f/views/zpage.py::zPageView.create -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "The shared UUIDv4 parser for the same page-creation receipt (#2079); "
       "the key is never page content.",
    (
        "dj/apps/g12f/views/zpage.py::FundPageView.post -> dj/apps/g12f/views/zpage.py::_required_page_key",
        "request.headers['Idempotency-Key']",
    ): "Retry precondition for page funding; the key only selects the "
       "declared idempotency receipt.",
    (
        "dj/apps/g12f/views/zpage.py::FundPageView.post -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "The shared UUIDv4 parser for the page-funding receipt; it does not "
       "provide a persisted funding amount.",
    (
        "dj/apps/g12f/views/zpage.py::vote_page -> dj/apps/g12f/views/zpage.py::_required_page_key",
        "request.headers['Idempotency-Key']",
    ): "Retry precondition for paid page votes; the key only selects the "
       "declared idempotency receipt.",
    (
        "dj/apps/g12f/views/zpage.py::vote_page -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "The shared UUIDv4 parser for the paid page-vote receipt; it is not a "
       "value used to calculate the vote.",
    (
        "dj/apps/openai/views.py::ImageView.post -> dj/apps/openai/views.py::_provider_claim",
        "request.headers['Idempotency-Key']",
    ): "Retry precondition for paid image generation; the key selects the "
       "provider/charge receipt and is declared in f2z.yaml.",
    (
        "dj/apps/openai/views.py::ImageView.post -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "The shared UUIDv4 parser for the paid image receipt; it does not "
       "supply a prompt or charge amount.",
    (
        "dj/apps/openai/views.py::PromptResponseViewSet.create -> dj/apps/openai/views.py::_provider_claim",
        "request.headers['Idempotency-Key']",
    ): "Retry precondition for paid prompt responses; the key selects the "
       "provider/charge receipt and is declared in f2z.yaml.",
    (
        "dj/apps/openai/views.py::PromptResponseViewSet.create -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "The shared UUIDv4 parser for the paid prompt-response receipt; it "
       "does not supply response content.",
    (
        "dj/apps/openai/views.py::MeteredPromptView.post",
        "request.headers['X-Expected-Actor']",
    ): "Optional account-switch precondition for the paid metered prompt; "
       "declared in f2z.yaml with its 409 account_changed response. A mismatch "
       "refuses before receipt claim, provider I/O, and debit, and the header "
       "never supplies the authenticated actor or persisted data.",
    (
        "dj/apps/openai/views.py::ImageView.post",
        "request.headers['X-Expected-Actor']",
    ): "Optional account-switch precondition for paid cover generation; declared "
       "in f2z.yaml with its 409 account_changed response. A mismatch refuses "
       "before receipt claim, provider I/O, and debit, and the header never "
       "supplies the authenticated actor or persisted data.",
    (
        "dj/apps/openai/views.py::ImageView.post",
        "request.headers['X-Require-Existing-Receipt']",
    ): "Replay-only precondition for an adopted legacy paid image key; declared "
       "in f2z.yaml. Existing receipts replay normally, while a fresh claim is "
       "released and refused before provider I/O or debit.",
    (
        "dj/apps/openai/views.py::PromptResponseViewSet.create",
        "request.headers['X-AI-Generation-Model']",
    ): "Legacy model-inclusive receipt discriminator for retries after the "
       "conversation model changes. It is declared in f2z.yaml and is used "
       "only to match and replay the old receipt; it never selects a model "
       "for generation or supplies persisted/charged data.",
    (
        "dj/apps/openai/views.py::MeteredPromptView.post -> dj/apps/openai/views.py::_provider_claim",
        "request.headers['Idempotency-Key']",
    ): "Retry precondition for the paid metered prompt endpoint (#643); the "
       "key selects its provider/charge receipt and is declared in f2z.yaml.",
    (
        "dj/apps/openai/views.py::MeteredPromptView.post -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "The shared UUIDv4 parser for the paid metered prompt receipt; it "
       "does not supply prompt, model or charge data.",
    (
        "dj/apps/openai/views.py::PromptView.post -> dj/apps/openai/views.py::_provider_claim",
        "request.headers['Idempotency-Key']",
    ): "Retry precondition for the paid prompt endpoint; the key selects its "
       "provider/charge receipt and is declared in f2z.yaml.",
    (
        "dj/apps/openai/views.py::PromptView.post -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "The shared UUIDv4 parser for the paid prompt receipt; it does not "
       "supply prompt or response data.",
    (
        "dj/apps/storytime/views.py::ImageView.post -> dj/apps/storytime/views.py::_provider_claim",
        "request.headers['Idempotency-Key']",
    ): "Retry precondition for paid storytime images; the key selects the "
       "provider/charge receipt and is declared in f2z.yaml.",
    (
        "dj/apps/storytime/views.py::ImageView.post -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "The shared UUIDv4 parser for the paid storytime-image receipt; it "
       "does not supply image content.",
    (
        "dj/apps/storytime/views.py::PromptView.post -> dj/apps/storytime/views.py::_provider_claim",
        "request.headers['Idempotency-Key']",
    ): "Retry precondition for paid storytime prompts; the key selects the "
       "provider/charge receipt and is declared in f2z.yaml.",
    (
        "dj/apps/storytime/views.py::PromptView.post -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "The shared UUIDv4 parser for the paid storytime-prompt receipt; it "
       "does not supply prompt or response data.",
    (
        "dj/apps/tuzis/views.py::ConfirmedSubscribeView.post -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "The shared UUIDv4 parser for the explicit confirmed-subscription "
       "retry receipt; the key is declared in f2z.yaml.",
    (
        "dj/apps/tuzis/views.py::IdempotentDonate2Z.post -> dj/apps/tuzis/models.py::request_key",
        "request.headers['Idempotency-Key']",
    ): "The shared UUIDv4 parser for the explicit donation retry receipt; the "
       "key is declared in f2z.yaml.",
    (
        "dj/apps/uploads/views.py::upload_limit",
        "request.headers['X-Original-Content-Length']",
    ): "nginx auth_request subrequest: nginx sets the header, the view "
       "answers 204/403 and reaches no write at all.",
    (
        "dj/apps/uploads/views.py::uploads_auth -> dj/apps/uploads/views.py::_original_uri",
        "request.META['HTTP_X_ORIGINAL_URI']",
    ): "Same nginx auth_request path: X-Original-URI is set by nginx and "
       "the handler only authorizes, never writes. It reaches Rule A at "
       "all because an undecorated function view accepts every verb.",
    (
        "dj/apps/uploads/views.py::uploads_auth_private -> dj/apps/uploads/views.py::_original_uri",
        "request.META['HTTP_X_ORIGINAL_URI']",
    ): "Same nginx auth_request path: X-Original-URI is set by nginx and "
       "the handler only authorizes, never writes. It reaches Rule A at "
       "all because an undecorated function view accepts every verb.",
    (
        "dj/apps/uploads/views.py::uploads_auth_public -> dj/apps/uploads/views.py::_original_uri",
        "request.META['HTTP_X_ORIGINAL_URI']",
    ): "Same nginx auth_request path: X-Original-URI is set by nginx and "
       "the handler only authorizes, never writes. It reaches Rule A at "
       "all because an undecorated function view accepts every verb.",
    (
        "dj/apps/uploads/views.py::uploads_auth_public_hls -> dj/apps/uploads/views.py::_original_uri",
        "request.META['HTTP_X_ORIGINAL_URI']",
    ): "Same nginx auth_request path: X-Original-URI is set by nginx and "
       "the handler only authorizes, never writes. It reaches Rule A at "
       "all because an undecorated function view accepts every verb.",
    (
        "dj/apps/ztripe/views.py::create_checkout_session -> dj/apps/ztripe/views.py::_checkout_return_origin",
        "request.headers['Origin']",
    ): "Origin allow-listed against CSRF_TRUSTED_ORIGINS with a safe "
       "fallback; picks a redirect target, never persisted.",
    (
        "dj/apps/ztripe/views.py::stripe_webhook",
        "request.headers['STRIPE_SIGNATURE']",
    ): "Standard Stripe webhook signature verification — provider auth, "
       "outside the client contract.",
    # -- Below here the handler is a GET that nonetheless reaches a write, so
    #    Rule A applies to it as well (see read_paths_that_write). These are the
    #    OAuth flows, where the protocol itself puts the parameters in the query
    #    string and the redirect is a GET -- the one place a query parameter
    #    legitimately drives a write.
    (
        "dj/apps/social/views.py::SocialStartView.get",
        "request.query_params['redirect_uri']",
    ): "RFC 6749 puts redirect_uri in the authorize query string; it is "
       "persisted on the state row. Allow-listed against "
       "SOCIAL_REDIRECT_URI_ALLOWLIST before it is stored.",
    (
        "dj/apps/social/views.py::SocialStartView.get",
        "request.query_params['code_challenge']",
    ): "RFC 7636 PKCE challenge, likewise query-string by protocol and pinned "
       "to S256 before it is persisted on the state row.",
    (
        "dj/apps/social/views.py::ZuuliMobileOAuthRelayView.get",
        "request.query_params['state']",
    ): "OAuth callback: the provider redirects the browser with a GET. `state` "
       "is the server-generated single-use value being redeemed, not a value "
       "the caller invents.",
    (
        "dj/apps/social/views.py::ZuuliMobileOAuthRelayView.get",
        "request.query_params['code']",
    ): "Same provider callback: the authorization code is exchanged with the "
       "provider, never stored as given.",
    (
        "dj/apps/social/views.py::ZuuliMobileOAuthRelayView.get",
        "request.query_params['error']",
    ): "Same provider callback, error leg — decides which failure to render.",
    (
        "dj/apps/twitter/views.py::TwitterCallbackView.get",
        "request.GET",
    ): "`if 'error' in request.GET` on the Twitter OAuth2 callback — a "
       "membership test that selects the error branch.",
    (
        "dj/apps/twitter/views.py::TwitterCallbackView.get",
        "request.GET['error']",
    ): "The provider's error string, escaped into the rendered response and "
       "never persisted.",
    (
        "dj/apps/twitter/views.py::TwitterCallbackView.get -> "
        "dj/apps/twitter/views.py::is_valid_twitter_request",
        "request.GET['state']",
    ): "Checked against the handshake cookie before anything is written — this "
       "read is the CSRF defence for the callback, not an input to it.",
    (
        "dj/apps/g12f/views/account_deletion.py::AccountDeletionKeepView.post",
        "request.COOKIES['f2z_keep']",
    ): "The keep token's browser binding (login-CSRF defence, account "
       "deletion grace period): a nonce this server set with the 409 that "
       "issued the token, compared to the hash signed into it. An If-Match-"
       "style precondition, declared as a cookie OpenApiParameter with its "
       "400 failure mode; nothing from it is stored.",
    (
        "dj/apps/twitter/views.py::TwitterCallbackView.get -> "
        "dj/apps/twitter/views.py::read_oauth2_handshake",
        "request.COOKIES['twitter_oauth2_handshake']",
    ): "The OAuth2 handshake this server signed and set at `/api/twitter/"
       "start` (#1572, which moved it out of `request.session` so an "
       "anonymous GET stops minting a session row). It is the callback's "
       "If-Match-style precondition — the browser binding that makes `state` "
       "mean 'the flow THIS browser began' — plus the PKCE `code_verifier` "
       "handed straight back to the provider. Nothing in it is persisted: "
       "what gets stored is the provider's response.",
    # `is_valid_twitter_request` no longer reads `request.GET['code']`. Its
    # entry claimed a "presence check", but the read was `code = request.GET
    #.get('code')` with `code` never used again — ruff flagged it F841 and
    #  deleted it. One fewer request-metadata read on a write path, and
    # this guard is what proved the allowlist entry had gone stale.
    (
        "dj/apps/twitter/views.py::TwitterCallbackView.get -> "
        "dj/apps/twitter/views.py::get_twitter_user",
        "request.GET['code']",
    ): "The authorization code, exchanged with Twitter for tokens. What gets "
       "persisted is the provider's response, not the query parameter.",
}

#Rule B exceptions: reads that legitimately write.
ALLOWED_WRITE_IN_READ = {
    (
        "dj/apps/exports/views.py::PublicationExportListCreateView.get",
        "job.save(...)",
    ): "Expires a completed export lazily while reading the authenticated "
       "creator's own job; the request selects no mutable state.",
    (
        "dj/apps/exports/views.py::PublicationExportDetailView.get",
        "job.save(...)",
    ): "Expires a completed export lazily while reading the authenticated "
       "creator's own job; the request selects no mutable state.",
    (
        "dj/apps/exports/views.py::PublicationExportDownloadView.get",
        "job.save(...)",
    ): "Marks an unavailable, owner-scoped export as expired while handling "
       "its authenticated creator's download request; no request metadata is "
       "persisted.",
    (
        "dj/apps/ztripe/views.py::native_checkout_success -> dj/apps/ztripe/native_return.py::release_native_return_provider_slot",
        "cache.delete(...)",
    ): "Releases only the unique cache semaphore token acquired by this same "
       "GET before its bounded Stripe lookup; it cannot write product or money "
       "state and the TTL remains crash recovery.",
    (
        "dj/apps/health/views.py::readyz -> dj/apps/health/views.py::_db_ok",
        "_cache.update(...)",
    ): "A module-level dict holding a 15s in-process TTL — dict.update(), "
       "not QuerySet.update().",
    (
        "dj/apps/purchases/views.py::PurchaseIntentDetailView.get -> dj/apps/purchases/services.py::_link_card_payment",
        "PurchaseReceipt.objects.get_or_create(...)",
    ): "Rollout-window catch-up (#2239): links a card payment a previous-"
       "release pod ALREADY credited to the caller's own intent. Reached only "
       "when that CheckoutIntent is fulfilled; idempotent on the payment's "
       "unique (rail, provider_event_id); moves no 2Z; nothing from the "
       "request is persisted.",
    (
        "dj/apps/kyc/views.py::IdentityDocumentsView.get",
        "UserProfile.objects.get_or_create(...)",
    ): "Lazy profile row keyed only on the authenticated identity — no "
       "request metadata reaches it and the row would exist anyway.",
    (
        "dj/apps/kyc/views.py::TaxFormSignatureView.get",
        "UserProfile.objects.get_or_create(...)",
    ): "Lazy profile row keyed only on the authenticated identity — no "
       "request metadata reaches it and the row would exist anyway.",
    (
        "dj/apps/kyc/views.py::UserProfileBasicInfoView.get",
        "UserProfile.objects.get_or_create(...)",
    ): "Lazy profile row keyed only on the authenticated identity — no "
       "request metadata reaches it and the row would exist anyway.",
    (
        "dj/apps/social/views.py::SocialStartView.get -> dj/apps/social/state.py::store_state",
        "SocialState.objects.update_or_create(...)",
    ): "OAuth state issued on the authorize redirect; server-generated, "
       "S256-pinned, allow-listed redirect_uri.",
    (
        "dj/apps/social/views.py::SocialStartView.get -> dj/apps/social/views.py::_allowed_origins",
        "origins.update(...)",
    ): "set.update() over two settings lists — not QuerySet.update().",
    (
        "dj/apps/social/views.py::ZuuliMobileOAuthRelayView.get -> dj/apps/social/state.py::pop_state",
        "row.delete(...)",
    ): "Single-use OAuth state consumed on callback — the deletion IS the "
       "replay protection.",
    (
        "dj/apps/social/views.py::ZuuliMobileOAuthRelayView.get -> dj/apps/social/state.py::store_state",
        "SocialState.objects.update_or_create(...)",
    ): "Same server-generated OAuth state, re-issued for the mobile relay "
       "leg.",
    (
        "dj/apps/tagging/admin.py::TaggitAdmin.changelist_view -> dj/apps/openai/models.py::combine_tags",
        "content_object.tags.add(...)",
    ): "Django admin serves GET and POST from one changelist_view; the tag "
       "merge runs strictly inside `if request.method == 'POST'` "
       "(tagging/admin.py:21).",
    (
        "dj/apps/tagging/admin.py::TaggitAdmin.changelist_view -> dj/apps/openai/models.py::combine_tags",
        "content_object.tags.remove(...)",
    ): "Django admin serves GET and POST from one changelist_view; the tag "
       "merge runs strictly inside `if request.method == 'POST'` "
       "(tagging/admin.py:21).",
    (
        "dj/apps/tagging/admin.py::TaggitAdmin.changelist_view -> dj/apps/openai/models.py::combine_tags",
        "tag_b.delete(...)",
    ): "Django admin serves GET and POST from one changelist_view; the tag "
       "merge runs strictly inside `if request.method == 'POST'` "
       "(tagging/admin.py:21).",
    (
        "dj/apps/twitter/views.py::TwitterCallbackView.get",
        "TwitterProfile.objects.get_or_create(...)",
    ): "OAuth2 callback: GET is forced by the provider redirect, and "
       "`state` is checked against the session before anything is written.",
    (
        "dj/apps/twitter/views.py::TwitterCallbackView.get",
        "twitter_profile.save(...)",
    ): "Same OAuth2 callback, persisting the tokens the provider just "
       "returned.",
    (
        "dj/apps/twitter/views.py::TwitterCallbackView.get -> dj/apps/twitter/views.py::TwitterCallbackView.handle_new_twitter_user",
        "User.objects.create(...)",
    ): "Account creation on first Twitter login, reached only from the "
       "state-checked callback above.",
    (
        "dj/apps/twitter/views.py::TwitterCallbackView.get -> dj/apps/twitter/views.py::TwitterCallbackView.handle_new_twitter_user",
        "new_user.save(...)",
    ): "Account creation on first Twitter login, reached only from the "
       "state-checked callback above.",
    (
        "dj/apps/twitter/views.py::TwitterCallbackView.get -> dj/apps/twitter/views.py::TwitterCallbackView.handle_new_twitter_user",
        "twitter_profile.save(...)",
    ): "Account creation on first Twitter login, reached only from the "
       "state-checked callback above.",
    (
        "dj/apps/twitter/views.py::TwitterCallbackView.get -> dj/apps/tuzis/grants.py::issue_grant",
        "TuziGrant.objects.create(...)",
    ): "The welcome-grant receipt (#2698) for the account the state-checked "
       "callback just created, in the same transaction. Keyed on the X user "
       "id across all accounts, so a replayed GET can never grant twice; "
       "nothing from the URL is stored.",
    (
        "dj/apps/twitter/views.py::TwitterCallbackView.get -> dj/apps/tuzis/grants.py::issue_grant",
        "TuziGrant.objects.filter().update(...)",
    ): "Same welcome-grant receipt: writes back the balance the ledger "
       "credit reported.",
    (
        "dj/apps/twitter/views.py::TwitterCallbackView.get -> "
        "dj/apps/identity/auth_context.py::record_login",
        "session.save(...)",
    ): "The sign-in's AuthContext (#2242), keyed to the session `login()` "
       "just created on the same state-checked callback. The save only runs "
       "for a session backend that creates keys lazily; nothing from the "
       "URL is stored.",
    # The three ``stripe_webhook`` entries that lived here are GONE, and their
    # absence is the record: F9 said "the durable fix is @require_POST on the
    # view -- hardening reported with this PR, not made here".  made it.
    # The view now pins POST, so it is no longer a read context at all and the
    # 2Z-minting write behind it needs no amnesty. Deleting the entries rather
    # than rewording them is what turns this guard into the regression test:
    # drop the decorator and all three findings come back unallowed.
}

#Reviewed, judged wrong, NOT fixed here. This file adds a test; fixing a live
#finding belongs in its own PR with its own review. Entries must be live: when
#the code is fixed this test fails until the entry is deleted, so the bucket
#cannot quietly become a second allowlist.
#EMPTY, and that is the point. The three ``request.get_host()`` entries this
#bucket shipped with ( — the Host header choosing the origin of the
#password-reset and confirmation links we mail) were fixed by building every
#emailed link from ``CANONICAL_ORIGIN``; see ``dj.apps.emails.link_origin``.
#The mailer functions no longer take a host argument at all, so there is no
#parameter left to wire back up to the request. Deleting the entries — rather
#than moving them into an allowlist — is what turns this guard into the
#regression test for that vulnerability.
KNOWN_UNFIXED = {}


# ===========================================================================
# Vocabulary: what counts as metadata, and what counts as a write
# ===========================================================================

#Attributes carrying client-controlled metadata from outside the body.
METADATA_ATTRS = {"query_params", "GET", "headers", "COOKIES", "META"}

#Accessors that read the same thing through a method.
METADATA_METHODS = {"get_host", "get_port", "get_signed_cookie"}

#Names a request object is bound to. ``self.request`` / ``view.request`` and
#any other ``<x>.request`` are matched structurally by _is_request_expr.
REQUEST_NAMES = {"request", "req", "_request", "drf_request", "http_request"}

#Methods that persist. ``update`` is here for QuerySet.update; the handful of
#dict/set false positives it drags in are allowlisted by name above rather
#than suppressed by a receiver heuristic -- a blanket "receivers called
#`data`/`state`/`result` are not models" rule would have hidden real writes.
WRITE_METHODS = {
    "save", "delete", "create", "update",
    "get_or_create", "update_or_create",
    "bulk_create", "bulk_update",
    # async ORM
    "asave", "adelete", "acreate", "aupdate",
    "aget_or_create", "aupdate_or_create", "abulk_create", "abulk_update",
}

#Relation mutators. Restricted to an attribute receiver (``obj.field.add()``)
#so ``set()``/``list.remove()``/``dict.clear()`` do not flood the check.
RELATION_METHODS = {"add", "remove", "set", "clear"}

#First words of raw SQL that writes.
RAW_WRITE_VERBS = ("insert", "update", "delete", "truncate", "alter", "drop")


# ===========================================================================
# Handler classification
# ===========================================================================

UNSAFE_VERBS = {"post", "put", "patch", "delete"}
SAFE_VERBS = {"get", "head", "options"}

#Method names Django/DRF route to an unsafe verb, or that persist by
#contract. ``save`` covers serializer and model overrides.
WRITE_HANDLER_NAMES = {
    "post", "put", "patch", "delete",
    "create", "update", "partial_update", "destroy",
    "perform_create", "perform_update", "perform_destroy",
    "save",
    # A dispatch() override runs for every verb, so it is both a write handler
    # and (below) a read handler. An ordinary CBV has no @action map and no
    # method named get/post, so nothing else would classify it.
    "dispatch",
}

#Method names Django/DRF route to a safe verb. ``head`` and ``options`` are
#here because they are in SAFE_VERBS: a write behind either is just as
#reachable by a scanner as one behind GET.
READ_HANDLER_NAMES = {"get", "list", "retrieve", "head", "options", "dispatch"}

#Decorators pinning a function to verbs: name -> (keyword, positional index).
_METHOD_DECORATORS = {
    "action": ("methods", None),
    "api_view": (None, 0),
    "require_http_methods": (None, 0),
}

#django-ninja: ``@router.post("/x")``. Matched on the receiver name so an
#arbitrary ``foo.get(...)`` decorator is not mistaken for a route.
NINJA_RECEIVERS = {"router", "api", "app"}


class UnresolvableMethods(Exception):
    """A route decorator's verb list is not a literal, so it cannot be
    classified -- and the guard refuses to guess. See
    test_route_decorators_declare_literal_methods."""


# ===========================================================================
# AST helpers
# ===========================================================================

SKIP_DIR_NAMES = {
    "migrations", "tests", "node_modules", "__pycache__",
    ".venv", "venv", "site-packages",
}


def _is_test_file(path: Path) -> bool:
    return path.name.startswith("test_") or path.name.endswith("_test.py")


def _python_files(root: Path):
    for path in sorted(root.rglob("*.py")):
        rel = path.relative_to(root)
        if any(part in SKIP_DIR_NAMES for part in rel.parts):
            continue
        if _is_test_file(path):
            continue
        yield path


def _module_name(path: Path, root: Path) -> str:
    parts = list(path.relative_to(root).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _dotted(node: ast.AST) -> str:
    """``self.request.session`` -> ``"self.request.session"``; "" if the
    expression is not a plain dotted name."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value)
        return f"{base}.{node.attr}" if base else ""
    if isinstance(node, ast.Call):
        return _dotted(node.func)
    return ""


def _is_request_expr(node: ast.AST, names: set = None) -> bool:
    """Does this expression evaluate to the request?

    Covers the plain name, any ``<x>.request`` attribute, and -- the one that
    matters most -- the two ways a *serializer* reaches the request:
    ``self.context['request']`` and ``self.context.get('request')``.  F1
    used the second form, so a check that only knew ``request.query_params``
    would have missed the finding that started the whole audit."""
    names = REQUEST_NAMES if names is None else names
    if isinstance(node, ast.Name):
        return node.id in names
    if isinstance(node, ast.Attribute):
        return node.attr in names
    if isinstance(node, ast.Subscript):
        key = node.slice
        return isinstance(key, ast.Constant) and key.value in names
    if isinstance(node, ast.Call):
        func = node.func
        return (
            isinstance(func, ast.Attribute)
            and func.attr in ("get", "pop")
            and bool(node.args)
            and isinstance(node.args[0], ast.Constant)
            and node.args[0].value in names
        )
    return False


def _render(node: ast.AST) -> str:
    """A readable source-ish rendering of an expression, for failure output.

    Separate from ``_dotted`` on purpose: ``_dotted`` feeds call resolution and
    must stay conservative, while this only has to be legible in a message."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _render(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    if isinstance(node, ast.Subscript):
        key = node.slice
        inner = repr(key.value) if isinstance(key, ast.Constant) else "..."
        return f"{_render(node.value)}[{inner}]"
    if isinstance(node, ast.Call):
        arg = ""
        if node.args and isinstance(node.args[0], ast.Constant):
            arg = repr(node.args[0].value)
        return f"{_render(node.func)}({arg})"
    return "<expr>"


def _decorator_tail(node: ast.AST) -> str:
    if isinstance(node, ast.Call):
        return _decorator_tail(node.func)
    dotted = _dotted(node)
    return dotted.rsplit(".", 1)[-1] if dotted else ""


def _literal_verbs(node: ast.AST) -> set[str]:
    """Lowercased verbs from a literal list/tuple/set of strings.

    Case-insensitive on purpose: ``methods=['POST']`` and ``methods=('post',)``
    are the same route, and a check that only matched one spelling would be a
    one-character evasion.
    """
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return {node.value.lower()}
    if not isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        raise UnresolvableMethods(ast.dump(node)[:100])
    verbs = set()
    for elt in node.elts:
        if not (isinstance(elt, ast.Constant) and isinstance(elt.value, str)):
            raise UnresolvableMethods(ast.dump(elt)[:100])
        verbs.add(elt.value.lower())
    return verbs


def _decorator_verbs(func, imports: dict = None, aliases: dict = None) -> set[str] | None:
    """HTTP verbs the decorators pin this function to, or None if none say.

    ``imports`` maps a local alias to ``"module:original"``, so
    ``from rest_framework.decorators import api_view as endpoint`` is still
    recognised. Matching the source spelling alone would let a one-line alias
    hide a route from both invariants."""
    imports, aliases = imports or {}, aliases or {}
    verbs: set[str] | None = None
    for dec in func.decorator_list:
        tail = _decorator_tail(dec)
        # Resolve back to the original name, through either an import alias
        # (`import api_view as endpoint`) or a plain assignment
        # (`endpoint = api_view`). Both are one-line ways to make a route
        # invisible to a spelling-based classifier.
        for _ in range(4):
            resolved = imports.get(tail, "").partition(":")[2] or aliases.get(tail)
            if not resolved or resolved == tail:
                break
            tail = resolved

        if tail == "require_POST":
            verbs = (verbs or set()) | {"post"}
            continue
        if tail in ("require_GET", "require_safe"):
            verbs = (verbs or set()) | {"get"}
            continue

        # django-ninja: @router.post("/path",...)
        if tail in UNSAFE_VERBS | SAFE_VERBS:
            head = _dotted(dec.func if isinstance(dec, ast.Call) else dec)
            head = head.rsplit(".", 2)[0] if head.count(".") >= 1 else ""
            if head in NINJA_RECEIVERS or head.endswith(("router", "api")):
                verbs = (verbs or set()) | {tail}
                continue

        spec = _METHOD_DECORATORS.get(tail)
        if spec is None:
            continue
        kw_name, pos = spec
        node = None
        if isinstance(dec, ast.Call):
            if kw_name is not None:
                for kw in dec.keywords:
                    if kw.arg == kw_name:
                        node = kw.value
            if node is None and pos is not None and len(dec.args) > pos:
                node = dec.args[pos]
        if node is None:
            if tail == "action":
                verbs = (verbs or set()) | {"get"}  # DRF's default
            continue
        verbs = (verbs or set()) | _literal_verbs(node)
    return verbs


@dataclass(frozen=True)
class Hit:
    """One offending expression, with the function that owns it."""

    kind: str            # "metadata" | "write"
    detail: str          # "request.query_params" | "obj.save(...)"
    owner: str           # "dj/apps/x/views.py::Class.method"
    path: str
    lineno: int

    @property
    def key(self):
        return (self.owner, self.detail)


@dataclass
class FuncInfo:
    module: str
    path: str            # repo-relative, e.g. "dj/apps/dyte/views.py"
    qualname: str
    node: ast.AST
    class_stack: tuple
    imports: dict = field(default_factory=dict)
    local_imports: dict = field(default_factory=dict)
    #NAME = OTHER_NAME assignments, so `endpoint = api_view` is resolved too.
    name_aliases: dict = field(default_factory=dict)
    direct_hits: list = field(default_factory=list)
    calls: list = field(default_factory=list)
    #(call target, positions/keywords the request was passed in)
    request_args: list = field(default_factory=list)
    #Parameter names bound to the request by a caller (see _propagate_taint).
    tainted_params: set = field(default_factory=set)

    def lookup_import(self, name):
        """Function-local imports shadow module-level ones, as Python does."""
        return self.local_imports.get(name) or self.imports.get(name)

    @property
    def key(self):
        return f"{self.module}:{self.qualname}"

    @property
    def label(self):
        return f"{self.path}::{self.qualname}"

    @property
    def display(self):
        return f"{self.path}:{self.node.lineno} {self.qualname}"

    def verbs(self):
        return _decorator_verbs(
            self.node,
            {**self.imports, **self.local_imports},
            self.name_aliases,
        )

    def is_write_context(self) -> bool:
        verbs = self.verbs()
        if verbs is not None:
            return bool(verbs & UNSAFE_VERBS)
        name = self.node.name
        if name in WRITE_HANDLER_NAMES:
            return True
        return name.startswith("validate") and bool(self.class_stack)

    def is_read_context(self) -> bool:
        """Note the missing ``and not (verbs & UNSAFE_VERBS)``: a route
        declaring ``methods=['GET', 'POST']`` is a read context *as well as* a
        write context. Excluding it because POST is present would mean any
        handler accepting both verbs could write unconditionally -- including on
        the GET a prefetcher sends -- and never be seen."""
        verbs = self.verbs()
        if verbs is not None:
            return bool(verbs & SAFE_VERBS)
        return self.node.name in READ_HANDLER_NAMES and bool(self.class_stack)


class _BodyScanner:
    """Records metadata reads, writes and outgoing calls in one function."""

    def __init__(self, info: FuncInfo, scope: dict = None, aliases: dict = None,
                 request_names: set = None):
        self.info = info
        self.scope = scope or {}
        self.aliases = aliases or {}
        #Names bound to the request *in this function*. Starts as the usual
        #spellings and grows by argument propagation: if a handler calls
        #``apply_credit(request)`` and that helper's parameter is called
        #``incoming``, then ``incoming`` is the request inside it. Without
        #that, renaming a parameter is enough to hide a header-driven write.
        self.request_names = request_names or REQUEST_NAMES

    def _name_value(self, name, hops=4):
        """Follow ``NAME = OTHER_NAME`` chains to a string, or give up."""
        while hops > 0:
            if name in self.scope:
                return self.scope[name]
            if name not in self.aliases:
                return None
            name = self.aliases[name]
            hops -= 1
        return None

    def _const(self, node):
        """The string value of a literal, a constant, or ``self.CONST``.

        The two most sensitive metadata reads in this repo -- the money path's
        ``Idempotency-Key`` and the zPage source-language precondition -- name
        their header through a constant, and the money one through *two* levels
        of indirection across two modules. Unresolved, both collapse to a bare
        ``request.headers`` allowlist key, which is exactly the over-blessing
        that would let a later ``X-Credit-Amount`` read slip unnoticed into an
        already-allowed money handler."""
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.Name):
            return self._name_value(node.id)
        if isinstance(node, ast.Attribute):
            return self._name_value(node.attr)
        return None

    def _named_lookups(self):
        """``{id(metadata attribute node): 'the parameter read from it'}``.

        Without this every read of ``request.headers`` in a function shares one
        allowlist key, so blessing ``Idempotency-Key`` on the money endpoint
        would silently bless any header added there later."""
        named = {}
        for node in ast.walk(self.info.node):
            target = key = None
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("get", "getlist", "pop")
                and node.args
            ):
                target, key = node.func.value, self._const(node.args[0])
            elif isinstance(node, ast.Subscript):
                target, key = node.value, self._const(node.slice)
            if key is None:
                continue
            if (
                isinstance(target, ast.Attribute)
                and target.attr in METADATA_ATTRS
                and _is_request_expr(target.value, self.request_names)
            ):
                named[id(target)] = key
        return named

    def _with_local_aliases(self):
        """Grow ``request_names`` with local aliases: ``incoming = request``.

        One assignment was otherwise enough to strip the taint before a call,
        which defeats the argument propagation above entirely."""
        names = set(self.request_names)
        for _ in range(4):
            added = False
            for node in ast.walk(self.info.node):
                if isinstance(node, ast.Assign):
                    targets, value = node.targets, node.value
                elif isinstance(node, ast.AnnAssign) and node.value is not None:
                    targets, value = [node.target], node.value
                elif isinstance(node, ast.NamedExpr):
                    targets, value = [node.target], node.value
                else:
                    continue
                if not _is_request_expr(value, names):
                    continue
                for target in targets:
                    if isinstance(target, ast.Name) and target.id not in names:
                        names.add(target.id)
                        added = True
            if not added:
                break
        return names

    def scan(self):
        self.request_names = self._with_local_aliases()
        self._named = self._named_lookups()
        for node in ast.walk(self.info.node):
            self._metadata(node)
            self._write(node)
            self._call(node)
            self._f_increment(node)

    def _hit(self, kind, detail, node):
        self.info.direct_hits.append(
            Hit(kind, detail, self.info.label, self.info.path, node.lineno)
        )

    def _metadata(self, node):
        if not isinstance(node, ast.Attribute) or not _is_request_expr(node.value, self.request_names):
            return
        if node.attr in METADATA_ATTRS:
            key = self._named.get(id(node))
            detail = _render(node)
            if key is not None:
                detail = f"{detail}[{key!r}]"
            self._hit("metadata", detail, node)
        elif node.attr in METADATA_METHODS:
            self._hit("metadata", f"{_render(node)}()", node)

    def _write(self, node):
        if not isinstance(node, ast.Call):
            return
        func = node.func
        if not isinstance(func, ast.Attribute):
            return
        if func.attr in WRITE_METHODS:
            self._hit("write", f"{_render(func)}(...)", node)
            return
        if func.attr in RELATION_METHODS and isinstance(func.value, ast.Attribute):
            self._hit("write", f"{_render(func)}(...)", node)
            return
        if func.attr in ("execute", "executemany", "raw") and node.args:
            arg = node.args[0]
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                if arg.value.strip().lower().startswith(RAW_WRITE_VERBS):
                    self._hit("write", f"{_render(func)}(<raw write SQL>)", node)

    def _f_increment(self, node):
        """``obj.field = F('field') + 1``.

        A bare ``F()`` is not a write -- it is an alias in ``.values()`` or an
        ordering key far more often than an increment, and the increment shapes
        that matter (``qs.update(n=F('n')+1)``) are already caught by
        ``.update``. Only an assignment *to an attribute* is flagged."""
        targets = None
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AugAssign):
            targets = [node.target]
        if not targets or not any(isinstance(t, ast.Attribute) for t in targets):
            return
        for sub in ast.walk(node.value):
            if isinstance(sub, ast.Call) and _dotted(sub.func).rsplit(".", 1)[-1] == "F":
                self._hit("write", "F() increment assigned to a field", node)
                return

    def _call(self, node):
        if not isinstance(node, ast.Call):
            return
        target = _dotted(node.func)
        if not target:
            return
        self.info.calls.append(target)
        passed = [
            i for i, arg in enumerate(node.args)
            if _is_request_expr(arg, self.request_names)
        ]
        passed += [
            kw.arg for kw in node.keywords
            if kw.arg and _is_request_expr(kw.value, self.request_names)
        ]
        if passed:
            self.info.request_args.append((target, tuple(passed)))


class _ModuleIndexer(ast.NodeVisitor):
    def __init__(self, module: str, path: str, is_package: bool = False):
        self.module, self.path = module, path
        # `from.impl import x` means `<self.module>.impl` in a package
        # __init__, but `<parent>.impl` in an ordinary module. Getting this
        # backwards silently truncates every relative import in a package.
        self.is_package = is_package
        self.funcs: dict = {}
        self.imports: dict = {}   # alias -> "module:name" ("" name = module import)
        self.classes: dict = {}   # class -> tuple of base names
        self.consts: dict = {}         # module-level NAME = "literal"
        self.class_consts: dict = {}   # class -> {NAME: "literal"}
        self.const_aliases: dict = {}  # NAME -> OTHER_NAME
        self.globals: dict = {}        # repo-wide fallback, set by _build
        self._stack: list = []
        self._class_stack: list = []
        self._func_stack: list = []

    @staticmethod
    def _string_constants(body, aliases):
        """``{NAME: "literal"}``, recording ``NAME = OTHER_NAME`` in aliases."""
        out = {}
        for stmt in body:
            if isinstance(stmt, ast.Assign):
                targets, value = stmt.targets, stmt.value
            elif isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
                targets, value = [stmt.target], stmt.value
            else:
                continue
            for target in targets:
                if not isinstance(target, ast.Name):
                    continue
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    out[target.id] = value.value
                elif isinstance(value, ast.Name):
                    aliases[target.id] = value.id
        return out

    def load_constants(self, tree: ast.Module):
        """Module- and class-level string constants, so a header named by a
        constant still produces a specific allowlist key."""
        self.consts = self._string_constants(tree.body, self.const_aliases)
        for stmt in ast.walk(tree):
            if isinstance(stmt, ast.ClassDef):
                self.class_consts[stmt.name] = self._string_constants(
                    stmt.body, self.const_aliases
                )

    def _bind(self, name, target):
        """Module/class-level imports go in the shared map; imports inside a
        function go in that function's own map. Flattening every lexical scope
        into one mutable dict let a local ``import credit as act`` in one
        function silently rebind ``act`` for a different function."""
        if self._func_stack:
            self._func_stack[-1].local_imports[name] = target
        else:
            self.imports[name] = target

    def visit_Import(self, node):
        for alias in node.names:
            if alias.asname:
                # `import a.b.c as x` binds x to the leaf module.
                self._bind(alias.asname, f"{alias.name}:")
            else:
                # `import a.b.c` binds only `a`, the TOP package -- and a later
                # `a.b.c.credit()` is then resolved submodule by submodule.
                # Binding `a` to `a.b.c` instead silently breaks resolution for
                # every fully qualified call, including into the 2Z ledger.
                top = alias.name.split(".")[0]
                self._bind(top, f"{top}:")

    def visit_ImportFrom(self, node):
        if node.level:
            pkg = self.module
            for _ in range(node.level - 1 if self.is_package else node.level):
                pkg = pkg.rsplit(".", 1)[0] if "." in pkg else ""
            target = f"{pkg}.{node.module}" if node.module else pkg
        else:
            target = node.module or ""
        for alias in node.names:
            # `from.foo import bar as bar` re-exports resolve the same way as a
            # direct import: the alias points at the defining module.
            self._bind(alias.asname or alias.name, f"{target}:{alias.name}")

    def visit_ClassDef(self, node):
        self.classes[node.name] = tuple(
            _dotted(b).rsplit(".", 1)[-1] for b in node.bases
        )
        self._stack.append(node.name)
        self._class_stack.append(node.name)
        self.generic_visit(node)
        self._class_stack.pop()
        self._stack.pop()

    def _visit_func(self, node):
        info = FuncInfo(
            module=self.module,
            path=self.path,
            qualname=".".join(self._stack + [node.name]),
            node=node,
            class_stack=tuple(self._class_stack),
            imports=self.imports,
            name_aliases=self.const_aliases,
        )
        scope = dict(self.globals)
        scope.update(self.consts)
        for cls in self._class_stack:
            scope.update(self.class_consts.get(cls, {}))
        self.funcs[info.qualname] = info
        self._stack.append(node.name)
        self._func_stack.append(info)
        self.generic_visit(node)
        self._func_stack.pop()
        self._stack.pop()
        # Scanned after generic_visit so this function's own local imports are
        # already bound.
        info.scan_scope = (scope, self.const_aliases)
        _BodyScanner(info, scope, self.const_aliases).scan()

    visit_FunctionDef = _visit_func
    visit_AsyncFunctionDef = _visit_func


@dataclass
class Index:
    funcs: dict = field(default_factory=dict)
    by_module: dict = field(default_factory=dict)
    imports: dict = field(default_factory=dict)
    classes: dict = field(default_factory=dict)
    class_locations: dict = field(default_factory=dict)
    unresolvable: list = field(default_factory=list)

    #How many ``from.x import y`` hops to follow. A package ``__init__`` that
    #re-exports from a submodule that re-exports again is the realistic depth.
    IMPORT_HOPS = 8

    def _lookup(self, module: str, qualname: str, hops: int = IMPORT_HOPS):
        """Find ``qualname`` in ``module``, following re-exports.

        ``from.impl import stamp`` in a package ``__init__`` leaves no function
        named ``stamp`` in that module -- only an import entry. Stopping there
        loses every helper reached through a re-export, which is a one-line
        evasion of the whole check."""
        found = self.by_module.get(module, {}).get(qualname)
        if found is not None or hops <= 0:
            return found
        head, _, rest = qualname.partition(".")
        # `from. import service` then `service.record()`: `service` is a
        # SUBMODULE, not a member of the package. This is the ordinary way this
        # codebase imports service modules, and missing it made "move the write
        # into a service module" a one-line evasion of Rule B.
        if rest:
            submodule = f"{module}.{head}"
            if submodule in self.by_module:
                found = self._lookup(submodule, rest, hops - 1)
                if found is not None:
                    return found
        imported = self.imports.get(module, {}).get(head)
        if not imported:
            return None
        next_mod, _, next_name = imported.partition(":")
        if next_mod == module:
            return None
        target = next_name or head
        if rest:
            target = f"{target}.{rest}"
        return self._lookup(next_mod, target, hops - 1)

    def resolve(self, caller: FuncInfo, target: str):
        """Best-effort resolution of a call target to an indexed function."""
        head, _, rest = target.partition(".")
        if head == "self":
            return self._method(caller, rest) if rest and "." not in rest else None
        if not rest:
            local = self.by_module.get(caller.module, {}).get(head)
            if local is not None:
                return local
            imported = caller.lookup_import(head)
            if imported:
                mod, _, name = imported.partition(":")
                if name:
                    return self._lookup(mod, name)
            return None
        imported = caller.lookup_import(head)
        if imported:
            mod, _, name = imported.partition(":")
            if name:                       # from x import Class -> Class.method
                return self._lookup(mod, f"{name}.{rest}")
            return self._lookup(mod, rest)  # import x -> x.func
        return self.by_module.get(caller.module, {}).get(target)

    def _method(self, caller: FuncInfo, name: str):
        """``self.name()`` -> the method on the owning class or any repo base."""
        if not caller.class_stack:
            return None
        cls = caller.class_stack[-1]
        found = self.by_module.get(caller.module, {}).get(f"{cls}.{name}")
        if found is not None:
            return found
        seen, queue = set(), list(self.classes.get(caller.module, {}).get(cls, ()))
        while queue:
            base = queue.pop(0)
            if base in seen:
                continue
            seen.add(base)
            for mod in self.class_locations.get(base, []):
                found = self.by_module.get(mod, {}).get(f"{base}.{name}")
                if found is not None:
                    return found
                queue.extend(self.classes.get(mod, {}).get(base, ()))
        return None


def _merge(index: Index, indexer: _ModuleIndexer) -> None:
    module = indexer.module
    index.by_module[module] = indexer.funcs
    index.imports[module] = indexer.imports
    index.classes[module] = indexer.classes
    for cls in indexer.classes:
        index.class_locations.setdefault(cls, []).append(module)
    for info in indexer.funcs.values():
        index.funcs[info.key] = info
        try:
            info.verbs()
        except UnresolvableMethods as exc:
            index.unresolvable.append((info.display, str(exc)))


def _build(modules) -> Index:
    """Two passes: collect constants everywhere, then scan function bodies.

    The second pass needs the first's results because a header name can be
    defined in one module and used in another (``IDEMPOTENCY_KEY_HEADER``). A
    repo-wide name is only trusted when it is unambiguous: if two modules give
    the same name different values the guard declines to guess and falls back to
    the coarser ``request.headers`` key."""
    prepared, values, ambiguous, aliases = [], {}, set(), {}
    for module, rel, source, is_package in modules:
        indexer = _ModuleIndexer(module, rel, is_package)
        tree = ast.parse(source, filename=rel)
        indexer.load_constants(tree)
        prepared.append((indexer, tree))
        scope = dict(indexer.consts)
        for per_class in indexer.class_consts.values():
            scope.update(per_class)
        for name, value in scope.items():
            if name in values and values[name] != value:
                ambiguous.add(name)
            values[name] = value
        aliases.update(indexer.const_aliases)

    shared = {n: v for n, v in values.items() if n not in ambiguous}
    index = Index()
    for indexer, tree in prepared:
        indexer.globals = shared
        indexer.const_aliases = {**aliases, **indexer.const_aliases}
        indexer.visit(tree)
        _merge(index, indexer)
    _propagate_taint(index)
    return index


#Rounds of argument taint propagation. Each round pushes the request one call
#deeper, so this must match the depth the call graph itself walks -- a
#shallower taint means the guard follows a call it can no longer see the
#request through.
TAINT_ROUNDS = MAX_DEPTH


def _propagate_taint(index: Index) -> None:
    """Teach each callee which of *its* parameter names hold the request.

    Rule A asks "is request metadata read here", and until now "the request"
    meant one of five conventional variable names. A helper is free to call its
    parameter ``incoming``, and then ``incoming.headers['X-Credit-Amount']``
    driving a balance is invisible. So: wherever a call passes a request
    expression, bind the callee's corresponding parameter name and rescan it."""
    for _ in range(TAINT_ROUNDS):
        dirty = {}
        for fn in index.funcs.values():
            for target, passed in fn.request_args:
                callee = index.resolve(fn, target)
                if callee is None:
                    continue
                params = [a.arg for a in callee.node.args.args]
                # A bound method's `self` is not an argument at the call site.
                if callee.class_stack and params and params[0] in ("self", "cls"):
                    params = params[1:]
                kwonly = {a.arg for a in callee.node.args.kwonlyargs}
                for slot in passed:
                    name = None
                    if isinstance(slot, int):
                        if slot < len(params):
                            name = params[slot]
                    elif slot in params or slot in kwonly:
                        name = slot
                    if name and name not in callee.tainted_params:
                        callee.tainted_params.add(name)
                        dirty[callee.key] = callee
        if not dirty:
            return
        for fn in dirty.values():
            scope, cst = getattr(fn, "scan_scope", ({}, {}))
            fn.direct_hits.clear()
            fn.calls.clear()
            fn.request_args.clear()
            _BodyScanner(
                fn, scope, cst, REQUEST_NAMES | fn.tainted_params
            ).scan()


def build_index(root: Path = PY_ROOT) -> Index:
    return _build(
        (
            _module_name(path, root),
            str(path.relative_to(root)),
            path.read_text(),
            path.name == "__init__.py",
        )
        for path in _python_files(root)
    )


def index_sources(sources: dict) -> Index:
    """Index in-memory modules. Used by the detector's own self-test.

    A key ending in ``.__init__`` declares a package, so relative imports in it
    resolve like a package ``__init__`` does."""
    return _build(
        (
            module.removesuffix(".__init__"),
            module.removesuffix(".__init__").replace(".", "/")
            + ("/__init__.py" if module.endswith(".__init__") else ".py"),
            source,
            module.endswith(".__init__"),
        )
        for module, source in sources.items()
    )


def reachable_hits(index: Index, info: FuncInfo, kind: str):
    """(hit, chain) for every hit of ``kind`` in this function or its callees."""
    out, seen = [], set()

    def walk(fn: FuncInfo, depth: int, chain: tuple):
        if fn.key in seen or depth > MAX_DEPTH:
            return
        seen.add(fn.key)
        for hit in fn.direct_hits:
            if hit.kind == kind:
                out.append((hit, chain))
        for target in fn.calls:
            callee = index.resolve(fn, target)
            if callee is not None and callee.key != fn.key:
                walk(callee, depth + 1, chain + (callee.display,))

    walk(info, 0, ())
    return out


def urlconf_function_views() -> set:
    """``{"module:qualname"}`` for every plain function registered in the URLconf.

    Django dispatches **every** verb to an undecorated function view, so such a
    function is a write handler whether or not its name says so.
    ``uploads``' ``uploads_auth_public`` is exactly that shape -- a bare
    ``def uploads_auth_public(request)`` reached through nginx ``auth_request``
    -- and name-based classification is blind to it. ``ztripe``'s
    ``stripe_webhook`` used to be the example here until  pinned it with
    ``@require_POST``; that is the outcome this helper exists to produce.

    Class-based and ``@api_view`` views are skipped: DRF hangs the generated
    class off ``.cls`` and Django off ``.view_class``, and the decorator or the
    method name already classifies them.
    """
    from django.urls import URLPattern, URLResolver, get_resolver

    out = set()

    def walk(resolver):
        for pattern in resolver.url_patterns:
            if isinstance(pattern, URLResolver):
                yield from walk(pattern)
            elif isinstance(pattern, URLPattern):
                yield pattern.callback

    for callback in walk(get_resolver()):
        if getattr(callback, "cls", None) or getattr(callback, "view_class", None):
            continue
        fn = callback
        while getattr(fn, "__wrapped__", None) is not None:
            fn = fn.__wrapped__
        module = getattr(fn, "__module__", None)
        qualname = getattr(fn, "__qualname__", None)
        if module and qualname and "<locals>" not in qualname:
            out.add(f"{module}:{qualname}")
    return out


def urlconf_viewset_action_maps():
    """``(read_keys, write_keys)`` from ``ViewSet.as_view({'get': 'claim'})``.

    A router -- or a hand-written ``as_view`` mapping -- can route GET to a
    method with any name at all. ``as_view({'get': 'claim'})`` gives a read
    handler called ``claim``: not ``get``/``list``/``retrieve``, not decorated
    with ``@action``, and therefore invisible to name-based classification. DRF
    records the mapping on the view as ``.actions``, which makes the URLconf the
    authority on which verb reaches which method."""
    from django.urls import URLPattern, URLResolver, get_resolver

    reads, writes = set(), set()

    def walk(resolver):
        for pattern in resolver.url_patterns:
            if isinstance(pattern, URLResolver):
                yield from walk(pattern)
            elif isinstance(pattern, URLPattern):
                yield pattern.callback

    for callback in walk(get_resolver()):
        actions = getattr(callback, "actions", None)
        cls = getattr(callback, "cls", None)
        if not actions or cls is None:
            continue
        for verb, method_name in actions.items():
            key = f"{cls.__module__}:{cls.__qualname__}.{method_name}"
            if verb.lower() in SAFE_VERBS:
                reads.add(key)
            if verb.lower() in UNSAFE_VERBS:
                writes.add(key)
    return reads, writes


def unpinned_url_views(index: Index, registered: set) -> set:
    """Registered function views that pin no HTTP verb at all.

    Django dispatches **every** method to these -- POST *and* GET -- so they are
    a write context (Rule A) and a read context (Rule B) at once. A
    ``@require_POST``'d function is excluded: its decorator already classifies
    it, and treating it as a read as well would flag every legitimate POST
    write in the codebase."""
    out = set()
    for key in registered:
        info = index.funcs.get(key)
        if info is None:
            continue
        try:
            if info.verbs() is None:
                out.add(key)
        except UnresolvableMethods:
            continue
    return out


def _findings(index: Index, kind: str, predicate: str, extra: set = frozenset()):
    """{(owner, detail): [how the handler reaches it,...]}"""
    found: dict = {}
    for info in sorted(index.funcs.values(), key=lambda f: f.display):
        try:
            if not (getattr(info, predicate)() or info.key in extra):
                continue
        except UnresolvableMethods:
            continue  # reported by its own test
        for hit, chain in reachable_hits(index, info, kind):
            # The key names the ROUTE as well as the offending expression.
            # Keying on the callee alone would mean blessing
            # `tuzis/ledger.py::credit` for the Stripe webhook also blessed a
            # future GET endpoint that called the same 2Z-minting primitive.
            entry = (
                info.label
                if hit.owner == info.label
                else f"{info.label} -> {hit.owner}"
            )
            if chain:
                route = (
                    f"{info.display}  ->  {hit.path}:{hit.lineno}"
                    f"\n                  via {' -> '.join(chain)}"
                )
            else:
                route = f"{info.display} (line {hit.lineno})"
            found.setdefault((entry, hit.detail), []).append(route)
    return found


@pytest.fixture(scope="module")
def index():
    return build_index()


def read_paths_that_write(index: Index, read_keys: set) -> set:
    """Read handlers that nonetheless reach a database write.

    Such a handler *is* a write path, whatever verb it declares, so Rule A must
    look at it: otherwise a GET could read ``?amount`` and feed it into a write
    that Rule B has already blessed, and neither invariant would object.
    A read handler that reaches a database write is exactly this shape -- it
    must be classified as a write path whatever verb it declares."""
    keys = set()
    for info in index.funcs.values():
        try:
            if not (info.is_read_context() or info.key in read_keys):
                continue
        except UnresolvableMethods:
            continue
        if reachable_hits(index, info, "write"):
            keys.add(info.key)
    return keys


@pytest.fixture(scope="module")
def routed(index):
    """Handlers the URLconf itself proves are reachable by a given verb.

    Two sources, both more authoritative than a method name: viewset
    ``as_view({'get': 'claim'})`` maps, and function views that pin no verb at
    all. Returns ``(read_keys, write_keys)``."""
    reads, writes = urlconf_viewset_action_maps()
    unpinned = unpinned_url_views(index, urlconf_function_views())
    reads |= unpinned
    return reads, writes | unpinned | read_paths_that_write(index, reads)


# ===========================================================================
# The invariants
# ===========================================================================

def test_the_walker_actually_sees_the_codebase(index, routed):
    """So the asserts below cannot pass vacuously on an empty index -- the
    failure mode a repo-wide check is most likely to die of."""
    assert len(index.funcs) > 800
    assert any(
        f.path.endswith("g12f/views/zpage.py") for f in index.funcs.values()
    ), "zpage views not indexed; the file layout moved and this guard went blind"
    assert sum(f.is_write_context() for f in index.funcs.values()) > 50
    assert sum(f.is_read_context() for f in index.funcs.values()) > 20
    reads, writes = routed
    assert reads and writes, (
        "The URLconf walk found no plain function views. Either they all "
        "became class-based (then delete urlconf_function_views) or the walk "
        "broke -- in which case undecorated function views are now invisible "
        "to Rule A."
    )
    # An undecorated function view registered in the URLconf: Django hands it
    # GET as readily as POST, so it must land in BOTH buckets.
    assert "dj.apps.uploads.views:uploads_auth_public" in reads & writes
    # @require_POST already classifies these, so they must NOT also count as a
    # read context -- otherwise every legitimate POST write would be flagged.
    assert "dj.apps.uploads.views:single_public_upload_handle" not in reads
    # stripe_webhook was the original example of the unpinned shape above.
    #  gave it @require_POST, which is precisely how a view leaves the
    # read bucket; if it ever reappears here the decorator was dropped.
    assert "dj.apps.ztripe.views:stripe_webhook" not in reads
    # A router maps GET to `list`, so the as_view() walk really is reading maps.
    assert any(k.endswith(".list") for k in reads)


def _report(found, allowed, rule, guidance):
    unexpected = {k: v for k, v in found.items() if k not in allowed}
    stale = sorted(k for k in allowed if k not in found)
    lines = []
    if unexpected:
        lines.append(f"{rule}\n{guidance}\n")
        for (owner, detail) in sorted(unexpected):
            lines.append(f"  {owner}")
            lines.append(f"    offending expression: {detail}")
            for route in sorted(set(unexpected[(owner, detail)])):
                lines.append(f"    reached from: {route}")
            lines.append("")
        lines.append(
            "If this really is one of the narrow exceptions the rule allows "
            "(an idempotency key, an If-Match-style precondition, provider "
            "webhook auth, an ownership scope taken from the authenticated "
            "user), then: declare it in f2z.yaml with OpenApiParameter -- "
            "including headers, including the failure mode -- and add ONE "
            "entry to the allowlist in this file naming that function and that "
            "expression, with a one-line reason. Never bless a module.\n"
            f"Rule: {CLAUDE_MD_SECTION}"
        )
    if stale:
        lines.append(
            "\nThese allowlist entries no longer match anything. The code was "
            "fixed or moved -- delete the entry so the list stays a record of "
            "live exceptions rather than an amnesty:\n  "
            + "\n  ".join(f"{o} :: {d}" for o, d in stale)
        )
    return "\n".join(lines)


def test_request_metadata_never_reaches_a_write(index, routed):
    """Rule A. A query parameter, path segment or header selects a
    representation; it must not decide what gets persisted."""
    found = _findings(index, "metadata", "is_write_context", extra=routed[1])
    allowed = set(ALLOWED_METADATA_IN_WRITE) | set(KNOWN_UNFIXED)
    message = _report(
        found,
        allowed,
        rule="A URL never dictates what goes in the database.",
        guidance=(
            "These write paths read request metadata. Query parameters, path "
            "segments and headers select a representation or identify a "
            "resource; body fields mutate state. This is #985 -- it is how "
            "`POST /api/zpage/?lang=fr` permanently branded articles French "
            "with a parameter that means 'render this variant to me' "
            "everywhere else, and how a generated client ends up unable to see "
            "the thing that changes the database."
        ),
    )
    assert not message, message


def test_a_read_never_writes(index, routed):
    """Rule B. GET / list / retrieve are safe methods: prefetchers, crawlers,
    scanners and browsers replay them freely, so a side effect there is a side
    effect nobody requested.

    Extended with the unpinned URLconf function views: Django dispatches GET to
    a view that declares no verb, so a crawler or a browser reload reaches its
    writes exactly as a declared ``get`` handler would."""
    found = _findings(index, "write", "is_read_context", extra=routed[0])
    allowed = set(ALLOWED_WRITE_IN_READ)
    message = _report(
        found,
        allowed,
        rule="A read never writes.",
        guidance=(
            "These GET handlers reach a database write. Safe methods are "
            "replayed by link prefetchers, mail-client scanners and browser "
            "reloads -- #985 F5 was an unsubscribe that a security scanner "
            "could trigger on a user's behalf. Move the mutation behind POST, "
            "or -- if it is genuinely a lazy row keyed only on the "
            "authenticated identity -- add "
            "ONE allowlist entry in this file with a reason."
        ),
    )
    assert not message, message


def test_route_decorators_declare_literal_methods(index):
    """``@action(methods=SOME_CONSTANT)`` is invisible to the classifier above,
    so a single computed verb list would silently exempt a route from both
    rules. There are none today; keep it that way."""
    assert not index.unresolvable, (
        "These route decorators compute their HTTP methods, so the #985 guard "
        "cannot tell whether the handler writes. Spell the verbs out as string "
        "literals:\n  "
        + "\n  ".join(f"{d}: {dump}" for d, dump in index.unresolvable)
    )


@pytest.mark.xfail(
    bool(KNOWN_UNFIXED),
    strict=True,
    reason=(
        "KNOWN_UNFIXED is non-empty: at least one reviewed-and-wrong finding "
        "is still open. (It held the #1016 Host-header findings until they "
        "were fixed; the bucket is empty today, so this mark is inert.) This "
        "is a strict XFAIL rather than a silent "
        "allowlist entry so every CI run says out loud that a "
        "reviewed-and-wrong finding is still open. The mark is CONDITIONAL on "
        "the bucket being non-empty, so emptying KNOWN_UNFIXED is the only edit "
        "the fix needs -- an urgent security deploy must not also have to "
        "discover this decorator to get the gate green."
    ),
)
def test_no_known_unfixed_findings_remain():
    assert not KNOWN_UNFIXED, sorted(
        f"{owner} :: {detail} -- {reason}"
        for (owner, detail), reason in KNOWN_UNFIXED.items()
    )


def test_known_unfixed_findings_are_still_real(index, routed):
    """The known-unfixed bucket is not a second allowlist. When one of these is
    fixed, this fails until the entry is deleted."""
    live = set(
        _findings(index, "metadata", "is_write_context", extra=routed[1])
    ) | set(_findings(index, "write", "is_read_context", extra=routed[0]))
    stale = sorted(k for k in KNOWN_UNFIXED if k not in live)
    assert not stale, (
        "These KNOWN_UNFIXED entries no longer match. If the finding was "
        "fixed, delete the entry (and close it out on #985); if the code just "
        "moved, update it:\n  "
        + "\n  ".join(f"{o} :: {d}" for o, d in stale)
    )


def test_every_allowlist_entry_carries_a_reason():
    """An entry without a reason is an entry nobody can review later."""
    thin = [
        f"{owner} :: {detail}"
        for table in (ALLOWED_METADATA_IN_WRITE, ALLOWED_WRITE_IN_READ, KNOWN_UNFIXED)
        for (owner, detail), reason in table.items()
        if len(reason.strip()) < 30
    ]
    assert not thin, (
        "Every exception to the #985 rule is a decision someone has to be able "
        "to re-review. Say why, in a sentence:\n  " + "\n  ".join(thin)
    )


# ===========================================================================
# The detector's own self-test.
#
# A guard that looks thorough and isn't is worse than no guard, because it buys
# false confidence. Each case below is a violation shape injected as source; the
# check must see it. The evasions are the point: verb case and spelling, tuple
# vs list, a helper doing the write on the handler's behalf, a re-export, and
# django-ninja's decorator form -- every one of which a name-only or regex check
# walks straight past.
# ===========================================================================

#(id, source, expected number of RULE A findings)
_METADATA_CASES = [
    (
        "serializer-create",  # the original  F1 shape
        """
class S:
    def create(self, validated_data):
        validated_data['lang'] = self.context['request'].query_params.get('lang')
        return validated_data
""",
        1,
    ),
    (
        "serializer-validate",
        """
class S:
    def validate_source_language(self, value):
        return value or request.query_params.get('lang')
""",
        1,
    ),
    (
        "perform_create",
        """
class V:
    def perform_create(self, serializer):
        serializer.save(flag=self.request.GET.get('flag'))
""",
        1,
    ),
    (
        "post-handler-cookies",
        """
class V:
    def post(self, request):
        Thing.objects.create(ref=request.COOKIES.get('ref'))
""",
        1,
    ),
    (
        "action-uppercase-methods",
        """
class V:
    @action(detail=True, methods=['POST'])
    def promote(self, request, pk=None):
        Thing.objects.create(x=request.headers.get('X-Thing'))
""",
        1,
    ),
    (
        "action-tuple-shorthand",
        """
class V:
    @action(detail=True, methods=('patch',))
    def tweak(self, request, pk=None):
        return request.query_params.get('q')
""",
        1,
    ),
    (
        "action-mixed-case-tuple",
        """
class V:
    @action(methods=('GET', 'Post'), detail=False)
    def both(self, request):
        return request.query_params.get('q')
""",
        1,
    ),
    (
        "api_view-decorator",
        """
@api_view(['PUT'])
def replace(request):
    Thing.objects.create(x=request.query_params.get('x'))
""",
        1,
    ),
    (
        "django-ninja-router",
        """
@router.post("/start-group", response=Out)
def start_group(request, data):
    Participant.objects.create(host=request.get_host())
""",
        1,
    ),
    (
        "require_POST",
        """
@require_POST
def handle(request):
    return request.META.get('HTTP_X_THING')
""",
        1,
    ),
    (
        "self-request-attribute",
        """
class V:
    def update(self, request, *a, **kw):
        return self.request.query_params.get('lang')
""",
        1,
    ),
    # -- negative controls ---------------------------------------------------
    (
        "NEGATIVE-get-handler-may-read-metadata",
        """
class V:
    def get(self, request):
        return request.query_params.get('lang')
""",
        0,
    ),
    (
        "NEGATIVE-action-default-is-get",
        """
class V:
    @action(detail=True)
    def related(self, request, pk=None):
        return request.query_params.get('lang')
""",
        0,
    ),
    (
        "NEGATIVE-body-only-write",
        """
class V:
    def post(self, request):
        Thing.objects.create(**request.data)
""",
        0,
    ),
]

#(id, source, expected number of RULE B findings)
_WRITE_CASES = [
    (
        "save-in-get",
        """
class V:
    def get(self, request):
        obj = Thing.objects.first()
        obj.save()
""",
        1,
    ),
    (
        "create-in-list",
        """
class V:
    def list(self, request):
        Thing.objects.create(name='x')
""",
        1,
    ),
    (
        "get_or_create-in-retrieve",
        """
class V:
    def retrieve(self, request, pk=None):
        Thing.objects.get_or_create(pk=pk)
""",
        1,
    ),
    (
        "queryset-delete-in-get",
        """
class V:
    def get(self, request):
        Thing.objects.filter(stale=True).delete()
""",
        1,
    ),
    (
        "queryset-update-in-get",
        """
class V:
    def get(self, request):
        Thing.objects.filter(pk=1).update(views=F('views') + 1)
""",
        1,
    ),
    (
        "m2m-add-in-get",
        """
class V:
    def get(self, request):
        thing.tags.add(tag)
""",
        1,
    ),
    (
        "F-increment-in-get",
        """
class V:
    def get(self, request):
        thing.views = F('views') + 1
""",
        1,
    ),
    (
        "raw-sql-write-in-get",
        """
class V:
    def get(self, request):
        with connection.cursor() as cursor:
            cursor.execute("UPDATE thing SET views = views + 1")
""",
        1,
    ),
    (
        "api_view-GET-writes",
        """
@api_view(['GET'])
def peek(request):
    Thing.objects.create(seen=True)
""",
        1,
    ),
    (
        "require_safe-writes",
        """
@require_safe
def peek(request):
    Thing.objects.create(seen=True)
""",
        1,
    ),
    # -- negative controls ---------------------------------------------------
    (
        "NEGATIVE-write-in-post",
        """
class V:
    def post(self, request):
        Thing.objects.create(name='x')
""",
        0,
    ),
    (
        "NEGATIVE-dict-get-is-not-a-write",
        """
class V:
    def get(self, request):
        data = {}
        return data.get('x')
""",
        0,
    ),
    (
        "NEGATIVE-F-as-a-values-alias",
        """
class V:
    def get(self, request):
        return Thing.objects.values(username=F('creator__username'))
""",
        0,
    ),
    (
        "NEGATIVE-raw-select",
        """
class V:
    def get(self, request):
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
""",
        0,
    ),
]


@pytest.mark.parametrize(
    "source,expected", [(s, e) for _, s, e in _METADATA_CASES],
    ids=[i for i, _, _ in _METADATA_CASES],
)
def test_detector_sees_metadata_in_a_write(source, expected):
    found = _findings(index_sources({"synthetic": source}), "metadata",
                      "is_write_context")
    assert len(found) == expected, f"found={found}"


@pytest.mark.parametrize(
    "source,expected", [(s, e) for _, s, e in _WRITE_CASES],
    ids=[i for i, _, _ in _WRITE_CASES],
)
def test_detector_sees_a_write_in_a_read(source, expected):
    found = _findings(index_sources({"synthetic": source}), "write",
                      "is_read_context")
    assert len(found) == expected, f"found={found}"


def test_detector_follows_a_helper_that_writes_on_the_handlers_behalf():
    """The evasion that matters most: move the offending line one function
    away. Six of the eight live findings in this file are exactly this shape."""
    index = index_sources({
        "app.views": """
from app.helpers import stamp

class V:
    def get(self, request):
        stamp(request)

    def post(self, request):
        self._lang(request)

    def _lang(self, request):
        return request.query_params.get('lang')
""",
        "app.helpers": """
def stamp(request):
    Thing.objects.create(seen=True)
""",
    })
    writes = _findings(index, "write", "is_read_context")
    assert list(writes) == [
        ("app/views.py::V.get -> app/helpers.py::stamp", "Thing.objects.create(...)")
    ]
    meta = _findings(index, "metadata", "is_write_context")
    assert list(meta) == [
        ("app/views.py::V.post -> app/views.py::V._lang",
         "request.query_params['lang']")
    ]


def test_detector_follows_a_re_exported_helper():
    """``from.impl import stamp`` re-exported through a package ``__init__``
    is still the same function; an import-name check that stopped at the first
    module would lose it."""
    index = index_sources({
        "app.views": """
from app.helpers import stamp

class V:
    def get(self, request):
        stamp(request)
""",
        "app.helpers": """
from app.impl import stamp
""",
        "app.impl": """
def stamp(request):
    Thing.objects.create(seen=True)
""",
    })
    # one hop: helpers re-exports impl.stamp, so views -> helpers resolves to a
    # module with no body of its own and the chain must continue into impl.
    assert list(_findings(index, "write", "is_read_context")) == [
        ("app/views.py::V.get -> app/impl.py::stamp", "Thing.objects.create(...)")
    ]


def test_detector_follows_a_helper_on_a_base_class():
    """``self.helper()`` defined on a mixin, not on the handler's own class."""
    index = index_sources({
        "app.views": """
from app.mixins import LangMixin

class V(LangMixin):
    def create(self, request):
        return self.requested_language()
""",
        "app.mixins": """
class LangMixin:
    def requested_language(self):
        return self.request.query_params.get('lang')
""",
    })
    assert list(_findings(index, "metadata", "is_write_context")) == [
        ("app/views.py::V.create -> app/mixins.py::LangMixin.requested_language",
         "self.request.query_params['lang']")
    ]


def test_allowlist_keys_name_the_parameter_not_the_container():
    """Codex's finding on this PR. If the key were just ``request.headers``,
    blessing ``Idempotency-Key`` on the money endpoint would silently bless a
    later ``X-Credit-Amount`` read in the same handler. Each parameter gets its
    own key, so the second read is a new -- unallowed -- finding."""
    index = index_sources({"synthetic": """
class V:
    def post(self, request):
        Thing.objects.create(
            key=request.headers.get('Idempotency-Key'),
            amount=request.headers.get('X-Credit-Amount'),
        )
"""})
    assert sorted(_findings(index, "metadata", "is_write_context")) == [
        ("synthetic.py::V.post", "request.headers['Idempotency-Key']"),
        ("synthetic.py::V.post", "request.headers['X-Credit-Amount']"),
    ]


def test_detector_resolves_a_header_named_by_a_constant():
    """The money path names its header through two levels of indirection
    (``IDEMPOTENCY_HEADER = IDEMPOTENCY_KEY_HEADER``) and the literal lives in
    another module. Unresolved, it collapses to the coarse container key the
    test above exists to prevent."""
    index = index_sources({
        "app.constants": """
IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key'
""",
        "app.views": """
from app.constants import IDEMPOTENCY_KEY_HEADER


class V:
    IDEMPOTENCY_HEADER = IDEMPOTENCY_KEY_HEADER

    def post(self, request):
        return request.headers.get(self.IDEMPOTENCY_HEADER)
""",
    })
    assert list(_findings(index, "metadata", "is_write_context")) == [
        ("app/views.py::V.post", "request.headers['Idempotency-Key']")
    ]


def test_detector_follows_a_write_moved_into_a_service_submodule():
    """``from. import service`` then ``service.record(...)`` -- the ordinary
    way this codebase imports service modules. ``service`` is a submodule, not a
    member of the package, so a lookup that searched only the package would make
    "move the write into a service module" a one-line evasion."""
    index = index_sources({
        "app.views": """
from app import service


class V:
    def get(self, request):
        service.record(request)
""",
        "app.service": """
def record(request):
    Audit.objects.create(seen=True)
""",
    })
    assert list(_findings(index, "write", "is_read_context")) == [
        ("app/views.py::V.get -> app/service.py::record",
         "Audit.objects.create(...)")
    ]


def test_a_route_accepting_both_verbs_is_still_a_read():
    """``@api_view(['GET', 'POST'])`` is reachable by GET, so an unconditional
    write in it is reachable by a prefetch. Excluding it because POST is also
    declared would be a one-word exemption from Rule B."""
    index = index_sources({"synthetic": """
@api_view(['GET', 'POST'])
def both(request):
    Thing.objects.create(seen=True)
"""})
    assert list(_findings(index, "write", "is_read_context")) == [
        ("synthetic.py::both", "Thing.objects.create(...)")
    ]


def test_detector_follows_a_package_relative_re_export():
    """``from.impl import stamp`` inside ``app/helpers/__init__.py`` means
    ``app.helpers.impl`` -- not ``app.impl``. Resolving a package's own relative
    imports one level too high silently truncates every helper reached through a
    package, which is the common shape in this codebase."""
    index = index_sources({
        "app.views": """
from app.helpers import stamp


class V:
    def get(self, request):
        stamp(request)
""",
        "app.helpers.__init__": """
from .impl import stamp
""",
        "app.helpers.impl": """
def stamp(request):
    Thing.objects.create(seen=True)
""",
    })
    assert list(_findings(index, "write", "is_read_context")) == [
        ("app/views.py::V.get -> app/helpers/impl.py::stamp",
         "Thing.objects.create(...)")
    ]


def test_allowlist_entry_is_bound_to_the_route_that_justified_it():
    """Codex's second-round finding, and the sharpest one. ``ledger.credit`` is
    allowed *from the Stripe webhook*, where a signature gates it. If the key
    named only the callee, a future GET endpoint calling the same 2Z-minting
    primitive would inherit that blessing and mint credits behind a green CI.
    The route is part of the key, so the second caller is a new finding."""
    index = index_sources({"app.views": """
from app.ledger import credit


class Blessed:
    def get(self, request):
        credit(request.user)


class New:
    def retrieve(self, request, pk=None):
        credit(request.user)
""", "app.ledger": """
def credit(user):
    Creator.objects.filter(pk=user.pk).update(tuzis=1)
"""})
    found = _findings(index, "write", "is_read_context")
    assert sorted(found) == [
        ("app/views.py::Blessed.get -> app/ledger.py::credit",
         "Creator.objects.filter().update(...)"),
        ("app/views.py::New.retrieve -> app/ledger.py::credit",
         "Creator.objects.filter().update(...)"),
    ], "one route's exception must not cover another route's call"


def test_a_viewset_action_map_can_name_any_method():
    """``as_view({'get': 'claim'})`` routes GET to a method called neither
    ``get`` nor ``list`` nor ``retrieve``, and carrying no ``@action``. Name-
    based classification is blind to it; the URLconf is not, and
    ``urlconf_viewset_action_maps()`` is what feeds those keys in. This proves
    the plumbing: given the key, the write is found."""
    index = index_sources({"app.views": """
class BonusViewSet:
    def claim(self, request):
        Bonus.objects.create(user=request.user)
"""})
    assert not _findings(index, "write", "is_read_context")
    assert list(
        _findings(index, "write", "is_read_context",
                  extra={"app.views:BonusViewSet.claim"})
    ) == [("app/views.py::BonusViewSet.claim", "Bonus.objects.create(...)")]


@pytest.mark.parametrize("view_source", [
    # every import spelling that reaches the same helper
    "import app.ledger\n\n\nclass V:\n    def get(self, request):\n"
    "        app.ledger.credit(request.user)\n",
    "import app.ledger as ledger\n\n\nclass V:\n    def get(self, request):\n"
    "        ledger.credit(request.user)\n",
    "from app import ledger\n\n\nclass V:\n    def get(self, request):\n"
    "        ledger.credit(request.user)\n",
    "from app.ledger import credit\n\n\nclass V:\n    def get(self, request):\n"
    "        credit(request.user)\n",
], ids=["import a.b", "import a.b as x", "from a import b", "from a.b import c"])
def test_detector_follows_every_import_spelling(view_source):
    """Codex's third-round finding. ``import app.ledger`` bound the name ``app``
    to the *leaf* module, so a fully qualified ``app.ledger.credit(...)`` -- an
    entirely ordinary Python call into the 2Z ledger -- resolved to nothing and
    the write vanished from the call graph."""
    index = index_sources({
        "app.__init__": "",
        "app.views": view_source,
        "app.ledger": """
def credit(user):
    Creator.objects.filter(pk=user.pk).update(tuzis=1)
""",
    })
    assert list(_findings(index, "write", "is_read_context")) == [
        ("app/views.py::V.get -> app/ledger.py::credit",
         "Creator.objects.filter().update(...)")
    ]


def test_an_aliased_route_decorator_is_still_a_route():
    """``from rest_framework.decorators import api_view as endpoint`` matched no
    decorator name, so the route pinned no verbs and fell out of both rules --
    a one-line alias that hides an endpoint from the guard entirely."""
    index = index_sources({"synthetic": """
from rest_framework.decorators import api_view as endpoint


@endpoint(['GET'])
def peek(request):
    Bonus.objects.create(seen=True)
"""})
    assert list(_findings(index, "write", "is_read_context")) == [
        ("synthetic.py::peek", "Bonus.objects.create(...)")
    ]


def test_taint_follows_the_argument_not_the_variable_name():
    """Codex's fourth-round finding. A helper is free to call its parameter
    anything; if "the request" means only five conventional spellings, renaming
    a parameter hides a header-driven write completely."""
    index = index_sources({"app.views": """
from app.money import apply_credit


class V:
    def post(self, request):
        apply_credit(request)
""", "app.money": """
def apply_credit(incoming):
    Creator.objects.filter(pk=1).update(
        tuzis=incoming.headers['X-Credit-Amount'])
"""})
    assert list(_findings(index, "metadata", "is_write_context")) == [
        ("app/views.py::V.post -> app/money.py::apply_credit",
         "incoming.headers['X-Credit-Amount']")
    ]


def test_taint_follows_a_keyword_argument_too():
    index = index_sources({"app.views": """
from app.money import apply_credit


class V:
    def post(self, request):
        apply_credit(amount=1, incoming=request)
""", "app.money": """
def apply_credit(amount, incoming):
    Creator.objects.filter(pk=1).update(x=incoming.query_params['x'])
"""})
    assert list(_findings(index, "metadata", "is_write_context")) == [
        ("app/views.py::V.post -> app/money.py::apply_credit",
         "incoming.query_params['x']")
    ]


def test_a_function_local_import_does_not_rebind_another_function():
    """Codex's fourth-round finding. Flattening every lexical scope into one
    mutable import map let a local ``import record as act`` in one function
    silently rebind ``act`` for a different function -- pointing a GET's ledger
    call at a harmless helper and erasing the write from the call graph."""
    index = index_sources({"app.views": """
class V:
    def get(self, request):
        from app.ledger import credit as act
        act(request.user)


def unrelated():
    from app.audit import record as act
    act()
""", "app.ledger": """
def credit(user):
    Creator.objects.filter(pk=user.pk).update(tuzis=1)
""", "app.audit": """
def record():
    pass
"""})
    assert list(_findings(index, "write", "is_read_context")) == [
        ("app/views.py::V.get -> app/ledger.py::credit",
         "Creator.objects.filter().update(...)")
    ]


def test_taint_survives_a_local_alias_of_the_request():
    """Codex's fifth-round finding. ``incoming = request`` -- one ordinary
    line -- stripped the taint before the call, which defeated the argument
    propagation above completely."""
    index = index_sources({"app.views": """
from app.money import apply_credit


class V:
    def post(self, request):
        incoming = request
        apply_credit(incoming)
""", "app.money": """
def apply_credit(payload):
    Creator.objects.filter(pk=1).update(
        tuzis=payload.headers['X-Credit-Amount'])
"""})
    assert list(_findings(index, "metadata", "is_write_context")) == [
        ("app/views.py::V.post -> app/money.py::apply_credit",
         "payload.headers['X-Credit-Amount']")
    ]


def test_taint_reaches_as_deep_as_the_call_graph():
    """Taint propagation must run for as many rounds as the call graph walks
    hops, or the guard follows a call it can no longer see the request
    through. Renamed parameter at every level."""
    index = index_sources({"app.views": """
from app.a import controller


class V:
    def post(self, request):
        controller(request)
""",
        "app.a": """
from app.b import service


def controller(one):
    service(one)
""",
        "app.b": """
from app.c import ledger


def service(two):
    ledger(two)
""",
        "app.c": """
from app.d import credit


def ledger(three):
    credit(three)
""",
        "app.d": """
def credit(four):
    Creator.objects.filter(pk=1).update(tuzis=four.query_params['amount'])
""",
    })
    assert list(_findings(index, "metadata", "is_write_context")) == [
        ("app/views.py::V.post -> app/d.py::credit",
         "four.query_params['amount']")
    ]


def test_a_dispatch_override_is_both_a_read_and_a_write_handler():
    """A plain CBV overriding ``dispatch()`` runs for every verb, has no
    ``@action`` map and no method named ``get``/``post`` -- so nothing else in
    the classifier would ever look at it."""
    index = index_sources({"synthetic": """
class LegacyCreditView:
    def dispatch(self, request, *args, **kwargs):
        Credit.objects.create(amount=request.GET['amount'])
"""})
    assert list(_findings(index, "metadata", "is_write_context")) == [
        ("synthetic.py::LegacyCreditView.dispatch", "request.GET['amount']")
    ]
    assert list(_findings(index, "write", "is_read_context")) == [
        ("synthetic.py::LegacyCreditView.dispatch", "Credit.objects.create(...)")
    ]


def test_a_get_that_reaches_a_write_is_checked_by_rule_a_too():
    """Codex's sixth-round finding. A GET that reaches a write IS a write path,
    whatever verb it declares. Without this, a handler could read ``?amount``
    and feed it into a write Rule B had already blessed, and neither invariant
    would say a word."""
    index = index_sources({"synthetic": """
class V:
    def get(self, request):
        Thing.objects.create(amount=request.query_params.get('amount'))
"""})
    reads = read_paths_that_write(index, set())
    assert reads == {"synthetic:V.get"}
    assert list(_findings(index, "metadata", "is_write_context", extra=reads)) == [
        ("synthetic.py::V.get", "request.query_params['amount']")
    ]


def test_a_decorator_aliased_by_assignment_is_still_a_route():
    """``endpoint = api_view`` -- an assignment rather than an import alias --
    was another one-line way to make a route pin no verbs at all."""
    index = index_sources({"synthetic": """
from rest_framework.decorators import api_view

endpoint = api_view


@endpoint(['GET'])
def peek(request):
    Bonus.objects.create(seen=True)
"""})
    assert list(_findings(index, "write", "is_read_context")) == [
        ("synthetic.py::peek", "Bonus.objects.create(...)")
    ]


def test_detector_refuses_a_computed_method_list():
    """A verb list the guard cannot read would silently exempt the route from
    both rules, so it is an error rather than a shrug."""
    index = index_sources({"synthetic": """
class V:
    @action(detail=True, methods=WRITE_METHODS)
    def sneaky(self, request, pk=None):
        Thing.objects.create(x=request.query_params.get('x'))
"""})
    assert index.unresolvable, "a computed methods= list was silently accepted"


def test_allowlists_do_not_bless_whole_modules():
    """'s review caught exactly this: an exception written broadly enough
    to cover the billing route that moves money. An entry names a function."""
    broad = [
        f"{owner} :: {detail}"
        for table in (ALLOWED_METADATA_IN_WRITE, ALLOWED_WRITE_IN_READ, KNOWN_UNFIXED)
        for (owner, detail) in table
        if "::" not in owner or not owner.split("::", 1)[1].strip()
    ]
    assert not broad, (
        "Allowlist keys must be '<path>::<function qualname>' -- one function, "
        "never a whole module:\n  " + "\n  ".join(broad)
    )
