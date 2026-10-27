"""The Procrastinate worker that actually translates a zPage ( §6.1 step 5).

Long documents take minutes, so this is never a synchronous request: the view
debits and enqueues, and everything below happens on a worker.

WHAT MAKES THIS SAFE TO RUN TWICE
---------------------------------
Every path through this task ends in exactly one of three outcomes, and all
three are compare-and-set transitions on the charge record
(:mod:`dj.apps.g12f.translation.charges`):

* the draft variant exists and the record says ``delivered``;
* nothing was written and the record says ``refunded``, with the full amount
  credited back;
* somebody else already settled the record, and this run wrote nothing.

So a duplicate job, a Procrastinate retry after a crash, and the reaper racing
a very slow run cannot double-charge, double-refund or double-deliver.

WHERE THE PROVIDER CALL SITS
----------------------------
Outside every transaction, deliberately -- ``AtomicMiddleware`` is not in play
on a worker, but the lesson from  is: minutes of third-party network I/O
inside a transaction pins a Cloud SQL connection ``idle in transaction`` for
the whole generation. The only transaction here is the delivery write, which
is local and short.

REFUND, NOT PARTIAL DELIVERY
----------------------------
A provider failure, an unusable answer, an article that was edited or published
from under the job -- all of them write nothing. A half-translated article
stored under the creator's name is worse than no translation, and a phantom
charge is worse than both.

A COMPLETE translation that missed a preservation rule is not half-translated,
and is delivered: the draft is written, the record ends ``delivered``
and carries ``warnings: [{code, detail, items}]`` naming what to check. Which
``safety`` violations are warnings and which still fail the job is
``settlement.DELIVER_WITH_WARNING_CODES``; billing for a warned delivery is
``settlement.CHARGE_DELIVERED_WITH_WARNINGS_IN_FULL``. A job that does fail on
its OUTPUT keeps a bounded copy of that output on the record -- for operators,
and for the creator only where it cannot be the product
(``settlement.SHOW_ATTEMPTED_OUTPUT_CODES``).

WHO PAYS FOR THE FAILURE
--------------------------------
"Refund in full" used to be unconditional, which made a failed translation free
to the buyer while the provider had already billed us for every output token it
generated -- $0.4447 of measured provider spend against $0.0000 of revenue on a
100,000-character zPage, with nothing in the code bounding how often it could be
repeated. (Realised loss so far is small: six refunds, ~$0.60, in fourteen days
of production. The missing bound is the defect, not the bill.) So every failure
now goes through ``settlement.classify`` and ``charges.settle_failure`` instead:

* our defect, or the provider's -- which is nearly everything, including every
  truncation caused by the tokenizer mismatch and envelope echo of  -- is
  still a FULL refund, however often it happens;
* the one attributable class (the buyer mutating the article under a job they
  had already paid for, repeatedly) settles at metered cost, never above the
  quote, and never above what the provider actually did;
* a failure before any generation settles at zero by arithmetic, because the
  meter is empty.

The meter is bound around the provider call and only around it, so the number
we settle against is what this run really spent -- including the attempts whose
answers were thrown away. Fragments that DID come back whole are carried on the
charge record, so a retry of the same document does not pay for them twice.
"""
import logging

from django.db import DatabaseError, transaction
from django.utils import timezone

from procrastinate import RetryStrategy
from procrastinate.contrib.django import app

from django.conf import settings

logger = logging.getLogger(__name__)


# A retry here is NOT the refund mechanism -- the task refunds inline for every
# failure it can observe. This exists for the failures it cannot: the pod dying
# mid-run, the database going away. Bounded at 3 so a genuinely broken job
# reaches status='failed' and the job-health alert fires, instead of retrying
# forever and never being visible (see dj/apps/g12f/tasks.py's note on the same
# choice). Anything this cannot repair is repaired by the reaper below.
#
# The one failure the task RAISES on purpose is `DeliveryContended`: a
# bounded delivery transaction that could not get its lock. Nothing was
# written and the charge is still `queued`, so a retry is exactly right.
TRANSLATE_RETRY = RetryStrategy(max_attempts=3, linear_wait=30)

#Cron for the abandoned-charge sweep. Every ten minutes: the deadline it
#enforces is 90 minutes, so the sweep's own period is noise against it, and a
#tighter cron only means a creator hears "refunded" sooner.
REAP_CRON = getattr(
    settings, "ZPAGE_TRANSLATION_REAP_CRON", "*/10 * * * *"
)


class _AlreadySettled(Exception):
    """The charge was settled by someone else while we were translating.

    Nothing to refund and nothing to deliver: another run, or the reaper, owns
    this charge now.
    """


class DeliveryContended(Exception):
    """The delivery transaction timed out waiting for a lock.

    Raised OUT of the task on purpose, so Procrastinate retries it: the charge
    is still ``queued`` and nothing was written. See ``TRANSLATE_RETRY``.
    """


class _Abort(Exception):
    """A delivery precondition failed. Roll back, then refund in full.

    Raised only from inside the delivery transaction, where the article and
    the target variant are re-read under lock. Everything checked before the
    provider call is checked AGAIN here, because minutes of network I/O
    separate the two and a creator can edit their article in that window --
    the codex adversarial review's riskiest line.
    """

    def __init__(self, code, detail, state_digest=None):
        self.code = code
        self.detail = detail
        # For delivery conflicts this is copied from the rows already read
        # under lock. Re-reading after rollback could see a later autosave and
        # mistake it for the state that caused this abort.
        self.state_digest = state_digest
        # When the conflict was SEEN, under the delivery lock. Actor evidence
        # is bounded by this, not by when `give_up` gets round to it: once the
        # transaction rolls back the lock is gone, and a buyer save landing in
        # that gap must not become the cause of a conflict someone else's
        # write produced. (Adversarial review of.)
        self.observed_at = timezone.now()
        super().__init__(f"{code}: {detail}")


@app.task(
    name="g12f.translate_zpage", queue="translation", retry=TRANSLATE_RETRY,
)
def translate_zpage(job_id: str):
    """Translate one zPage into one language and store it as a DRAFT.

    ``job_id`` addresses the charge record, which carries everything else --
    the article, the language, the model, the digest of the source content that
    was quoted, and the amount to refund if this goes wrong.
    """
    from dj.apps.openai.models import AIModel
    from dj.apps.g12f.models import zPage, ZPageTranslation, ZPageVariant
    from dj.apps.g12f.serializers.zpage import (
        MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE,
        draft_translation_variant_count,
    )
    from dj.apps.g12f.variants import (
        content_digest, dual_write_enabled, occupied_translation,
        translation_digest,
    )
    from dj.apps.g12f.translation import charges, safety, service, settlement

    record = charges.record_for_job(job_id)
    if record is None:
        logger.error(
            "translate_zpage: no charge record for job %s -- nothing to do "
            "and nothing to refund", job_id,
        )
        return False

    body = record.response_body if isinstance(record.response_body, dict) else {}
    if body.get("status") != charges.QUEUED:
        logger.info(
            "translate_zpage: job %s already %s -- no-op",
            job_id, body.get("status"),
        )
        return False

    # The meter for THIS run. Created before the first `give_up` can fire so
    # there is never a failure path with no accounting attached; empty until the
    # provider layer records something into it, and an empty meter settles at
    # zero however the failure is classified.
    meter = settlement.SpendMeter()
    # The model the spend is priced against, filled in once it is resolved
    # below. `None` for the failures that happen before that, which are also
    # the failures that cost nothing -- unless a contended attempt already
    # spent, below.
    priced = {"model": None}
    # A previous attempt at THIS charge that lost a lock race at delivery
    #  already spent real provider money; the retry's accounting starts
    # from there, or a failure on the retry would settle as if nothing had been
    # generated. See `charges.stash_contended_run`.
    contended = body.get("_contended_spend")
    # What the earlier contended attempts spent, kept apart from the meter so
    # a SUCCESSFUL delivery's `actual_cost` can count it too (codex review of
    #, round 7): the retry recalls the stashed fragments at no provider
    # cost, so `result`'s token counts alone would record a contended
    # delivery as nearly free.
    contended_in = contended_out = 0
    if isinstance(contended, dict):
        meter.calls = int(contended.get("calls") or 0)
        meter.input_tokens = contended_in = int(
            contended.get("input_tokens") or 0
        )
        meter.output_tokens = contended_out = int(
            contended.get("output_tokens") or 0
        )
        # Priced against the row it was quoted on, resolved NOW rather than
        # after the early checks: an article deleted (or a model disabled)
        # during the retry delay must still settle against that spend (codex
        # review of, round 6). Pricing reads the row's prices only;
        # whether it is still enabled is the `model_unavailable` check's job.
        priced["model"] = AIModel.objects.filter(
            pk=body.get("ai_model_id")
        ).first()

    def requester_caused(code, observed_at, state_digest=None):
        """Return only actor findings backed by a durable write-boundary row."""
        if not settlement.is_requester_action(code):
            return None
        # ACTOR FIRST, for every attributable code. `PageAdmin` lets staff edit
        # a creator's article and `ZPageTranslationAdmin` lets them edit and
        # publish its translations, so a staff correction landing inside the
        # generation window produces exactly these codes with the buyer named as
        # the cause. `language_source` is no defence either -- a staff relabel
        # through the admin is stored as `creator`. (codex adversarial review of
        # the  review fixes.)
        if charges.someone_else_edited_via_admin(
            body.get("zpage_id"), record.user_id, actor_window_started,
            observed_at,
        ):
            logger.warning(
                "translate_zpage: job %s failed with %s after a non-creator "
                "admin edit -- not attributing it to the buyer",
                job_id, code,
            )
            return False
        from dj.apps.g12f.translation.actors import (
            authenticated_actor_caused,
            observed_state_digest,
        )

        if state_digest is None:
            state_digest = observed_state_digest(
                code=code,
                zpage_id=body.get("zpage_id"),
                language=body.get("language"),
            )

        if authenticated_actor_caused(
            code=code,
            zpage_id=body.get("zpage_id"),
            actor_id=record.user_id,
            language=body.get("language"),
            after=actor_window_started,
            before=observed_at,
            state_digest=state_digest,
        ):
            return True
        if code not in settlement.NEEDS_REQUESTER_EVIDENCE:
            # A new requester-action code is never chargeable by default.
            return None
        return None

    def give_up(
        code, detail, attempted_output=None, observed_at=None,
        state_digest=None,
    ):
        """Settle this charge as a failure, attributing the cost.

        ``attempted_output`` is passed ONLY where the generated text itself is
        what failed -- the provider layer and the safety checks -- so a bounded
        copy of it is kept on the record. Never from a delivery-time
        ``_Abort``: there the output was fine. Who may SEE the copy is
        ``settlement.SHOW_ATTEMPTED_OUTPUT_CODES``.

        The fault decision is made HERE, from the code the failure reports, from
        who caused the state it reports, and -- only once the buyer is
        established as the cause -- from how often they have already done it in
        the window. Everything else, including every truncation caused by our own
        output cap, is a full refund.

        The task then RETURNS, so Procrastinate records the job as succeeded
        and the terminal-failure alert never counts it. What makes the failure
        visible instead  is ``charges.settle_failure``'s
        ``translation_refunded`` line and the job-health sweep reading the
        charge rows (``charges.recent_refunds``), which alerts as
        ``translation_refunds``. Do not "fix" the invisibility by raising here:
        a retry would find the charge already settled and succeed as a no-op.
        """
        # Bound evidence to the moment this state was first observed. A later
        # edit racing settlement cannot become the cause retroactively.
        observed_at = observed_at or timezone.now()
        caused = requester_caused(code, observed_at, state_digest)
        fault = settlement.classify(
            code,
            requester_caused=caused,
            prior_mutations=(
                # Scoped to THIS ARTICLE, because that is what the purchase
                # screen says: "unless you keep changing this article, or
                # changing or publishing its translation". Account-wide, one
                # mutation each on three different articles in an hour would
                # bill the third -- a creator who never repeated anything, told
                # otherwise on the screen they consented from, and sending
                # policy version 1 as confirmation of the narrower terms.
                # (codex adversarial review of the  review fixes.)
                #
                # The anti-abuse bound does not rest on this counter anyway: the
                # per-account failed-spend ceiling is account-wide and is what
                # stops someone cycling articles.
                charges.requester_action_failures(
                    record.user, zpage_id=body.get("zpage_id")
                )
                if settlement.is_requester_action(code) and caused is not False
                else 0
            ),
        )
        try:
            charges.settle_failure(
                record.pk,
                code=code,
                detail=detail,
                fault=fault,
                meter=meter,
                ai_model=priced["model"],
                # The finding of fact, stored so it -- and not the error code
                # -- drives the forgiveness allowance next time.
                requester_caused=caused,
                attempted_output=attempted_output,
            )
        except DatabaseError as exc:
            if not charges.is_contention(exc):
                raise
            # The bounded settlement lost a lock race: nothing was
            # credited and the charge is still `queued`. Keep what this run
            # spent -- and the fragments it paid for -- so the Procrastinate
            # retry settles against the real spend instead of re-buying the
            # document with an empty meter (codex review of, round 5).
            stashed = charges.stash_contended_run(record.pk, meter)
            logger.warning(
                "translate_zpage: job %s could not settle %s (%s); retrying "
                "(spend stashed: %s)", job_id, code, exc, stashed,
            )
            raise
        return False

    # Taken BEFORE the source is read, so an edit this job later fails on can
    # only have happened after it (see `charges.mark_started`).
    read_at = timezone.now()
    actor_window_started = (
        charges._parse_settled_at(body.get("started_at")) or read_at
    )
    page = zPage.objects.filter(pk=body.get("zpage_id")).first()
    if page is None:
        return give_up("zpage_gone", "the article no longer exists")
    if page.creator_id != record.user_id:
        # Ownership was checked at purchase. If it has changed hands since,
        # translating it would write another creator's content on this
        # creator's coin.
        return give_up("not_owner", "the article changed owner")

    language = body.get("language")
    ai_model = AIModel.objects.filter(pk=body.get("ai_model_id")).first()
    if ai_model is None or not service.is_callable_model(ai_model):
        return give_up(
            "model_unavailable",
            "the model this translation was quoted against cannot be called",
        )
    # Availability is re-read HERE, not inherited from purchase time.
    # The row is loaded fresh on every job run, so a model flagged off between
    # the sale and the worker picking the job up stops the job and refunds the
    # creator, rather than shipping the whole article to a vendor whose terms
    # we withdrew from in the meantime. `select_translation_model` already
    # refuses to *quote* against a disabled row; this is the queue-latency
    # half of the same rule.
    #
    # Residual window, accepted: a flip that lands DURING `translate_document`
    # is not seen until the next job, because re-reading the row per fragment
    # would be a database round trip per provider call inside the hot loop.
    # Bounded by one document's budget, and the flag is a policy decision with
    # days of lead time, not a live incident control.
    if not ai_model.is_enabled:
        return give_up(
            "model_unavailable",
            "the model this translation was quoted against is no longer "
            "available on Free2Z",
        )

    # A translation this job writes reaches readers only through the variant
    # table, and it gets there only via the M3 dual-write mirror. With the
    # mirror off -- an operational kill switch that, since, only takes
    # effect while `ZPAGE_VARIANT_READS` is off, because `dual_write_enabled()`
    # ignores it whenever readers resolve out of the variant table --
    # `live.save()` writes a legacy row nobody reads and the `ZPageVariant`
    # update below matches nothing. The charge would still settle as
    # `delivered`: paid for, and invisible. Refunding instead costs a creator
    # a retry and costs us nothing. (codex adversarial review.)
    #
    # NOT conditioned on `variant_reads_enabled()` any more. With reads
    # off the translation is still *legible* -- the legacy row renders -- but
    # the variant it should have authored is absent, so the row a reader gets
    # after the next flip carries no `origin='ai'` and no `source_digest`. The
    # reconciler will eventually mint it from the legacy shape as
    # `origin='human'`, which is the correct thing for a reconciler to do and
    # permanently mislabels a machine translation the creator paid for. This
    # check is only the cheap half of the fix: it saves a provider call. The
    # half that actually holds the money invariant is the row-count assertion
    # in the delivery transaction below, because the switch can flip during the
    # minutes of provider I/O that separate the two.
    if not dual_write_enabled():
        logger.error(
            "translate_zpage: refusing to deliver job %s -- the variant "
            "dual-write mirror is off, so this translation could not be "
            "written as the AI variant it is",
            job_id,
        )
        return give_up(
            "mirror_disabled",
            "translations cannot be delivered right now; nothing was kept "
            "and the full amount has been returned",
        )

    if content_digest(page.content) != body.get("source_digest"):
        # Quoted against text that no longer exists. Translating what is there
        # now would bill a price computed for something else, in either
        # direction. Refund and let the creator re-quote.
        return give_up(
            "source_changed",
            "the article was edited after the translation was purchased",
        )

    # BOTH shapes. A published variant with no legacy mirror is live content
    # since reads flipped, and asking only `ZPageTranslation` about it reports
    # "this language is free" -- after which the write below would overwrite
    # and unpublish it. See `variants.occupied_translation`.
    occupant = occupied_translation(page.pk, language)
    if occupant is not None and occupant[0]:
        return give_up(
            "variant_published",
            "a published translation for this language appeared after "
            "purchase; machine output never overwrites live content",
        )

    # THE SAME TWO CHECKS THE DELIVERY TRANSACTION MAKES, MADE EARLY.
    #
    # Both were only ever checked under the delivery lock, which was correct
    # when every failure refunded in full: the cost of finding out late was one
    # provider call we ate. It is no longer only ours to eat. A creator who
    # relabels the article into the target language, or edits the draft in it,
    # between the purchase and the worker picking the job up would have had us
    # translate a whole document that was ALREADY undeliverable when the job
    # started, and then -- past the forgiveness allowance -- be charged for it.
    # Money must never be taken for work that was avoidable at the point we
    # chose to do it. (codex adversarial review of, round 4.)
    #
    # The locked re-checks at delivery stay exactly as they are: these two are
    # a cheap early-out over a snapshot, not a substitute for a check that has
    # to exclude a concurrent writer.
    if page.source_language == language:
        return give_up(
            "same_language",
            "the article was relabelled into the target language before the "
            "translation started",
        )
    if occupant is not None and occupant[2] != body.get("target_digest"):
        return give_up(
            "variant_changed",
            "the draft in this language changed after the purchase and before "
            "the translation started; delivering would overwrite the "
            "creator's own edits",
        )

    # A batch can be purchased while no recent failures exist, then several
    # queued jobs can each reach this point after earlier members have burned
    # provider spend. Recheck the same rolling ceilings as the purchase path
    # before any provider work; refused queued jobs are settled as full refunds.
    # Keep the checks in the same order as the purchase path so the creator's
    # cooldown takes precedence when both limits have been reached.
    priced["model"] = ai_model

    def failure_ceiling_reached():
        """Why the failed-spend ceilings refuse more provider work, or None."""
        now = timezone.now()
        per_user_ceiling = charges.max_failed_spend_per_user()
        if per_user_ceiling > 0:
            _, failed_spend = charges.failed_spend(user=record.user, now=now)
            if failed_spend >= per_user_ceiling:
                return (
                    "the creator's recent failed translations reached the "
                    "provider spend ceiling "
                    f"({failed_spend} of {per_user_ceiling} 2Z)"
                )
        platform_ceiling = charges.max_failed_spend_platform()
        if platform_ceiling > 0:
            _, failed_spend = charges.failed_spend(now=now)
            if failed_spend >= platform_ceiling:
                return (
                    "recent failed translations reached the platform provider "
                    f"spend ceiling ({failed_spend} of {platform_ceiling} 2Z)"
                )
        return None

    def refuse_new_generation():
        detail = failure_ceiling_reached()
        if detail:
            raise service.TranslationFailed("failure_cooldown", detail)

    if meter.billable:
        # A retry that ALREADY SPENT (`_contended_spend`, ). Refusing it
        # here would throw away a document that may be fully paid for -- a
        # delivery that lost a lock race replays its stash at no provider
        # cost -- and add that spend to the very total that refused it. So
        # ask at the first NEW provider call instead: a complete replay never
        # gets there, and a partial one still stops before buying more.
        # (Review of, and its codex round.)
        meter.generation_gate = refuse_new_generation
    else:
        refusal = failure_ceiling_reached()
        if refusal:
            return give_up("failure_cooldown", refusal)

    source_text = "\n\n".join(
        part for part in (page.title, page.description, page.content) if part
    )

    # From here on a failure can cost real provider money; the spend is
    # priced against this model (`priced["model"]`, set above).
    # Fragments an EARLIER attempt at this exact document already paid for
    # . Same article body, same language, same model -- the
    # digest in the key is what guarantees "same question", so a stale or
    # mismatched entry simply cannot be found rather than having to be
    # invalidated.
    carried = charges.carried_fragments(
        record.user,
        page.pk,
        language,
        body.get("source_digest"),
        ai_model.pk,
        own_record_pk=record.pk,
    )
    if carried:
        logger.info(
            "translate_zpage: job %s reusing %d already-paid-for fragment(s)",
            job_id, len(carried),
        )

    # When this job began work on the checked source: the start of the
    # window in which an edit can abort it. See `charges.mark_started`.
    charges.mark_started(record.pk, started_at=read_at)

    try:
        # The meter is bound around the provider work and NOTHING else, so what
        # it holds afterwards is exactly what this run spent.
        with settlement.metered(meter, carried=carried):
            result = service.translate_document(
                title=page.title,
                description=page.description,
                content=page.content,
                source_language=page.source_language,
                target_language=language,
                ai_model=ai_model,
            )
    except service.TranslationFailed as exc:
        return give_up(
            exc.code, str(exc),
            attempted_output=getattr(exc, "attempted", None),
        )
    except Exception as exc:
        # Belt and braces: no exception from the provider layer may leave a
        # charge sitting queued while this task exits.
        logger.exception("translate_zpage: unexpected provider failure")
        return give_up("provider_error", f"{type(exc).__name__}: {exc}")

    translated_text = "\n\n".join(
        part for part in
        (result.title, result.description, result.content) if part
    )
    # The same document with the title and description as the MODEL wrote
    # them. `safety` asks its "did this survive the translation" questions of
    # this one and its "was this introduced" questions of the stored one:
    # `service._fit` cuts a title at 128 characters, and a brand name or a
    # code identifier that our own truncation removed is not a model that
    # dropped it. See `safety.check_translation`.
    untrimmed_text = "\n\n".join(
        part for part in
        (result.raw_title, result.raw_description, result.content) if part
    )
    #
    # BEST EFFORT. Every violation is collected, and the settlement
    # policy decides which ones still fail the job; the rest are delivered as
    # `warnings` on the charge record, because the output is an unpublished
    # draft its creator reviews and a nearly-right translation is worth more to
    # them than a refund is. See `settlement.DELIVER_WITH_WARNING_CODES`.
    violations = safety.find_violations(
        source_text,
        translated_text,
        untrimmed=untrimmed_text,
        source_language=page.source_language,
        target_language=language,
    )
    fatal = [
        violation for violation in violations
        if not settlement.delivers_with_warning(violation.code)
    ]
    if fatal:
        logger.error(
            "translate_zpage: refusing unsafe output for job %s (%s): %s",
            job_id, fatal[0].code, fatal[0],
        )
        return give_up(
            fatal[0].code, str(fatal[0]), attempted_output=translated_text,
        )
    warnings = charges.warning_entries(violations)

    # WHAT THIS COMPARISON IS, because it was misread once and the misreading
    # reached a PR body. It is 2Z of COST against 2Z of REVENUE, not one
    # token count against another. `quoted` is what the creator paid -- a fact in
    # 2Z, whatever estimate produced it. `actual_cost` is only a COST if its
    # token counts are the ones the provider metered.
    #
    # They were not, until: both of `result`'s counts came from
    # `count_tokens` / `count_message_tokens`, which are `cl100k_base` for every
    # model on the platform, while gpt-4o bills in `o200k_base`. So the cost side
    # read high by the cl100k/o200k spread of the TARGET language. The prod line
    # that started this -- "job 9d722f99 settled under its cost (quoted 8 2Z,
    # actual 10 2Z, in=6751 out=8228, model=openai/gpt-4o)", a zh-Hans delivery
    # -- re-prices to 7 2Z, i.e. it was at or UNDER its quote and the warning was
    # a FALSE POSITIVE. 's PR body read the same line as "25% over" and drew
    # "~1.5 is the honest output ratio" from it. That figure came out of this
    # instrument while it was biased and is withdrawn; 's per-script
    # `output_token_ratio` is the measured answer that replaced it.
    #
    # Both sides are now in the provider's own encoding -- `translate_unit`
    # reports `provider_message_tokens` / `provider_tokens`, and since
    # `quote_document` counts its prompt the same way. So the warning below is
    # finally comparing two numbers that mean what they say.
    actual_cost = service.translation_price(
        ai_model,
        result.input_tokens + contended_in,
        result.output_tokens + contended_out,
    )
    quoted = int(body.get("price") or 0)
    if actual_cost > quoted:
        # We bill the quote and absorb the difference ( §6.2). Visible in
        # the logs so a systematically wrong OUTPUT_TOKEN_RATIO shows up as a
        # trend rather than as a slow margin leak.
        logger.warning(
            "translate_zpage: job %s settled under its cost (quoted %s 2Z, "
            "actual %s 2Z, in=%d out=%d, model=%s/%s)",
            job_id, quoted, actual_cost, result.input_tokens + contended_in,
            result.output_tokens + contended_out, ai_model.provider,
            ai_model.model,
        )

    try:
        with transaction.atomic():
            # BOUNDED: the lock below must not wait out a 600-second
            # API request holding this zPage, pinning one of the two pooled
            # connections this queue shares with the ledger worker. See
            # `charges.DEFAULT_WORKER_LOCK_TIMEOUT_MS` for the numbers, and the
            # `DatabaseError` branch below for what a timeout does.
            charges.bound_worker_transaction()
            # EVERY precondition is re-checked here, under lock, because the
            # ones above were evaluated before minutes of provider I/O. The
            # creator can edit the article, relabel its language, publish a
            # translation or work on their own draft in that window, and each
            # of those makes this delivery wrong in a different way.
            fresh = (
                zPage.objects.select_for_update().filter(pk=page.pk).first()
            )
            if fresh is None:
                raise _Abort(
                    "zpage_gone", "the article was deleted while translating",
                    state_digest="",
                )
            if content_digest(fresh.content) != body.get("source_digest"):
                raise _Abort(
                    "source_changed",
                    "the article was edited while the translation ran, so "
                    "this is a translation of text that no longer exists",
                    state_digest=content_digest(fresh.content),
                )
            if fresh.source_language == language:
                # Relabelled INTO the target language mid-flight. Writing a
                # translation now would collide with the source variant, which
                # the dual-write mirror refuses -- leaving the legacy and
                # variant shapes disagreeing about a page we just charged for.
                raise _Abort(
                    "same_language",
                    "the article was relabelled into the target language "
                    "while the translation ran",
                    state_digest=fresh.source_language or "",
                )

            # The row this job will WRITE is the legacy one -- dual-write
            # mirrors it -- but the row it must not DESTROY may only exist in
            # the variant table. `occupied_translation` locks and reports
            # whichever shapes are there; `live` is separately the legacy row
            # to mutate, which is `None` for a variant-only occupant.
            occupant = occupied_translation(page.pk, language, lock=True)
            live = (
                ZPageTranslation.objects.filter(zpage=page, language=language)
                .first()
            )
            if occupant is not None and occupant[0]:
                raise _Abort(
                    "variant_published",
                    "a translation for this language was published while the "
                    "job ran; machine output never overwrites live content",
                    state_digest=occupant[2],
                )
            if occupant is not None and occupant[2] != body.get(
                "target_digest"
            ):
                # The creator has been editing (or has just created) the draft
                # in this language since they bought. Overwriting it would
                # destroy work they cannot get back, and no amount of refund
                # buys it back either.
                raise _Abort(
                    "variant_changed",
                    "the draft in this language changed after the purchase; "
                    "delivering would overwrite the creator's own edits",
                    state_digest=occupant[2],
                )

            if (
                occupant is None
                and draft_translation_variant_count(fresh)
                >= MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE
            ):
                raise _Abort(
                    "draft_variant_limit",
                    "the draft translation limit was reached while translating",
                )

            if live is None:
                live = ZPageTranslation(zpage=page, language=language)
            live.title = result.title
            live.description = result.description
            live.content = result.content
            # NEVER auto-published ( §6.4). A machine translation is a
            # draft its creator reviews; this is the line that says so.
            live.is_published = False
            live.save()

            # THE MONEY INVARIANT. A settled charge must mean the row
            # the creator paid for exists, holds the text they paid for, and
            # says what it is.
            #
            # This writes the whole payload -- not just the provenance -- and
            # that is the correction, not a tidy-up. `sync_translation_variant`
            # (the M3 dual-write signal) normally mirrors the `live.save()`
            # above and then this only relabels it. But the signal is a no-op
            # while `ZPAGE_VARIANT_DUAL_WRITE` is off -- which, since,
            # means while it is off AND `ZPAGE_VARIANT_READS` is off, because
            # `dual_write_enabled()` ignores the switch entirely whenever
            # readers resolve out of the variant table -- and that switch
            # exists to be thrown mid-incident, in the middle of the minutes of
            # provider I/O that separate the pre-flight check from here. So
            # this window is the documented reads-off rollback state, which is
            # exactly where `test_the_kill_switch_thrown_mid_job_refunds_
            # instead_of_settling` now stages it. Relabelling
            # alone in that window is the worst of the outcomes: a PRE-EXISTING
            # draft variant at this language still matches the filter, so the
            # row count says 1, the charge settles, and the creator is billed
            # for a translation while still looking at their old draft -- now
            # wearing `origin='ai'` and the new digest, so the reconciler reads
            # it as a valid delivery too. (codex adversarial review.)
            #
            # `is_published=False` is written explicitly for the same reason:
            # a machine translation is NEVER auto-published ( §6.4), and
            # inheriting whatever the row happened to say is not that promise.
            # `updated_at` too, because `.update()` bypasses `auto_now` -- same
            # reason `variants.publish_source_variant` sets it by hand.
            stamped = ZPageVariant.objects.filter(
                zpage=page, language=language
            ).exclude(origin=ZPageVariant.SOURCE).update(
                title=result.title,
                description=result.description,
                content=result.content,
                is_published=False,
                origin=ZPageVariant.AI,
                ai_model=ai_model,
                # The digest of the source text this was translated FROM, so
                # staleness is exact from the moment it is written --
                # notes nothing set this until now.
                source_digest=body.get("source_digest"),
                updated_at=timezone.now(),
            )

            # A queryset `.update()` does not raise on an empty match, so
            # without this line every way of ending up with no row to write
            # settles the charge anyway:
            #
            #   * the dual-write kill switch flipped OFF after the pre-flight
            #     (reads-off rollback state only, since ), with no variant
            #     already at this language;
            #   * `sync_translation_variant` declining to mirror (it returns
            #     `None` when a source variant already holds this language);
            #   * any future signal change that stops the mirror firing here.
            #
            # The damage is silent and permanent rather than loud: the
            # translation lands as `origin='human'` with no digest, `staleness()`
            # answers `None` forever, and `reconcile_zpage_variants
            # --fail-on-drift` exits 0 over it because every AI invariant is
            # keyed on the stored `origin`, which now says human. Refund
            # instead -- the creator gets their 2Z back and can retry, and we
            # eat one provider call.
            #
            # Deliberately NOT an upsert: creating the row here would be the
            # mirror write the kill switch is meant to stop. Overwriting a row
            # that already exists is not -- the mirror would have written those
            # same bytes a statement earlier had it been on.
            #
            # `!= 1`, not `== 0`: `uniq_zpage_variant_language` makes two
            # non-source rows at one (zpage, language) impossible, so a count
            # above one means the constraint is gone and nothing here should be
            # settling money against it.
            if stamped != 1:
                raise _Abort(
                    "provenance_unwritten",
                    "the translation could not be recorded as machine output, "
                    "so nothing was kept and the full amount has been returned",
                )

            if charges.mark_delivered(
                record.pk,
                actual_cost=actual_cost,
                warnings=warnings,
                draft_digest=translation_digest(result),
            ) is None:
                raise _AlreadySettled("charge_settled_elsewhere")
    except _Abort as exc:
        # Rolled back: nothing written. The creator paid for a translation
        # that is no longer the right thing to deliver, so they get all of it
        # back and we eat the provider call.
        logger.warning(
            "translate_zpage: job %s aborted at delivery (%s)", job_id, exc
        )
        return give_up(
            exc.code, exc.detail, observed_at=exc.observed_at,
            state_digest=exc.state_digest,
        )
    except _AlreadySettled as exc:
        # Rolled back: no variant, no delivery. The charge is already
        # refunded (or delivered by a concurrent run), so there is nothing to
        # settle -- we have spent one provider call and that is the whole cost.
        logger.warning(
            "translate_zpage: job %s not delivered (%s)", job_id, exc
        )
        return False
    except DatabaseError as exc:
        if not charges.is_contention(exc):
            raise
        # Rolled back: nothing written, and the charge is still `queued`. A
        # lock we could not get is somebody else's transaction, not a defect
        # of this translation, so it is NEITHER delivered NOR refunded: the
        # job is RETRIED (TRANSLATE_RETRY), and the fragments this run paid
        # for -- and what they cost -- are stashed on the record so the retry
        # recalls them instead of paying the provider again, and settles
        # against the real spend if it fails. If every attempt loses, the reaper's
        # deadline is the backstop, exactly as for a job that never ran.
        stashed = charges.stash_contended_run(record.pk, meter)
        logger.warning(
            "translate_zpage: job %s lost a lock race at delivery (%s); "
            "nothing written, retrying (fragments stashed: %s)",
            job_id, exc, stashed,
        )
        raise DeliveryContended(job_id) from exc

    logger.info(
        "translate_zpage: delivered job %s (zpage=%s %s->%s, %s 2Z, model=%s)",
        job_id, page.pk, page.source_language, language, quoted,
        ai_model.display_name,
    )
    if warnings:
        # Not an incident -- the creator got their draft -- but a check that
        # fires on most deliveries is a check with a false positive, and this
        # line is how that shows up as a trend ( was one).
        logger.warning(
            "translate_zpage: job %s delivered with warnings %s",
            job_id, sorted({warning["code"] for warning in warnings}),
        )
    return True


@app.periodic(cron=REAP_CRON)
@app.task(
    name="g12f.reap_translation_charges", queue="billing",
)
def reap_translation_charges(timestamp: int):
    """Refund every translation charge whose job never arrived.

    The one failure the task above cannot handle itself, because it is the
    task not running: an evicted worker, or a rolling deploy in which the web
    pods know ``g12f.translate_zpage`` and the worker pods do not yet. Without
    this, that window is a charge with no delivery and no refund.

    QUEUE = ``billing``, NOT ``translation``. This is a refund sweep:
    every job it does anything at all for is 2Z debited from a creator with
    nothing delivered. It must not queue behind the very jobs whose failure it
    exists to clean up -- on ``translation`` it sat behind up to
    ``ZPAGE_TRANSLATION_MAX_QUEUED`` translations of MINUTES each, which is a
    large fraction of the 90-minute deadline it enforces. ``billing`` is the
    queue ``k8s/free2z/worker:billing_worker`` serves exclusively, so the sweep
    now runs on a lane whose only other occupant is ``renew_subscription``.

    Alerting is unchanged by the move: ``JOB_HEALTH_BILLING_QUEUES`` already
    lists BOTH ``billing`` and ``translation``, so this task's terminal-failure
    threshold was 1 and its overdue threshold 300s before, and still is.

    Jobs already deferred with ``queue_name='translation'`` when this ships are
    not orphaned -- the catch-all worker consumes every queue, so it drains
    them exactly as it does today.
    """
    from django.db import DatabaseError

    from dj.apps.g12f.translation import charges
    from dj.apps.g12f.translation.actors import prune_mutation_actors

    # Keep the refund sweep first and independent: a contended retention query
    # must not delay refunds or add another task to the shared default worker.
    reaped = charges.reap_abandoned()
    try:
        pruned = prune_mutation_actors()
    except DatabaseError:
        # The prune has strict local lock/statement timeouts and is best effort.
        # The next ten-minute reaper tick will try it again.
        logger.warning(
            "translation actors: retention prune skipped after database "
            "failure", exc_info=True,
        )
    else:
        if pruned:
            logger.info("translation actors: pruned %s expired rows", pruned)
    return reaped
