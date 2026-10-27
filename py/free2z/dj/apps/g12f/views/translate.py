"""Buy an AI translation of a zPage with 2Z ( Part 6).

Three routes, all owner-only:

``GET  /api/zpage/{free2zaddr}/variants/{language}/translate/quote/``
    What it would cost. Charges nothing, writes nothing.
``POST /api/zpage/{free2zaddr}/variants/{language}/translate/``
    Confirm the quoted price, debit, enqueue. **202** plus a job id.
``GET  /api/zpage/{free2zaddr}/variants/{language}/translate/``
    What became of the last purchase for this language.

Several languages at once, and the per-article job tray, live in
:mod:`dj.apps.g12f.views.translate_batch`. They share this module's
per-language checks (``item_refusal``, ``capacity_refusal``) rather than
copying them, so the two purchases cannot drift apart.

WHY THESE ARE NOT ACTIONS ON ``zPageView``
------------------------------------------
``atomic_request = False``. ``AtomicMiddleware`` wraps every POST in one
transaction, and under it ``IdempotencyKey.claim()``'s "the row is committed
immediately, so a concurrent duplicate collides on the unique constraint" is
simply false -- the duplicate blocks on the index for the life of the original
request instead of taking the 409 branch, and a crash rolls the claim back
(finding 2). That flag is a per-VIEW-CLASS setting, and setting it on the
whole zPage viewset would opt every zPage write out of request atomicity. So
the money lives in its own class, exactly as ``IdempotentDonate2Z`` and
``ConfirmedSubscribeView`` do.

ORDER OF OPERATIONS IN THE PURCHASE, AND WHY
--------------------------------------------
1. Idempotency key. Missing/malformed is a 400 before anything else happens.
2. Resolve the article and the language. Immutable facts; needed to name the
   request at all.
3. **Claim the key.** A completed claim replays here -- BEFORE any balance is
   read. 's first finding is the opposite order: a retry of a charge that
   SUCCEEDED gets "insufficient funds", because the money it is asking about is
   the money that is now missing, and the client is told a completed purchase
   failed. Every mutable check below this line.
4. Lock the article and compare a supplied quote digest with its current body.
   A mismatch is 409 and releases the key -- no money moved, so it must not
   burn a retry. The lock makes the check and debit one serialization point.
5. Re-quote server-side and compare with ``expected_price``. A mismatch is 409
   and releases the key -- no money moved, so it must not burn a retry.
6. Refuse to overwrite a PUBLISHED variant -- in EITHER storage shape. A
   published ``ZPageVariant`` with no legacy mirror is live content reads flipped, and a guard that cannot see it is not a guard.
7. Debit and record the receipt in ONE transaction, then enqueue on commit.
   The published-translation ceiling  is re-checked at the top of that
   transaction, under the parent page's lock, because it is the only place a
   concurrent publish can be excluded -- a lock-free count is a count that a
   publish can invalidate before the debit lands.

WHAT IS DELIBERATELY NOT HERE
-----------------------------
No rate limit and no eligibility gate on SUCCESSFUL spend, beyond having the 2Z
(owner decision, 2026-08-09: *"they bought the 2Zs, they can spend them on
translations"*). Buy as many translations as you can pay for; nothing here
counts them.

THE FAILURE PATH *IS* LIMITED, AND THAT IS A DELIBERATE REVERSAL
------------------------------------------------------------------------
This docstring used to justify the absence of any limit like this: *"The spend
is self-limiting because it is real money, and the existing 100,000-character
content ceiling bounds any single request."*

**That premise only holds for a purchase that succeeds.** A refunded job costs
the buyer exactly zero, so the same 8 2Z recycle indefinitely -- while the
provider has already generated, and billed us for, every output token it
produced before something cut it off. Measured on a 100,000-character zPage at
gpt-4o's seeded prices: **$0.4447 of provider spend, $0.0000 of revenue**, per
iteration.

Be precise about the magnitude: production has seen six refunds in fourteen
days, ~$0.60 of provider spend, so this is a slow leak and not a fire. What was
missing is a **bound**. The concurrency backpressure and the 900-second document
budget alone allowed ~$43/day per account, repeatable for free, and a
fast-failing short article is limited by nothing but worker throughput and the
generic ``user: 1200/minute`` DRF scope.

So the owner decision stands as written and this does not contradict it: what
is bounded below is the cost of FAILURE, never the volume of successful spend.
Two ceilings, both denominated in 2Z of provider spend rather than in events
(one failed max-size document costs ~28 2Z of provider work and one failed short
one ~2 2Z, so an event counter would be either useless or unfair):

* per account, inside ``settlement.failure_window()``;
* platform-wide over the same window, because a broken release is not one
  abusive account, it is many honest accounts each losing us a document, and no
  per-account counter can see that shape.

Both refuse with a 429 and **move no money**. A creator who has been refunded
is never charged for having been refunded; they are asked to wait.
"""
import logging
import uuid

from django import http
from django.db import transaction
from django.db.models import Q

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.renderers import JSONRenderer
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from dj.apps.g12f.localization import normalize_zpage_language
from dj.apps.g12f.models import zPage
from dj.apps.g12f.serializers.translate import (
    TranslationErrorSerializer,
    TranslationJobSerializer,
    TranslationPurchaseSerializer,
    TranslationQuoteSerializer,
)
from dj.apps.g12f.serializers.zpage import (
    MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE,
    MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE,
    draft_translation_variant_count,
    lock_zpages_for_translation_write,
    published_translation_variant_count,
)
from dj.apps.g12f.translation import charges, service, settlement
from dj.apps.g12f.variants import content_digest, occupied_translation
from dj.apps.tuzis import ledger
from dj.apps.tuzis.serializers import InsufficientFundsErrorSerializer
from dj.apps.tuzis import models as idempotency
from f2z import languages

logger = logging.getLogger(__name__)


ZPAGE_PATH_PARAMETER = OpenApiParameter(
    name="free2zaddr",
    type=str,
    location=OpenApiParameter.PATH,
    required=True,
    description="The zPage's `free2zaddr` or its `vanity`.",
)

LANGUAGE_PATH_PARAMETER = OpenApiParameter(
    name="language",
    type=str,
    location=OpenApiParameter.PATH,
    required=True,
    description=(
        "BCP-47 tag of the language to translate INTO. Must be one we sell "
        "into (`f2z.languages.TRANSLATABLE`); bare `pt` canonicalizes to "
        "`pt-BR`. The article's own `source_language` is refused -- that is "
        "the article, not a translation of it."
    ),
)

# Declaring this in the contract is doctrine (CLAUDE.md), and  is the model
# to copy: a money endpoint whose retry semantics live only in the server is an
# endpoint no generated client (hey-api, orval, the MCP server, ZUULI) can use
# safely. `idempotency-key` is already in `CORS_ALLOW_HEADERS`, which is the
# other half --  found the header documented but unreachable from a browser
# because the preflight rejected it.
PURCHASE_IDEMPOTENCY_KEY_PARAMETER = OpenApiParameter(
    name="Idempotency-Key",
    type={
        "type": "string",
        "format": "uuid",
        "minLength": 36,
        "maxLength": 36,
    },
    location=OpenApiParameter.HEADER,
    required=True,
    description=(
        "**Required** UUIDv4 retry key. Reuse the SAME key for every retry of "
        "one purchase and a NEW key for a genuinely new one. A retry of a "
        "completed purchase replays its record -- including its CURRENT status "
        "-- and does not charge again, for "
        f"{idempotency.COMPLETED_CLAIM_RETENTION.days} days. A retry sent "
        "while the original is still deciding answers 409 "
        "`request_in_progress`, which means 'undecided, ask again shortly', "
        "never a second charge. The key is scoped to the authenticated "
        "creator and to this operation, and is bound to the article, the "
        "target language, the article's content digest and the price you "
        "confirmed: reusing it for a different one of those answers 409 "
        "`idempotency_mismatch`. A request that moves no 2Z (a price "
        "mismatch, insufficient funds) does NOT burn the key."
    ),
)


class _Refuse(Exception):
    """A refusal decided INSIDE the money transaction.

    Carried as an exception rather than a return value because that is how the
    debit and the idempotency claim roll back together -- which is what makes
    "nothing was charged" a fact rather than a hope. Every check that has to
    see the page under its lock (the  ceiling, and the published-variant
    guard re-read there) leaves this way.
    """

    def __init__(self, response):
        super().__init__("purchase refused under the page lock")
        self.response = response


def _error(code, message, http_status, **fields):
    return Response({"code": code, "error": message, **fields}, status=http_status)


def _occupied_languages(page, languages, *, published_only=False):
    """Which of ``languages`` already hold a translation on ``page``, any shape.

    The set-at-a-time form of:func:`variants.occupied_translation`'s "is this
    language free", for the ceiling reservations: a row in EITHER
    table occupies the language (with ``published_only``, a PUBLISHED row in
    either table -- reader-visible somewhere is enough).
    """
    from dj.apps.g12f.models import ZPageTranslation, ZPageVariant

    languages = list(languages)
    if not languages:
        return set()
    legacy = ZPageTranslation.objects.filter(
        zpage_id=page.pk, language__in=languages
    )
    variant = ZPageVariant.objects.filter(
        zpage_id=page.pk, language__in=languages
    ).exclude(origin=ZPageVariant.SOURCE)
    if published_only:
        legacy = legacy.filter(is_published=True)
        variant = variant.filter(is_published=True)
    return set(legacy.values_list("language", flat=True)) | set(
        variant.values_list("language", flat=True)
    )


class Reservations:
    """Ceiling slots already spoken for by queued jobs and earlier batch items.

    : once several jobs can be in flight, "is there room?" has to count
    what running jobs WILL create, not only what exists -- or N jobs into N new
    languages all pass at purchase. Two ceilings, two sets:

    * ``drafts``: languages that will become a NEW draft (no translation there
      yet). The draft ceiling.
    * ``publishes``: new languages that will hold a translation the creator
      could publish and that are not published now. Replacing an existing
      draft adds no language. The published ceiling: with one publish
      slot left, two new languages must not both be sold, because one could
      never be published.
    """

    def __init__(self, drafts=(), publishes=()):
        self.drafts = set(drafts)
        self.publishes = set(publishes)

    def add(self, language, existing):
        """Count an accepted item of a batch against both ceilings."""
        if existing is None:
            self.drafts.add(language)
            # A translation into a new language adds another publishable
            # language. Replacing an existing draft does not: it stays the
            # same language and publication remains subject to the live cap.
            self.publishes.add(language)


def _public_variant(existing):
    """Drop the internal digest before the variant summary leaves the server."""
    if existing is None:
        return None
    return {
        "is_published": existing["is_published"],
        "origin": existing["origin"],
    }


class _TranslationRouteMixin:
    """Shared resolution + validation for the three translation routes."""

    permission_classes = [IsAuthenticated]
    # JSON only, for the reason spelled out in `PromptResponseViewSet`: DRF
    # renders the response AFTER the money transaction has committed, and
    # `BrowsableAPIRenderer` would run template rendering and its own queries
    # in that post-commit window -- turning a transient failure into a 500,
    # into a retry, into a second charge.
    renderer_classes = [JSONRenderer]

    def get_page(self, request, free2zaddr):
        """The requester's own zPage, or 404.

        Owner-scoped rather than permission-checked: whether someone else's
        article exists is not a fact this route hands out, and it matches what
        every other zPage write path does.
        """
        page = (
            zPage.objects.filter(creator=request.user)
            .filter(Q(free2zaddr=free2zaddr) | Q(vanity__iexact=free2zaddr))
            .first()
        )
        if page is None:
            raise http.Http404
        return page

    def validate_target(self, page, language):
        """Normalize the target language and refuse the cases that cannot work.

        Returns ``(language, error_response)``; exactly one is meaningful.
        """
        try:
            language = normalize_zpage_language(language, allow_missing=False)
        except Exception as exc:
            return None, _error(
                "invalid_language", str(exc), status.HTTP_400_BAD_REQUEST
            )

        if not languages.is_translatable(language):
            return None, _error(
                "not_translatable",
                "We do not sell AI translations into "
                f"{service.language_name(language)} yet. You can still write "
                "this translation by hand.",
                status.HTTP_400_BAD_REQUEST,
            )

        if not page.source_language or not languages.is_detectable(
            page.source_language
        ):
            return None, _error(
                "unknown_source_language",
                "This article's language has not been determined yet, so "
                "there is nothing to translate from. Set it and try again.",
                status.HTTP_400_BAD_REQUEST,
            )

        if language == page.source_language:
            return None, _error(
                "same_language",
                "This article is already written in "
                f"{service.language_name(language)}.",
                status.HTTP_400_BAD_REQUEST,
            )

        if not (page.content or "").strip():
            return None, _error(
                "empty_article",
                "There is nothing to translate yet.",
                status.HTTP_400_BAD_REQUEST,
            )

        return language, None

    def published_variant_limit_error(self, page, language, existing,
                                      reserved=None):
        """409 when the thing they are buying could never be published.

        The / ceiling -- 64 published translations per zPage -- is
        enforced at PUBLISH time, in
        ``enforce_published_translation_variant_limit``. An AI translation
        always lands as a draft, so a purchase never trips that check itself;
        it just buys a draft the creator will be refused when they try to
        publish it. Taking 2Z for that is taking 2Z for nothing, which is the
        one outcome this feature cannot ship with.

        WHERE THIS IS CALLED FROM, AND WHY IT MATTERS TWICE
        ---------------------------------------------------
        This reads MUTABLE state -- another language published a second ago
        changes the answer -- and on the purchase it is therefore subject to
        both of this endpoint's ordering rules:

        1. **Below the idempotency claim.** Above it, a retry of a purchase
           that already succeeded would be answered "the ceiling is full,
           nothing was charged" instead of replaying the receipt for the 2Z
           that are already gone.  finding 1 wearing a different hat.
        2. **Inside the money transaction, under the parent's lock.**
           ``published_translation_variant_count`` says in its docstring to
           call it only while the page is locked, and the reason is this
           exact check: lock-free, a purchase counts 63, a concurrent publish
           commits the 64th, and the debit goes through anyway -- producing
           the charged-but-unpublishable outcome this function exists to
           prevent. Raising from inside that transaction is what makes the
           rollback and "nothing was charged" the same fact.

        The quote calls it too, lock-free and outside any transaction, which
        is right for a route that moves no money and holds no key: its job is
        to keep a price off the screen, and it costs a creator nothing if a
        publish lands a millisecond later.

        A *pre-check*, not a replacement: the authoritative guard is still
        ``enforce_published_translation_variant_limit`` at publish time.

        A published target is cardinality-neutral and refused separately with
        ``variant_published``. Rewriting an existing draft adds no language, so
        slots reserved by queued jobs and earlier batch items do not count
        against it  -- but it must still be publishable TODAY: with
        every slot already published, the re-translated draft could never be
        published either, so it is refused like a new language. ``existing``
        is passed in rather than re-read so the checks agree about what is on
        the page.
        """
        if existing is not None and existing["is_published"]:
            return None
        published = published_translation_variant_count(page)
        if existing is not None:
            reserved_count = 0
        else:
            if reserved is None:
                reserved = self.reservations(page).publishes
            # Plus the not-yet-published NEW languages queued jobs and earlier
            # items of this batch will deliver: each of those may take
            # a slot first.
            reserved_count = len(reserved - {language})
        count = published + reserved_count
        if count < MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE:
            return None
        reserved_message = (
            "no queued or earlier-in-batch translations reserve extra slots"
            if reserved_count == 0
            else f"{reserved_count} queued or earlier-in-batch translation(s) "
                 "reserve extra slots"
        )
        return _error(
            "published_variant_limit",
            f"This article has {published} published translations; "
            f"{reserved_message}, together using {count} of its "
            f"{MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE} publish slots. "
            "Unpublish or delete a translation before buying one that could "
            "not be published.",
            status.HTTP_409_CONFLICT,
        )

    def reservations(self, page):
        """What the article's QUEUED jobs will take from both ceilings.

        : with one job in flight per account the ceilings could count only
        what exists. With several, N jobs into N new languages all passed the
        purchase-time count and then aborted one by one at delivery with
        ``draft_variant_limit`` -- sold, generated, refunded, our provider
        spend gone -- or delivered drafts the creator can never publish. See
        :class:`Reservations`.
        """
        in_flight = charges.in_flight_languages(page.creator_id, page.pk) - {
            page.source_language
        }
        if not in_flight:
            return Reservations()
        return Reservations(
            drafts=in_flight - _occupied_languages(page, in_flight),
            # A queued re-translation of an existing draft replaces that
            # language; it does not reserve a second publish slot.
            publishes=in_flight - _occupied_languages(page, in_flight),
        )

    def draft_variant_limit_error(self, page, language, existing,
                                  reserved=None):
        """409 when the draft they are buying would exceed the draft cap.

        An AI translation always lands as a draft. Overwriting an existing
        draft is cardinality-neutral. A new draft language is refused if the
        page's drafts PLUS the new drafts already-queued jobs will create
        (``reserved``, ) would reach MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE.
        """
        if existing is not None:
            return None
        if reserved is None:
            reserved = self.reservations(page).drafts
        count = draft_translation_variant_count(page) + len(reserved - {language})
        if count < MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE:
            return None
        return _error(
            "draft_variant_limit",
            "This article already has "
            f"{MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE} draft "
            "translations, counting the ones still being translated. Delete "
            "or publish an existing draft translation first -- we are not "
            "going to sell you a translation when your draft working set is "
            "full.",
            status.HTTP_409_CONFLICT,
        )

    def item_refusal(self, page, language, quote, expected_price, *, user,
                     reserved=None):
        """``(existing, error_response)`` for ONE language, under the locks.

        Every per-language refusal the purchase makes once it holds the
        buyer's balance row and the article row, in one place, so the
        single-language purchase and the bulk one  cannot drift apart:
        the price still matches, nothing published is overwritten, no job is
        already running for this exact target, and the result could be stored
        and published. ``existing`` is read here, under the lock, because it
        also decides ``target_digest`` -- the worker's only defence against
        delivering over the creator's own edits -- so a snapshot taken before
        the lock is a paid overwrite waiting to happen. (codex adversarial
        review.)
        """
        if quote.price != expected_price:
            return None, _error(
                "price_changed",
                "The price for this translation is no longer "
                f"{expected_price} 2Z. Re-quote before buying.",
                status.HTTP_409_CONFLICT,
                price=quote.price,
            )

        existing = self.existing_variant(page, language)
        if existing is not None and existing["is_published"]:
            return existing, _error(
                "variant_published",
                "A published translation already exists in this "
                "language. Unpublish or delete it first -- "
                "machine output never overwrites live content.",
                status.HTTP_409_CONFLICT,
            )

        # Never two live jobs for the SAME target, whatever the account cap
        # is set to. Two can both pass their pre-flight checks; the first
        # delivers, the second finds the draft changed, and  attributes
        # `variant_changed` to the buyer -- who edited nothing. Our own
        # delivery moved the row. Load-bearing raised the cap.
        # (codex adversarial review of, round 5.)
        if charges.has_in_flight_for_target(user, page.pk, language):
            return existing, _error(
                "translation_in_progress",
                "A translation of this article into this language "
                "is already running. Wait for it to finish.",
                status.HTTP_409_CONFLICT,
            )

        if reserved is None:
            reserved = self.reservations(page)
        error = self.published_variant_limit_error(
            page, language, existing, reserved=reserved.publishes
        )
        if error is not None:
            return existing, error
        error = self.draft_variant_limit_error(
            page, language, existing, reserved=reserved.drafts
        )
        if error is not None:
            return existing, error
        return existing, None

    def capacity_refusal(self, user, count):
        """Queue backpressure for ``count`` new jobs; ``None`` when they fit.

        Moves no money. Checked under the same locks as the debit, after the
        idempotency claim. A bulk purchase is all-or-nothing, so it either
        fits whole or is refused whole -- never a partial batch the client
        did not ask for.

        Takes the platform-wide admission lock first: MUST be called inside
        the money transaction, after the buyer and article row locks, and
        before the debit (see ``charges.lock_admission``).
        """
        charges.lock_admission()
        cap = charges.account_in_flight_cap()
        in_flight = charges.in_flight_count(user)
        if in_flight + count > cap:
            return _error(
                "translation_in_progress",
                f"You can have up to {cap} translations running at once and "
                f"{in_flight} already are. Wait for some to finish, then "
                "start the rest.",
                status.HTTP_409_CONFLICT,
                in_flight=in_flight,
                max_in_flight=cap,
            )
        if charges.queued_count() + count > charges.max_queued():
            return _error(
                "translation_backlog",
                "Translations are backed up right now. Try again "
                "in a few minutes -- you have not been charged.",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return None

    def failure_ceiling_error(self, user, now=None):
        """429 when recent FAILURES have already burned their spend ceiling.

        Two ceilings, per account and platform-wide, both over
        ``settlement.failure_window()`` and both counted in 2Z of provider spend
        on jobs that failed. Nothing about successful purchases is counted, and
        a refusal here moves no money.

        A failure that cost us nothing -- the article vanished, the model was
        flagged off, the job never ran -- does not count, because
        ``charges.failed_spend`` only looks at charges where the provider
        actually did billable work. So an account cannot be locked out by
        failures that were free to everyone.

        ``Retry-After`` is the whole window, deliberately over-stating it: the
        exact moment a rolling total drops back under a ceiling is not something
        a client should be told to poll for.
        """
        per_user = charges.max_failed_spend_per_user()
        platform = charges.max_failed_spend_platform()
        if per_user <= 0 and platform <= 0:
            return None
        retry_after = int(settlement.failure_window().total_seconds())
        if per_user > 0:
            failures, spend = charges.failed_spend(user=user, now=now)
            if spend >= per_user:
                logger.warning(
                    "translation purchase refused: creator %s has burned %s 2Z "
                    "of provider spend on %d failed translation(s) in the last "
                    "%ss (ceiling %s)",
                    user.pk, spend, failures, retry_after, per_user,
                )
                return _error(
                    "translation_failure_cooldown",
                    # Scoped to THIS attempt, deliberately. The earlier wording
                    # added "and every failed translation was refunded", which
                    # `failed_spend` itself contradicts: it counts
                    # `charges.FAILED`, which includes `settled` rows, so the one
                    # creator who HAD been partially billed was the one being
                    # told nothing had been. There is no localized frontend case
                    # for this code either, so that English prose is what they
                    # read. (Reviewer of, finding 2.)
                    "Several of your recent translations failed, so we have "
                    "paused new ones for a short while. This attempt has not "
                    "been charged. Please try again a little later.",
                    status.HTTP_429_TOO_MANY_REQUESTS,
                    retry_after=retry_after,
                )
        if platform > 0:
            failures, spend = charges.failed_spend(now=now)
            if spend >= platform:
                logger.error(
                    "translation purchases paused platform-wide: %s 2Z of "
                    "provider spend on %d failed translation(s) in the last "
                    "%ss (ceiling %s)",
                    spend, failures, retry_after, platform,
                )
                return _error(
                    "translation_failing",
                    "AI translation is failing more than it should right now, "
                    "so we have paused sales rather than sell you one that "
                    "will not arrive. This attempt has not been charged. "
                    "Please try again later.",
                    status.HTTP_429_TOO_MANY_REQUESTS,
                    retry_after=retry_after,
                )
        return None

    def existing_variant(self, page, language):
        """What already occupies the target language, or ``None``.

        ``digest`` is not published in the API response -- it is carried on the
        charge record so the worker can refuse to deliver over a draft the
        creator has edited since they bought (codex adversarial review).

        Resolved across BOTH shapes. An earlier revision asked only
        ``ZPageTranslation``, which reports "this language is free" about a
        published variant-only row -- a translation that is live on the site
        since reads flipped. The purchase would be allowed, and the dual-write
        mirror would then overwrite that live translation with machine output
        and unpublish it. See:func:`variants.occupied_translation`.
        """
        occupant = occupied_translation(page.pk, language)
        if occupant is None:
            return None
        is_published, origin, digest = occupant
        return {
            "is_published": is_published,
            "origin": origin,
            "digest": digest,
        }

    def build_quote(self, page, language):
        """``(quote, error_response)``. The quote is a pure read."""
        ai_model = service.select_translation_model()
        if ai_model is None:
            logger.error(
                "no callable AIModel for zPage translation; preference=%s",
                service.model_preference(),
            )
            return None, _error(
                "translation_unavailable",
                "AI translation is not available right now. Please try again "
                "later.",
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        quote = service.quote_document(
            title=page.title,
            description=page.description,
            content=page.content,
            source_language=page.source_language,
            target_language=language,
            ai_model=ai_model,
            source_digest=content_digest(page.content),
        )
        return quote, None

    def wall_clock_error(self, quote):
        """409 ``translation_too_long`` when the plan cannot finish.

        A pure function of the quote -- the document, the model and the
        language pair -- so it is asked wherever a price is: the quote, the
        single purchase and both bulk routes, per language. Nothing has moved
        when it answers, so it refuses before any 2Z or provider work exists.

        Before  this document was SOLD, and its translation into a
        high-expansion language (Lao, Amharic) ran out of the 900s document
        clock part-way through, after we had paid the provider for every
        fragment before the one that ran out. Both outcomes refunded the
        creator; only one of them left us holding the bill, and only one of
        them made the creator wait fifteen minutes to be told no.
        """
        shortfall = service.wall_clock_shortfall(quote.wall_clock)
        if shortfall is None:
            return None
        language = service.language_name(quote.target_language)
        if shortfall == service.TOO_LONG_FRAGMENT:
            message = (
                f"One paragraph of this article is too long to translate into "
                f"{language} in a single step. Nothing was charged. Break that "
                "paragraph up and ask for a new price."
            )
        else:
            message = (
                f"This article is too long to translate into {language} in "
                "one job. Nothing was charged. A shorter article, or this one "
                "split in two, can be translated."
            )
        logger.info(
            "translation refused at quote: %s too long for %s -> %s on %s/%s "
            "(document ~%.0fs, longest fragment ~%.0fs at %.0f tok/s)",
            shortfall, quote.source_language, quote.target_language,
            quote.ai_model.provider, quote.ai_model.model,
            quote.wall_clock.total_seconds,
            quote.wall_clock.longest_fragment_seconds,
            service.MIN_OUTPUT_TOKENS_PER_SECOND,
        )
        return _error(
            "translation_too_long", message, status.HTTP_409_CONFLICT,
        )


class ZPageTranslationQuoteView(_TranslationRouteMixin, APIView):
    """`GET.../translate/quote/` -- the price, with no charge."""

    @extend_schema(
        operation_id="zpage_translation_quote",
        parameters=[ZPAGE_PATH_PARAMETER, LANGUAGE_PATH_PARAMETER],
        responses={
            200: TranslationQuoteSerializer,
            400: TranslationErrorSerializer,
            404: TranslationErrorSerializer,
            409: TranslationErrorSerializer,
            503: TranslationErrorSerializer,
        },
        description=(
            "What an AI translation of this zPage into `language` would cost, "
            "in 2Z. **Charges nothing and writes nothing.**\n\n"
            "Pricing is cost-plus and always metered -- the price is what the "
            "provider call costs us, rounded up to the next penny, and one "
            "penny is one 2Z. There is no flat price and no cap, so this "
            "endpoint is not optional: it is the only way a creator can see "
            "the number before agreeing to it. The price is computed from the "
            "token count of the real prompt for this exact article on the "
            "model named in the response.\n\n"
            "Answers 409 `published_variant_limit` when the article already "
            "holds its full complement of published translations, or 409 "
            "`draft_variant_limit` when it holds its full complement of draft "
            "translations: a new one could never be published or stored, so "
            "there is no price to show (#1126, #1159). Answers 409 "
            "`translation_too_long` when the article (or one paragraph of it) "
            "is too long to translate into `language` inside the translation "
            "time limit, estimated from the same output-token estimate as the "
            "price (#1973).\n\n"
            "Owner only; a non-owner gets 404."
        ),
    )
    def get(self, request: Request, free2zaddr=None, language=None):
        page = self.get_page(request, free2zaddr)
        language, error = self.validate_target(page, language)
        if error is not None:
            return error

        # Checked HERE, not in the purchase alone, so the creator never sees a
        # price for something unbuyable. The quote moves no money
        # and holds no idempotency key, so the "mutable checks below the claim"
        # rule has nothing to say about this route.
        existing = self.existing_variant(page, language)
        error = self.published_variant_limit_error(page, language, existing)
        if error is not None:
            return error
        error = self.draft_variant_limit_error(page, language, existing)
        if error is not None:
            return error

        quote, error = self.build_quote(page, language)
        if error is not None:
            return error
        error = self.wall_clock_error(quote)
        if error is not None:
            return error

        balance = request.user.tuzis
        return Response({
            "price": quote.price,
            "balance": str(balance),
            "affordable": balance >= quote.price,
            "source_language": page.source_language,
            "language": language,
            "source_digest": quote.source_digest,
            "ai_model": quote.ai_model.display_name,
            "input_tokens": quote.input_tokens,
            "estimated_output_tokens": quote.output_tokens,
            "chunks": quote.chunks,
            "existing_variant": _public_variant(existing),
        })


class ZPageTranslationView(_TranslationRouteMixin, APIView):
    """`POST` to buy a translation, `GET` to ask what became of one."""

    # See the module docstring: `IdempotencyKey.claim()` only does what its
    # docstring says outside `AtomicMiddleware`'s request-wide transaction.
    atomic_request = False

    # ---------------------------------------------------------------- POST --
    @extend_schema(
        operation_id="zpage_translation_purchase",
        parameters=[
            ZPAGE_PATH_PARAMETER,
            LANGUAGE_PATH_PARAMETER,
            PURCHASE_IDEMPOTENCY_KEY_PARAMETER,
        ],
        request=TranslationPurchaseSerializer,
        responses={
            202: TranslationJobSerializer,
            400: TranslationErrorSerializer,
            402: InsufficientFundsErrorSerializer,
            404: TranslationErrorSerializer,
            409: TranslationErrorSerializer,
            429: TranslationErrorSerializer,
            503: TranslationErrorSerializer,
        },
        description=(
            "Buy an AI translation of this zPage into `language`. Debits "
            "`expected_price` 2Z, enqueues the work and answers **202** with a "
            "job id -- a long article takes minutes, so this is never "
            "synchronous. Poll `GET .../translate/`.\n\n"
            "`expected_price` must equal the server's own recomputed price or "
            "the purchase is refused with 409 `price_changed` and nothing is "
            "charged. New clients must also send the quote's `source_digest`; "
            "if the article body changed, the purchase is refused with 409 "
            "`source_changed` and nothing is charged. Legacy callers that omit "
            "the digest are checked against the body read at request start. "
            "`Idempotency-Key` is required: "
            "a double-click charges once.\n\n"
            "The result is always a **DRAFT** variant with `origin: \"ai\"` -- "
            "machine translations are never auto-published, and editing one "
            "flips it to `human`. If the translation fails for any reason -- "
            "the provider, unusable output, a safety check, a job that never "
            "runs, our own output cap -- the full amount is credited back and "
            "nothing is written. The ONE exception (#1908): if the article is "
            "edited or re-labelled, or its translation is edited or published, "
            "from under a job that has already been paid for, repeatedly "
            "inside one window, the provider work that was already done and "
            "billed to us is settled at metered cost (`status: \"settled\"`) "
            "instead of refunded. Never more than the quoted price, and never "
            "more than the provider actually did.\n\n"
            "Deleting the article, an ownership change, and a re-label our own "
            "language detector made are deliberately NOT in that set: we "
            "cannot tell them from an action of ours, so they refund in "
            "full.\n\n"
            "Recent FAILURES are rate-limited (429 "
            "`translation_failure_cooldown`, or `translation_failing` when the "
            "whole feature is failing), with `retry_after` in seconds. The "
            "refused attempt is not charged, and successful purchases are not "
            "rate-limited at all.\n\n"
            "A **published** variant in the target language is refused (409 "
            "`variant_published`): unreviewed machine output never overwrites "
            "live content. Unpublish or delete it first.\n\n"
            "An article already at its published-translation ceiling is "
            "refused (409 `published_variant_limit`) -- the draft it "
            "would buy could never be published (#1126). An article already "
            "at its draft-translation ceiling is refused too (409 "
            "`draft_variant_limit`) -- we do not charge for a translation "
            "that cannot be stored (#1159). An article too long to translate "
            "into `language` inside our time limit is refused (409 "
            "`translation_too_long`) -- we do not sell a translation that "
            "cannot finish (#1973).\n\n"
            "Owner only; a non-owner gets 404."
        ),
    )
    def post(self, request: Request, free2zaddr=None, language=None):
        key = _idempotency_key(request)
        if key is None:
            return _error(
                "idempotency_key_required",
                "A valid UUIDv4 Idempotency-Key header is required.",
                status.HTTP_400_BAD_REQUEST,
            )

        serializer = TranslationPurchaseSerializer(data=request.data)
        if not serializer.is_valid():
            return _error(
                "invalid_request",
                "Send the price you quoted as a whole number of 2Z in "
                "`expected_price`.",
                status.HTTP_400_BAD_REQUEST,
            )
        expected_price = serializer.validated_data["expected_price"]
        quoted_source_digest = serializer.validated_data.get("source_digest")
        # Which refund terms the client says it showed. NOT part of
        # `request_fingerprint` -- see below.
        declared_policy = serializer.validated_data.get("settlement_policy")

        page = self.get_page(request, free2zaddr)
        # Only normalize request identity before replay. Source language and
        # content are mutable: edits must not hide an already-paid receipt.
        try:
            language = normalize_zpage_language(language, allow_missing=False)
        except Exception as exc:
            return _error("invalid_language", str(exc), status.HTTP_400_BAD_REQUEST)

        # The submitted digest, rather than a fresh read, is the request's
        # identity. That is what lets a retry replay a completed purchase even
        # after the article has been edited. A missing digest is the deliberate
        # compatibility path for older API callers.
        source_digest = quoted_source_digest or content_digest(page.content)
        request_hash = charges.request_fingerprint(
            zpage_id=page.pk,
            language=language,
            source_digest=source_digest,
            price=expected_price,
        )
        # `declared_policy` is deliberately NOT in that fingerprint. It
        # names the terms the buyer was shown, not what they are buying or what
        # it costs, so a retry that differs only there is still the same
        # purchase and must replay its receipt rather than answer 409
        # `idempotency_mismatch` about money that is already spent.

        # THE KEY IS CLAIMED BEFORE ANY MUTABLE CHECK. See the module
        # docstring; this ordering is  finding 1 and it is load-bearing.
        claim, duplicate = _claim(request.user, key, request_hash)
        if duplicate is not None:
            return duplicate

        try:
            try:
                # Tokenizer initialization can fetch data on a cold process.
                # Price outside money locks, then verify every article input
                # against the locked row before accepting this exact quote.
                language, error = self.validate_target(page, language)
                if error is not None:
                    raise _Refuse(error)
                quote_inputs = (
                    page.title, page.description, page.content, page.source_language,
                )
                quote, error = self.build_quote(page, language)
                if error is not None:
                    raise _Refuse(error)
                error = self.wall_clock_error(quote)
                if error is not None:
                    raise _Refuse(error)
                # THE FAILURE PATH'S OWN CEILINGS, deliberately OUTSIDE
                # the money transaction and its locks.
                #
                # After the claim, so a retry of a completed purchase still
                # replays its receipt rather than being told 429 about money
                # that is already spent ( finding 1, one refusal further
                # on). Before the transaction, because it scans a window of
                # charge records and it is a SOFT ceiling: unlike the
                # published-variant count, nothing about it needs a concurrent
                # purchase to be excluded, so holding the buyer's balance row
                # and the article row across that scan would buy nothing and
                # lengthen the one lock every 2Z spend on a zPage contends for.
                # A purchase that slips in alongside another is one document of
                # overshoot on a ceiling measured in dozens.
                error = self.failure_ceiling_error(request.user)
                if error is not None:
                    raise _Refuse(error)
                with transaction.atomic():
                    #, INSIDE the money transaction and under the
                    # parent's lock -- the same serialization point every
                    # publish takes. `published_translation_variant_count`
                    # says in its own docstring to call it only while the page
                    # is locked, and it means it: lock-free, a purchase can
                    # count 63, a concurrent publish can commit the 64th, and
                    # the debit below still goes through. That is the exact
                    # "charged for something unpublishable" outcome this check
                    # exists to prevent, so checking it anywhere the publish
                    # cannot be excluded is checking it for show. (codex
                    # adversarial review, second pass.)
                    #
                    # Held for the length of a debit and a claim update, which
                    # is the same lock a publish already takes for its own
                    # write -- no new contention shape, and only ever between
                    # writers to ONE article.
                    #
                    # The buyer's Creator row comes FIRST, before the page
                    # row -- the global lock order (`ledger.lock_in_order`),
                    # the one `vote_page` and `FundPageView` take. This used
                    # to lock the page and then debit the balance, i.e. page
                    # -> Creator, the exact inversion  removed from the
                    # vote path: an owner buying a translation while voting
                    # on (or funding) their own page held one row each and
                    # waited on the other, and Postgres killed one side with
                    # `deadlock detected`. Reproduced with the real endpoints
                    # by the adversarial review of. Taking the balance
                    # row here first costs nothing the debit below would not
                    # have taken anyway, and puts every 2Z spend on a zPage
                    # on the one order.
                    ledger.lock_in_order(request.user)
                    locked_page = lock_zpages_for_translation_write(page.pk).get(
                        page.pk
                    )
                    if locked_page is None:
                        raise http.Http404

                    current_source_digest = content_digest(locked_page.content)
                    # Keep the digest used to claim this identity immutable,
                    # including for callers that omit a quoted precondition.
                    if current_source_digest != source_digest or quote_inputs != (
                        locked_page.title, locked_page.description,
                        locked_page.content, locked_page.source_language,
                    ):
                        raise _Refuse(_error(
                            "source_changed",
                            "The article changed before purchase. Refresh "
                            "the quote before buying.",
                            status.HTTP_409_CONFLICT,
                            source_digest=current_source_digest,
                        ))

                    # All quote inputs still match the locked row. Mutable
                    # variant and balance checks below remain under the locks,
                    # and are the SAME code the bulk purchase runs per item
                    #, so the two cannot drift apart.
                    page = locked_page
                    existing, error = self.item_refusal(
                        page, language, quote, expected_price,
                        user=request.user,
                    )
                    if error is not None:
                        raise _Refuse(error)

                    # Queue backpressure is checked after the same claim and
                    # before the debit. It still moves no money.
                    error = self.capacity_refusal(request.user, 1)
                    if error is not None:
                        raise _Refuse(error)

                    job_id = charges.new_job_id()
                    balance = ledger.debit(
                        request.user,
                        quote.price,
                        action="translation",
                    )
                    body = charges.initial_body(
                        job_id=job_id,
                        zpage_id=page.pk,
                        language=language,
                        source_digest=source_digest,
                        target_digest=(
                            existing["digest"] if existing else None
                        ),
                        price=quote.price,
                        ai_model=quote.ai_model,
                        balance=balance,
                        settlement_policy=declared_policy,
                    )
                    # `finish` MUST be in the same transaction as the debit:
                    # that is what makes "response_status IS NULL" mean "no
                    # money moved", which is the invariant the 15-minute stale
                    # takeover in `IdempotencyKey` rests on.
                    claim.finish(status.HTTP_202_ACCEPTED, body)
                    # Enqueue only once the charge is durable. If the queue
                    # insert fails, `robust=True` keeps the (successful,
                    # committed) purchase from 500ing -- and the reaper
                    # refunds a charge whose job never arrives.
                    transaction.on_commit(
                        lambda: _defer_translation(job_id), robust=True
                    )
            except _Refuse as refusal:
                # The transaction rolled back, so no money moved -- which is
                # exactly what "does not burn the key" requires.
                idempotency.release(claim)
                return refusal.response
            except ledger.InsufficientFunds as exc:
                idempotency.release(claim)
                return Response(
                    ledger.insufficient_funds_payload(
                        exc, action="translation"
                    ),
                    status=status.HTTP_402_PAYMENT_REQUIRED,
                )
        except Exception:
            idempotency.release(claim)
            raise

        return Response(
            {**charges.public_body(body), "replayed": False},
            status=status.HTTP_202_ACCEPTED,
        )

    # ----------------------------------------------------------------- GET --
    @extend_schema(
        operation_id="zpage_translation_status",
        parameters=[ZPAGE_PATH_PARAMETER, LANGUAGE_PATH_PARAMETER],
        responses={
            200: TranslationJobSerializer,
            400: TranslationErrorSerializer,
            404: TranslationErrorSerializer,
        },
        description=(
            "The most recent AI translation purchase for this zPage and "
            "language, and what became of it. 404 when the creator has never "
            "bought one.\n\n"
            "Poll this after a 202. `status` moves `queued` -> `delivered`, "
            "`refunded` or `settled` (all three terminal), and never leaves "
            "`queued` forever: a "
            "charge whose job never ran is refunded in full by the "
            "`g12f.reap_translation_charges` sweep within ten minutes of its "
            "deadline. A job still WAITING in the queue has not 'never run': "
            "it keeps its charge until it runs, or until the outer deadline "
            "of six hours from purchase (#2348).\n\n"
            "Owner only; a non-owner gets 404."
        ),
    )
    def get(self, request: Request, free2zaddr=None, language=None):
        # NOTE -- deliberately read-only, including the repair path.
        #
        # An earlier revision refunded an abandoned charge here, so the answer
        # to "where is my money" was true at the instant it was asked rather
        # than up to ten minutes stale. `test_a_read_never_writes` ( Rule
        # B) rejected it, and it was right to: a GET that moves 2Z is a GET a
        # link prefetcher, a mail scanner or a browser reload performs on the
        # creator's behalf. The refund is idempotent and only fires 90 minutes
        # after the charge, so nothing bad was reachable -- but "nothing bad is
        # reachable today" is exactly the argument that ages badly, and the
        # sweep already closes the gap within ten minutes. Not worth an
        # allowlist entry.
        page = self.get_page(request, free2zaddr)
        try:
            language = normalize_zpage_language(language, allow_missing=False)
        except Exception as exc:
            return _error(
                "invalid_language", str(exc), status.HTTP_400_BAD_REQUEST
            )

        record = charges.latest_record(request.user, page.pk, language)
        if record is None:
            raise http.Http404

        return Response(
            {**charges.public_body(record.response_body), "replayed": False}
        )


# --------------------------------------------------------------------------- #
# Idempotency plumbing
# --------------------------------------------------------------------------- #
def _idempotency_key(request):
    """A strict UUIDv4 from the header, or ``None``.

    Strict on purpose: ``IdempotencyKey.key`` truncates at 200 characters, so
    two keys sharing a 200-character prefix would silently replay each other,
    and a blank value would disable the protection entirely rather than error
    ( finding 3). A UUIDv4 cannot do either.
    """
    raw = request.headers.get("Idempotency-Key")
    if raw is None:
        return None
    try:
        parsed = uuid.UUID(raw.strip())
    except (AttributeError, ValueError):
        return None
    if parsed.version != 4:
        return None
    return str(parsed)


def _claim(user, key, request_hash):
    """``(claim, duplicate_response)`` -- exactly one is meaningful."""
    try:
        return idempotency.claim(
            charges.SCOPE, user, key, request_hash=request_hash
        ), None
    except idempotency.IdempotencyConflict:
        return None, _error(
            "idempotency_mismatch",
            "This idempotency key was already used for a different purchase.",
            status.HTTP_409_CONFLICT,
        )
    except idempotency.DuplicateRequest as duplicate:
        if duplicate.in_flight:
            return None, _error(
                "request_in_progress",
                "The original purchase is still being decided. Ask again "
                "shortly -- this is never a second charge.",
                status.HTTP_409_CONFLICT,
            )
        body = duplicate.record.response_body
        if not isinstance(body, dict):
            return None, _error(
                "invalid_idempotency_record",
                "The original response could not be replayed safely.",
                status.HTTP_409_CONFLICT,
            )
        # Note the deliberate difference from the donation replay: that one is
        # a verbatim record of a finished transfer, this one is a LIVE record
        # of a job. Replaying the stored body therefore reports the job's
        # current status, which is exactly what a client that lost the 202
        # needs to know.
        return None, Response(
            {**charges.public_body(body), "replayed": True},
            status=duplicate.record.response_status,
        )


def _defer_translation(job_id):
    """Enqueue the worker. Imported late so the URLconf does not need the app."""
    from dj.apps.g12f.translation.tasks import translate_zpage

    translate_zpage.defer(job_id=job_id)
