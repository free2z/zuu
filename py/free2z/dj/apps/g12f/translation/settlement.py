"""WHO PAYS when a paid AI translation fails.

THE PREMISE THAT WAS VOID
-------------------------
``views/translate.py`` used to justify having no rate limit like this:

    No rate limit and no eligibility gate beyond having the 2Z (owner
    decision, 2026-08-09: "they bought the 2Zs, they can spend them on
    translations"). The spend is self-limiting because it is real money [...]

"The spend is self-limiting because it is real money" is true of a *successful*
purchase and false of a refunded one. A refunded job costs the buyer exactly
zero, so the same 8 2Z recycle without limit -- while the provider has already
generated, and billed us for, every output token it produced before something
cut it off. ``service.OUTPUT_CEILING_RATIO``'s own docstring says so: *"a
provider bills a stream it generated even if the connection then dies and we
discard it."*

A SLOW LEAK WITH NO BOUND -- WHICH IS THE PART THAT MATTERS
-----------------------------------------------------------
Be honest about the magnitude, because an overstated threat is its own problem.
Fourteen days of production logs  hold **eight** paid translation
jobs, all on one article for one creator: two delivered, six refunded at 8 2Z
quoted and ~10 2Z of real provider cost each. So the realised loss is on the
order of **$0.60 in a fortnight**. Nobody was draining us.

What is missing is not money, it is a **bound**. Measured with the real
tokenizer and real prompts over ``docs/agent-operations.md`` truncated to the
100,000-character content ceiling (37 fragments, 29,066 prompt tokens, 20,051
quoted output tokens, a 28 2Z quote), a failure on the LAST fragment generates
to the per-fragment cap on all 37:

===========================================  ==================  ============
                                             provider spend      revenue
===========================================  ==================  ============
current ``OUTPUT_CEILING_RATIO = 2.0``       $0.4447  (1.63x)    $0.0000
after  (2.5, cap hit retried at 1.6x)   $0.5547  (2.03x)    $0.0000
===========================================  ==================  ============

(the multiple is against what the quoted translation itself costs us). And
nothing in the code limited how often that could be repeated: the concurrency
backpressure plus the 900-second document budget put one account's ceiling at
four such failures an hour -- **$1.78/hour, $43/day, free to the caller** --
while a short article engineered to fail on its first fragment costs cents and
finishes in seconds, bounded only by worker throughput and the generic
``user: 1200/minute`` DRF scope.

A leak we can measure in cents and cannot bound in dollars is still worth
fixing, and the fix is cheap. This module is the first half: a notion of
**cause**, so the answer to "who pays" stops being "always us, always, for
everything".

THE OWNER'S DIRECTIVE, AND THE LINE IT DOES NOT CROSS
-----------------------------------------------------
    "Charge them if openai charges us. THIS SHOULD NEVER FUCKING FAIL."

Both halves matter. Charging for provider-attributable spend is the directive.
Charging a creator for **our own defect** is not, and it is not shipped: a
mis-set cap, our timeout, our bug, a deploy that killed the worker -- all of
those refund in full, however many times they happen. The fault table below is
the place that decision is written down and reviewed, rather than being implied
by the absence of an ``if``.

WHAT IS AND IS NOT ATTRIBUTABLE TODAY -- READ THIS BEFORE EDITING THE TABLE
--------------------------------------------------------------------------
The tempting discriminator -- "was the generated output implausibly large?" --
**does not work while a cap is enforced**, and shipping it would have charged
creators for. ``service._output_cap`` bounds output at
``OUTPUT_CEILING_RATIO x`` the fragment, so content engineered to make the model
write an essay and an ordinary fragment that merely needed a little more room
both come back at *exactly the cap*. The volume we observe is the cap, not the
intent.

 is the case in point, and it is worth stating precisely, because the
first diagnosis of it was wrong in a way that would have mattered here. The
truncations were not a language being long: measured in the tokenizer the
provider actually meters in, no language Free2Z sells exceeds 1.98x, and clean
Spanish is 1.26x. Two of our own defects produced them -- ``count_tokens``
compares a reply in ``cl100k_base`` against a cap the provider enforces in
``o200k_base``, and the model was echoing back the ``<fragment>`` envelope we
wrapped its input in. Either way the article was blameless, which is why
``output_truncated`` is:data:`PLATFORM`: it is a statement about our own
arithmetic, never about the creator's text.

The potentially attributable class is a buyer changing the article they just
paid to translate. It costs us a whole document and nothing in the provider
layer can see it coming. But the failure code only proves that a row changed;
it does not prove who wrote it. Admin logs identify some staff form saves, but
their absence does not distinguish a creator's edit from a queryset update,
management command, shell or SQL write. So a case is billable only when an
authenticated write-boundary row (``ZPageMutationActor``) names the buyer for
that mutation, in that job's window, with the state the worker observed; every
other write resolves to:data:`PLATFORM` and is refunded. A repetition count
cannot turn an unknown actor into a buyer.

THE INVARIANT THAT MAKES ALL OF THIS SAFE
-----------------------------------------
**We never bill for provider work that did not happen, and never above the
quote.** The amount is ``min(metered_cost(what we actually spent), charged)``,
so:

* every failure BEFORE the provider call (the article vanished, the model was
  flagged off, the mirror is down) settles at zero and is a full refund by
  arithmetic, whatever the table says about it;
* a creator is never charged more than the number ``TranslateWithAiDialog``
  showed them -- that dialog's invariant is that no 2Z is committed from a
  screen that has not shown the figure, and charging *up to* it for work
  actually performed keeps it.

METERING IS A CONTEXTVAR, DELIBERATELY
--------------------------------------
:func:`metered` binds a:class:`SpendMeter` for the duration of one document
and ``service._complete`` reports every provider call into it -- including the
attempts whose answers we throw away, which are precisely the ones the old code
forgot we had paid for. It is a contextvar rather than a threaded parameter for
one reason: ``_complete`` is the single place a provider call happens, so
recording *there* means any future retry, re-split or recovery path ( owns
those) is metered without its author having to remember to pass anything.
A money meter that a new code path can silently skip is not a meter.

Nothing here writes to the database or moves 2Z -- ``charges.settle_failure``
does that, and it is the only caller that may.
"""
import contextvars
import hashlib
import logging
from dataclasses import dataclass, field
from datetime import timedelta

from django.conf import settings

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# The fault taxonomy
# --------------------------------------------------------------------------- #
#OUR defect: a mis-set cap, our timeout, our bug, a kill switch thrown
#mid-job, a deploy that killed the worker. ALWAYS a full refund. This is the
#value an unknown code resolves to, because a failure mode nobody has
#classified is a failure mode we do not understand, and the creator is not
#the right person to fund our ignorance.
PLATFORM = "platform"

#Nobody's fault: a provider outage, a 5xx, a model that returned nothing.
#Full refund; a cost of doing business. Kept distinct from
#:data:`PLATFORM` because the two want different alerts, not because they
#settle differently.
PROVIDER = "provider"

#Attributable to the request. Settles at metered cost, capped at the quote.
REQUEST = "request"

#An intermediate class, never stored: a proven buyer mutation of the target
#of a job they already paid for. Requires positive actor evidence and is
#resolved by:func:`classify` to:data:`PLATFORM` for the first
#:data:`FORGIVEN_MUTATIONS` in the window and:data:`REQUEST` after that.
REQUESTER_ACTION = "requester_action"

#Every failure code these routes can produce, and who pays for it.
#
#Adding a code here is a money decision. The default for anything absent is
#:data:`PLATFORM`, so forgetting to add one is safe in the direction that
#matters (we eat it) and shows up as the ``unclassified`` log line below.
FAULT_BY_CODE = {
    # -- our defect ------------------------------------------------------- #
    # /: our reply-token count and the provider's cap were in two
    # different tokenizers, and our own `<fragment>` envelope was being echoed
    # back into the reply. Both are ours. The creator's article is not what is
    # wrong here, and it stays PLATFORM even once  lands -- see the
    # docstring on why output volume cannot attribute a truncation at all while
    # a cap is what produced it.
    "output_truncated": PLATFORM,
    # Our own document budget ran out.
    "timeout": PLATFORM,
    # We quoted and sold a translation whose output cannot fit the column we
    # would store it in. The place to refuse that is the quote.
    "output_too_long": PLATFORM,
    # Our catalogue/flag state changed under a job we had already sold.
    "model_unavailable": PLATFORM,
    # Operational kill switches and the variant-provenance invariant.
    "mirror_disabled": PLATFORM,
    "provenance_unwritten": PLATFORM,
    # A limit we accepted the purchase against and then hit anyway. Reached by
    # the buyer creating draft translations in OTHER languages while this job
    # ran -- their action, but not a way to cancel this job, so it stays ours.
    # The asymmetry with `variant_published` below is deliberate.
    "draft_variant_limit": PLATFORM,
    # The job never ran at all -- an evicted worker, or a rolling deploy where
    # the web pods know the task and the worker pods do not yet. Ours by
    # definition, and `charges.reap_abandoned` never has a spend to meter.
    "abandoned": PLATFORM,
    # Rechecked by the worker after queueing: a purchase can be admitted
    # alongside a batch before any member has failed, then later jobs must
    # stop once earlier provider failures reach the same rolling spend cap.
    "failure_cooldown": PLATFORM,
    # NOTE: every `safety` code in this table -- the three identifier
    # invariants below and the four safety invariants further down -- is in
    # `DELIVER_WITH_WARNING_CODES` today, so it is delivered with a warning
    # and never reaches this table. The entries stay so that removing a code
    # from that set restores a fully specified failure, not an unclassified one.
    #
    # 's identifier invariants. A model that renamed a footnote id,
    # rewrote a code identifier or transliterated "2Z" disobeyed an explicit
    # prompt rule; the article did not ask it to, and the same reasoning that
    # makes `url_not_in_source` below PROVIDER applies -- except that these
    # three are also rules we only added a check for recently, so if one of
    # them turns out to fire on good translations the cost lands on us and not
    # on a creator until it is fixed.
    #. The prompt now names the script; a reply that ignored it is a
    # model disobeying an explicit instruction, but it is OUR instruction and
    # OUR check, and the creator's article never asked for it.
    "wrong_script": PLATFORM,
    "reference_not_in_source": PLATFORM,
    "code_identifier_not_preserved": PLATFORM,
    "brand_term_not_preserved": PLATFORM,
    # -- nobody's fault --------------------------------------------------- #
    "provider_error": PROVIDER,
    "empty_output": PROVIDER,
    # The safety invariants in `translation.safety`. A model that invented a
    # destination, a tag or a price is a model misbehaving. It can be *induced*
    # by content, but we cannot tell induced from spontaneous, and guessing
    # wrong bills a creator for a prompt-injection attempt aimed at them.
    #
    # Production is emphatic about which way to err: `markup_not_in_source` was
    # FOUR of the six refunds in fourteen days, and the introduced
    # "markup" was our own `<fragment>` envelope coming back in the reply. The
    # dominant real cause of a safety refusal so far has been OURS. The label
    # stays PROVIDER because a safety refusal is fundamentally "the model wrote
    # something we will not store" and it only steers alerting -- both values
    # settle identically, in full.
    "url_not_in_source": PROVIDER,
    "unsafe_url_scheme": PROVIDER,
    "markup_not_in_source": PROVIDER,
    "amount_not_in_source": PROVIDER,
    "zip321_amount_not_in_source": PROVIDER,
    "payment_math_not_verified": PROVIDER,
    "payment_scan_limit": PROVIDER,
    # -- never billed under the terms the buyer was shown ------------------ #
    # `ZPageMutationActor` now records an authenticated page delete, and the
    # row survives the cascade -- but evidence of WHO did it is not consent to
    # be charged for it. `METERED_POLICY_VERSION` 1 (the purchase dialog copy
    # and the `settlement_policy` help text in `serializers/translate.py`)
    # names exactly one non-refundable case: repeatedly CHANGING or PUBLISHING
    # the article or its translation while the job runs. Deleting the article
    # is not in it, and the API has no ownership-transfer endpoint at all
    # (`update` always saves `creator=request.user`). Billing either needs a
    # terms change: bump the policy version and the dialog copy together, as
    # that constant's docstring requires. Until then these are ours.
    # (Adversarial review of.)
    "zpage_gone": PLATFORM,
    "not_owner": PLATFORM,
    # -- the buyer moved the target after paying --------------------------- #
    # No background task currently rewrites `zPage.content`, but the digest
    # alone cannot identify whether a creator, staff member or direct database
    # write changed it. Keep it requester-action only with positive actor proof.
    "source_changed": REQUESTER_ACTION,
    # `charges.has_in_flight_for_target` excludes two live jobs for one
    # article+language, so our own concurrent delivery cannot create this
    # failure. The row still does not identify whether its writer was the buyer
    # or another actor, so positive actor evidence remains required.
    "variant_changed": REQUESTER_ACTION,
    # `page.source_language` is ALSO written by our own detector --
    # `g12f.tasks.apply_detection` relabels a zPage and sets
    # `language_source = 'detected'`. A relabel landing inside the generation
    # window produces this code with a full meter, and billing it would charge a
    # creator for our background job. So this one needs evidence: see
    #data:`NEEDS_REQUESTER_EVIDENCE`.
    "same_language": REQUESTER_ACTION,
    # Publishing the target language DURING generation. It may be a buyer
    # mutation, but the publication row alone does not identify its writer.
    # The pre-provider check of the same condition has no spend to meter.
    "variant_published": REQUESTER_ACTION,
}

#The settlement terms a purchase was made under, as declared BY THE CLIENT and
#recorded on the charge.
#
#A creator can only be charged against terms they were shown, and the terms
#live on a screen we do not control the lifetime of. An editor tab opened
#before this deploy still says "if it fails for any reason, every 2Z is
#credited straight back" and can still POST to the new backend, so stamping
#the server's own version at purchase time would charge that creator against a
#promise they were never shown. (codex adversarial review of, its
#riskiest line.)
#
#So the version travels WITH the purchase, exactly as ``expected_price`` and
#``source_digest`` do: it is the client saying which terms it displayed. A
#purchase that does not declare one is a legacy client and is settled under
#legacy terms -- a full refund, always, whatever the fault table says.
#
#Bump this only when the settlement TERMS change, and change the dialog copy
#in the same commit. It is not a schema version.
METERED_POLICY_VERSION = 1

#Mutations of one's own article, per failure window, that are forgiven
#entirely. The third is metered. Two, because one is a typo fixed mid-flight
#and a pattern needs more than one point.
DEFAULT_FORGIVEN_MUTATIONS = 2


def may_bill_under_policy(declared):
    """Whether a purchase declaring ``declared`` terms may be billed at all.

    ``None``, a missing value, junk, or anything below
    :data:`METERED_POLICY_VERSION` means the buyer was not shown these terms.
    Full refund, and the fault table does not get a vote.
    """
    try:
        return int(declared) >= METERED_POLICY_VERSION
    except (TypeError, ValueError):
        return False

#How far back:func:`classify` counts prior mutations, and how far back
#``charges.costly_failures`` counts spend. One window, one number, so a
#creator cannot be inside the cooldown for one purpose and outside it for
#the other.
DEFAULT_FAILURE_WINDOW = timedelta(hours=1)


def forgiven_mutations():
    return int(
        getattr(
            settings,
            "ZPAGE_TRANSLATION_FORGIVEN_MUTATIONS",
            DEFAULT_FORGIVEN_MUTATIONS,
        )
    )


def failure_window():
    configured = getattr(settings, "ZPAGE_TRANSLATION_FAILURE_WINDOW", None)
    if configured is None:
        return DEFAULT_FAILURE_WINDOW
    if isinstance(configured, timedelta):
        return configured
    return timedelta(seconds=float(configured))


#Mutation codes whose state we can also produce. The caller must establish
#who wrote the row before billing. The API records authenticated write-boundary
#events; ``language_source`` remains provenance only, and absence of a
#matching event never proves the buyer made an uninstrumented write.
NEEDS_REQUESTER_EVIDENCE = frozenset({
    "source_changed",
    "variant_changed",
    "variant_published",
    "same_language",
})


def classify(code, *, prior_mutations=0, requester_caused=None):
    """Who pays for a failure with this code. Returns a stored fault value.

    ``prior_mutations`` is how many times this buyer has already been
    ESTABLISHED as the cause of a:data:`REQUESTER_ACTION` failure inside
    :func:`failure_window`. It can only escalate a ``REQUESTER_ACTION`` -- it can
    NOT turn one of our own defects into a charge, which is the whole reason
    repetition is not applied globally.

    ``requester_caused`` is the caller's finding of fact for the codes in
    :data:`NEEDS_REQUESTER_EVIDENCE`:

    ``True``   a trusted write-boundary record names the buyer.
    ``False``  WE did it -- our detector, our job. Settles as:data:`PLATFORM`,
               however many times it happens.
    ``None``   nobody established it. Also:data:`PLATFORM`, and it logs, because
               an unestablished cause is not a chargeable one. That default is
               what makes adding a new code to the table safe.
    """
    fault = FAULT_BY_CODE.get(code)
    if fault is None:
        logger.error(
            "translation failure code %r is not in settlement.FAULT_BY_CODE "
            "-- treating it as our own defect and refunding in full", code,
        )
        return PLATFORM
    if fault is not REQUESTER_ACTION:
        return fault
    if requester_caused is False:
        logger.info(
            "translation failure %r was caused by us, not by the buyer -- "
            "refunding in full whatever the repetition count says", code,
        )
        return PLATFORM
    if requester_caused is None and code in NEEDS_REQUESTER_EVIDENCE:
        logger.error(
            "translation failure %r needs evidence of who caused it and none "
            "was supplied -- refunding in full", code,
        )
        return PLATFORM
    if prior_mutations < forgiven_mutations():
        return PLATFORM
    return REQUEST


def is_requester_action(code):
    """Whether this code is one the buyer could be held responsible for."""
    return FAULT_BY_CODE.get(code) is REQUESTER_ACTION


#Failures where the GENERATED TEXT ITSELF was what we rejected, so the
#fragments this run produced must never be carried forward or recalled.
#
#Two families, and both were found by the codex adversarial review of:
#
#* the SAFETY invariants. ``safety.check_translation`` runs on the ASSEMBLED
#document, so a rejection names the offence (an invented URL, a
#``<fragment>`` tag, a price that is not in the source) without naming the
#fragment that committed it. We cannot quarantine one fragment, so we
#distrust the set.
#* ``output_too_long``. The assembled translation did not fit the 100,000
#character column. Reusing the fragments guarantees the same verdict, so the
#only thing the cache can produce is the identical refusal.
#
#In both cases the carry-over would turn a transient bad generation into a
#permanent one: the creator pays, waits, is refunded and repeats, with the
#provider never given the chance to answer differently, for as many purchases
#as the cache survives. The review reproduced both with a single provider call
#across two attempts.
#
#Truncation is deliberately NOT in here: ``translate_unit`` remembers a
#fragment only after it has passed the truncation check, so the fragments a
#truncated document carries are whole and individually valid ones -- and the
#whole point of the carry-over is to stop paying twice for those.
UNTRUSTWORTHY_OUTPUT_CODES = frozenset({
    "url_not_in_source",
    "unsafe_url_scheme",
    "markup_not_in_source",
    "amount_not_in_source",
    "zip321_amount_not_in_source",
    "payment_math_not_verified",
    "payment_scan_limit",
    "output_too_long",
    # 's identifier invariants, here for exactly the same reason as the
    # four above: the fragments this run produced were REJECTED, so carrying
    # them forward hands the next purchase the same bad text, which fails the
    # same check without ever asking the provider again -- a bad generation
    # turned into a run of failed purchases with no way out but the lookup
    # window expiring. Found by the codex adversarial review, which noted that
    # adding a code to `FAULT_BY_CODE` and not to this set is silent in a way
    # the reverse is not.
    "reference_not_in_source",
    "code_identifier_not_preserved",
    "brand_term_not_preserved",
    #the reply is in the wrong alphabet. Carrying it forward would
    # hand the retry the same Latin text for a Cyrillic tag.
    "wrong_script",
})


def may_carry_fragments(code):
    """Whether a failure with this code may keep (or reuse) its fragments."""
    return code not in UNTRUSTWORTHY_OUTPUT_CODES


# --------------------------------------------------------------------------- #
# Best-effort delivery
# --------------------------------------------------------------------------- #
#``safety`` violations that are DELIVERED, as ``warnings`` on the charge
#record, instead of failing the job.
#
#WHY. A paid translation lands as an UNPUBLISHED DRAFT that its creator
#reviews before anything reaches a reader (``tasks.translate_zpage`` writes
#``is_published=False`` and nothing else publishes it). Refunding a whole
#document because a few spans differ costs us the full provider bill and gives
#the creator nothing -- zPage 4966 (job ``91feca9d``) threw away eleven
#provider calls and ~28k tokens over three Markdown emphasis examples, and
#'s ``amount_not_in_source`` refunded four out of four over locale
#number formatting. A draft with three things to check is worth more to the
#creator than no draft, and it is what they paid for.
#
#WHAT STILL FAILS THE JOB is output that is not a usable draft at all, and it
#never reaches this set because ``service.translate_document`` raises it
#before ``safety`` is asked anything: ``empty_output``, ``output_truncated``,
#``output_too_long``, ``wrong_script`` (the reply is not in the target
#language's alphabet), ``timeout`` and ``provider_error``. Those still refund
#as the fault table above says.
#
#``markup_not_in_source`` and ``unsafe_url_scheme`` are warnings because
#what they flag cannot reach a reader even if the draft is published as-is:
#the reader-side renderer escapes raw HTML and its sanitizer strips any
#destination whose scheme ``unsafe_url_scheme`` names.
#
#``url_not_in_source`` IS NOT IN THIS SET, deliberately, and it is the one
#departure from the  issue text (which lists links among the
#preservation checks). It is the prompt-injection defence the ``safety``
#docstring calls the one that matters, and an ``https://`` phishing link
#survives the sanitizer. Delivered as a warning, it is publishable by a
#creator who cannot read the target language -- and today the editor does
#not display ``warnings`` at all (codex adversarial review of this change,
#finding 1). **Add it here in the same change that makes the editor show
#warnings before publish** ( workstream D); until then it fails and
#refunds exactly as before.
#
#**Removing a code from this set restores the old behaviour for it
#exactly** -- fail, refund per ``FAULT_BY_CODE``, never carry its fragments
#-- which is why those tables still list every one.
#
#**Nor is a destination that appears "only inside code".** A
#``url_in_code_not_in_source`` warning was tried during  for zPage
#4966's translated placeholder address and removed in the same PR: telling
#code from a link needs a parser that agrees with the renderer, and a regex
#disagreed in seven ways that each delivered a RENDERED phishing link as a
#warning (see ``safety``'s module docstring). Security over convenience: a
#new destination anywhere fails the job.
DELIVER_WITH_WARNING_CODES = frozenset({
    "code_identifier_not_preserved",
    "reference_not_in_source",
    "brand_term_not_preserved",
    "amount_not_in_source",
    "markup_not_in_source",
    "unsafe_url_scheme",
})

#BILLING FOR A DELIVERY WITH WARNINGS: **charged normally, the full quote.**
#
#It is a real, editable deliverable -- the whole document, translated, in the
#creator's drafts -- and the warnings name the few spans to check. Nothing is
#credited back on delivery today, warned or not, so this is the absence of a
#refund rather than a new charge: the debit taken at purchase simply stands,
#exactly as it does for a clean delivery.
#
#TO CHANGE IT (e.g. "refund 25% when there are warnings"): credit the
#difference inside the delivery transaction in ``charges.mark_delivered``,
#the same way ``charges.settle_failure`` credits -- ``ledger.credit`` with an
#``idem`` named after the record -- and record it in ``refunded``. Flip this
#constant, change the dialog copy that states the terms, and bump
#:data:`METERED_POLICY_VERSION` in the same commit, because a creator may only
#be billed under terms they were shown. Asserted by
#``test_a_delivery_with_warnings_is_charged_the_full_quote``.
CHARGE_DELIVERED_WITH_WARNINGS_IN_FULL = True

#How much of a FAILED job's generated text the charge record keeps, so we
#can see what the model actually produced. Bounded and small because the record is a row in the money
#table that ``reconcile_zpage_variants`` and ``carried_fragments`` read in
#batches.
#
#TWO COPIES, TWO AUDIENCES. ``_attempted_output`` (underscore, so
#``charges.public_body`` never serves it) is kept for every failure OF THE
#OUTPUT -- the provider layer and a fatal safety check -- for operators
#reading the row. ``attempted_output_preview`` is the same text served to the
#OWNER on the status endpoint, and only for:data:`SHOW_ATTEMPTED_OUTPUT_CODES`.
#Neither is kept on a delivery-time abort such as ``source_changed``: the
#output was fine there, and handing it over with a refund would make "edit
#the article mid-job" a free translation.
ATTEMPTED_OUTPUT_PREVIEW_CHARS = 4_000

#Failures whose attempted output the CREATOR may see. **EMPTY, on purpose.**
#
#A refunded job whose preview contains a correct translation is a free
#translation, and three rounds of codex adversarial review on  found a
#way to put one in front of every candidate:
#
#1. any code, previewing the assembled document: a short article followed by
#a paragraph engineered to blow the output cap translates the article,
#fails on the last fragment, refunds in full, and hands back the finished
#prefix -- four thousand characters is a whole short article;
#2. ``wrong_script``, still the assembled document: the script verdict is
#over the replies TOGETHER, so one correct fragment can ride along with
#enough English ones to fail it;
#3. ``wrong_script``, only the replies that themselves fail the check: one
#reply holding a complete short Russian translation plus longer English
#padding fails at 410 of 1,295 letters, and the Russian is in the preview.
#
#Each fix narrowed the leak and none closed it, because "this text is not
#the product" is not something a script ratio can establish. So the creator
#gets the DIAGNOSIS -- ``error``, ``error_detail`` (for ``wrong_script``,
#"only 93 of 343 letters are Cyrillic") and ``attempted_output_chars`` -- and
#the text itself stays operator-only in ``_attempted_output``. The plumbing
#that would serve ``attempted_output_preview`` is kept and tested: adding a
#code here is the whole change, for a failure whose output provably cannot
#be a translation.
SHOW_ATTEMPTED_OUTPUT_CODES = frozenset()


def delivers_with_warning(code):
    """Whether a ``safety`` violation with this code is delivered as a warning."""
    return code in DELIVER_WITH_WARNING_CODES


# --------------------------------------------------------------------------- #
# The spend meter
# --------------------------------------------------------------------------- #
#Total translated-fragment characters one job may carry forward. A charge
#record lives on an ``IdempotencyKey`` row in the money table, and the point
#of carrying fragments is to stop paying twice for the same text -- not to
#store a second copy of every article ever translated. One document's worth
#is the useful amount; past that the carry-over stops growing and the
#remaining fragments are simply re-translated.
MAX_CARRIED_CHARS = 100_000


@dataclass
class SpendMeter:
    """What the provider actually did for us during one document.

    ``input_tokens``/``output_tokens`` count the prompts we sent and the text we
    read back, summed over every provider call -- including calls whose answer
    was discarded -- **in the encoding the provider meters in** wherever
    tiktoken can resolve one (``service.provider_message_tokens`` and
    ``service.provider_tokens``;  for the reply,  for the prompt).
    That is the unit, and it is the unit because both these numbers are money:
    one is a charge and one is the loss the failure ceilings are denominated in.

    They are still an estimate, not the provider's own usage report:
    ``f2z.ai.providers.stream_chat`` yields text deltas only, so no usage block
    reaches us (the same reason ``service._complete`` has to infer truncation
    from a token count), and for a provider tiktoken cannot map at all the
    counts fall back to ``cl100k_base``. The estimate is used to compute a
    charge, so the charge is capped at the quote the creator consented to and
    cannot run away with a tokenizer error -- and it is discounted on top of
    that whenever the encoding could not be established
    (:data:`OUTPUT_TOKEN_UNCERTAINTY`).
    """

    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    #``{fragment key: translated text}`` for fragments THIS run generated and
    #we therefore paid for. Persisted on the charge record so a later attempt
    #at the same document does not pay for them again.
    fragments: dict = field(default_factory=dict)
    #Fragments a PREVIOUS attempt paid for, seeded by:func:`metered`. Read
    #for hits and never written back: a charge record stores only what its own
    #run bought, because the money table is not a translation cache and
    #`charges.carried_fragments` unions the recent records anyway. Without the
    #split, every retry re-stores the whole accumulated document on another
    #row -- and `reconcile_zpage_variants` reads these blobs in batches.
    carried: dict = field(default_factory=dict)
    carried_chars: int = 0
    #Asked once, immediately before this run's first NEW provider call (a
    #fragment not recalled from the caches above), and may raise to refuse
    #it. ``None``: nothing to ask. See:func:`before_generation`.
    generation_gate: object = None

    def record(self, *, input_tokens, output_tokens):
        self.calls += 1
        self.input_tokens += max(0, int(input_tokens or 0))
        self.output_tokens += max(0, int(output_tokens or 0))

    @property
    def billable(self):
        """Did the provider do work we were billed for?

        The gate on every charge and on the failure cooldown's counter. False
        means the failure happened before (or without) any generation, and then
        nobody is charged and it does not count against the caller -- which is
        what keeps "charge them if openai charges us" honest in both
        directions.
        """
        return self.calls > 0 and (self.input_tokens or self.output_tokens)

    def remember(self, key, text, *, seeded=False):
        """Keep a translated fragment. ``seeded`` ones are read-only carry-in."""
        if not key or not text:
            return
        if key in self.fragments or key in self.carried:
            return
        if self.carried_chars + len(text) > MAX_CARRIED_CHARS:
            return
        if seeded:
            self.carried[key] = text
        else:
            self.fragments[key] = text
        self.carried_chars += len(text)

    def recall(self, key):
        """A translation of this fragment we have already paid for."""
        if key in self.fragments:
            return self.fragments[key]
        return self.carried.get(key)


_METER = contextvars.ContextVar("zpage_translation_meter", default=None)


class _Metered:
    """Context manager for:func:`metered`. Restores the previous binding."""

    def __init__(self, meter):
        self.meter = meter
        self._token = None

    def __enter__(self):
        self._token = _METER.set(self.meter)
        return self.meter

    def __exit__(self, *exc):
        _METER.reset(self._token)
        return False


def metered(meter=None, *, carried=None):
    """Bind a:class:`SpendMeter` for the duration of one document.

    ``carried`` seeds the fragment cache from a previous, already-paid-for
    attempt at the same document. Passing it is how "never discard work already
    paid for" is honoured across charge records.
    """
    meter = meter if meter is not None else SpendMeter()
    if carried:
        for key, text in carried.items():
            meter.remember(key, text, seeded=True)
    return _Metered(meter)


def current():
    """The meter bound for this context, or ``None`` outside:func:`metered`."""
    return _METER.get()


def record_provider_call(*, input_tokens, output_tokens):
    """Report one provider call. A no-op when nothing is metering.

    Called from ``service._complete``, which is the single place a translation
    provider call is made. It must never raise: a metering bug may not be able
    to fail a translation.
    """
    meter = _METER.get()
    if meter is None:
        return
    try:
        meter.record(input_tokens=input_tokens, output_tokens=output_tokens)
    except Exception:
        logger.exception("translation spend metering failed (ignored)")


# --------------------------------------------------------------------------- #
# Fragment carry-over
# --------------------------------------------------------------------------- #
#Version of HOW a fragment is generated and post-processed: the system prompt,
#the envelope, the strict-retry reminder, the wrapper-fence stripping, the
#truncation rule. Part of the cache key, so bumping it makes every carried
#fragment produced by the old pipeline unreachable instead of reusable.
#
#**Bump it in the same commit as any change to that pipeline.** Without it,
#a deploy that fixes the instructions leaves a creator's retry serving the
#fragments the BROKEN instructions produced -- ``translate_unit`` returns a
#cached fragment before it reaches the corrected path at all, so a wrong
#translation that happens to pass the document safety checks survives the fix
#and is delivered for payment. (codex adversarial review of.)
#
#**2**, not 1, because  has landed: it added envelope stripping, an
#anti-echo prompt rule, the cap retry and `_match_boundaries`, so a fragment
#produced before it is a fragment produced by the pipeline that was returning
#`<fragment>` tags and glued-together code fences. Those must not be
#recallable. This is the obligation in the paragraph above being honoured the
#first time it came due.
#
#Bumped to **3** by, which added rule 6 to the system prompt (the
#do-not-translate names) and made ``$$``-math and ``::embed`` directives
#verbatim. A fragment generated under version 2 was produced by a prompt that
#never asked the model to keep "Free2Z" or "2Z" -- so recalling one after this
#deploys would hand the new ``brand_term_not_preserved`` check a fragment the
#old prompt was entitled to produce, and fail the retry that the carry-over
#exists to make cheaper. Found by the codex adversarial review.
#
#Bumped to **4** by, which added the truncation rules
#(``_envelope_unclosed``, ``_residual_envelope``) and the stricter URL
#checks. A fragment cached under 3 never passed the per-fragment truncation
#rules -- ``translate_unit`` returns a recalled fragment BEFORE they run --
#so a half-answer carried from before the deploy would otherwise be
#delivered and charged. (The URL checks run on the assembled document and
#would see a carried fragment anyway; the bump is for the truncation rules,
#and keeps a pipeline change a cache-key change.) (codex review of the
#security round of.)
#
#Bumped to **5** by, which made the provider's terminal signal
#authoritative for truncation and completion. Policy 4 could accept a reply
#whose provider finish reason was a token limit when re-encoding its text
#fell below the requested cap. Because carried fragments are recalled before
#those checks, a policy-4 fragment could otherwise bypass the new metadata
#contract on a refunded retry.
GENERATION_POLICY_VERSION = 5


def fragment_key(*, ai_model_id, source_language, target_language, context,
                 text):
    """Identity of one translated fragment.

    Every input that changes what the right answer IS is in the digest: the
    model, both languages, what kind of fragment it is (a title is translated
    under different instructions from a paragraph), the exact source bytes, and
    :data:`GENERATION_POLICY_VERSION` -- the version of the prompt and
    post-processing that produced it. So a hit is only ever the same question
    asked of the same pipeline, and there is no cache-invalidation problem to get
    wrong: a changed article, a changed model or a changed prompt simply produces
    different keys.
    """
    digest = hashlib.sha256()
    for part in (
        str(GENERATION_POLICY_VERSION), str(ai_model_id or ""),
        str(source_language or ""),
        str(target_language or ""), str(context or ""), text or "",
    ):
        digest.update(part.encode("utf-8", "replace"))
        digest.update(b"\x1f")
    return digest.hexdigest()


def recall_fragment(key):
    """A previously paid-for translation of this exact fragment, or ``None``."""
    meter = _METER.get()
    if meter is None:
        return None
    try:
        return meter.recall(key)
    except Exception:
        logger.exception("translation fragment recall failed (ignored)")
        return None


def before_generation():
    """Consult the bound meter's ``generation_gate`` before a new provider call.

    Unlike everything else in this module it is ALLOWED TO RAISE -- refusing
    the call is its job (: a retry that already spent must still stop
    before buying more once the failure ceiling is reached). Asked once per
    run; a recalled fragment never reaches it.
    """
    meter = _METER.get()
    if meter is None or meter.generation_gate is None:
        return
    gate, meter.generation_gate = meter.generation_gate, None
    gate()


def remember_fragment(key, text):
    """Keep a fragment we have paid for, in case this document fails later."""
    meter = _METER.get()
    if meter is None:
        return
    try:
        meter.remember(key, text)
    except Exception:
        logger.exception("translation fragment carry-over failed (ignored)")


# --------------------------------------------------------------------------- #
# Money
# --------------------------------------------------------------------------- #
#Divisor applied to METERED TOKENS before they are priced FOR A CHARGE.
#
#``count_tokens`` counts every model's reply with ``cl100k_base``, and the
#provider meters in its own encoding (``o200k_base`` for gpt-4o). On the
#languages Free2Z sells,  measured ``cl100k`` over-counting the reply by
#**1.17x to 3.15x** -- Hindi worst. Over-counting is harmless for a cap
#('s own bug, now fixed there) and NOT harmless for a charge: capping at
#the quote does not stop an over-estimate billing a creator two thirds of a
#quote for a third of a quote's worth of provider work. (codex adversarial
#review of.)
#
#So the settlement divides the output count by the worst measured over-count,
#which makes the billed figure a LOWER bound on what the provider did rather
#than an upper one. We under-bill on purpose: "charge them if openai charges
#us" is satisfied by charging for work that certainly happened, and the
#alternative is charging a creator for arithmetic we know is wrong.
#
#BOTH sides are discounted. The first version discounted only the reply, on
#the grounds that the prompt is English where the two encodings agree -- but
#the prompt is the CREATOR'S ARTICLE, and Free2Z sells translation FROM the
#languages it sells translation into. An input-heavy Hindi article with a short
#reply would have been billed on an inflated input count that the output
#discount cannot offset, and capping at the quote does not help because the
#quote is computed from the same inflated counts. (codex adversarial review of
#, round 4.)
#
#DELETE THIS, and set it to 1.0, once the text is counted in the provider's
#own encoding  or the provider's reported usage reaches us.
#propagates termination reasons for truncation detection; it does not change
#this settlement estimate. Until usage is reported, this is the honest
#treatment of an estimate used to move money.
#
#THAT DAY HAS COME FOR SOME MODELS AND NOT OTHERS, WHICH IS WHY THIS IS NO
#LONGER UNCONDITIONAL (item 2).  put the reply into the
#provider's own encoding and  put the prompt there too, so for any model
#tiktoken can map -- every OpenAI row -- both counts are now in the unit the
#provider meters in and this divisor is correcting a bias that is no longer
#there. Left unconditional it understated gpt-4o spend by a factor of 3.2,
#i.e. two compensating errors, which is the state this repo's doctrine says
#never to leave a money path in.
#
#For a model tiktoken has NO mapping for -- ``anthropic:claude-haiku-4-5``,
#``kimi:kimi-k3`` -- ``provider_tokens`` degrades to ``cl100k_base`` by
#design, so the bias is exactly what it always was and the discount is still
#doing its job. A change that is right for gpt-4o and wrong for Haiku would be
#a regression, which is why the switch exists at all rather than the constant
#simply being deleted.
#
#THIS IS LIVE ON DEPLOY, NOT LATENT -- an earlier draft of this comment said
#the opposite and it was wrong in the one direction that matters on a money
#path. ``DEFAULT_MODEL_PREFERENCE`` lists Haiku ahead of gpt-4o, but
#PRODUCTION SELECTS GPT-4O: every prod line in // that names a
#model names ``openai/gpt-4o`` (both deliveries, both ``output_truncated``
#refunds, and the ``quoted 8 / actual 10`` settlement line), all eight jobs
#being one creator on one article inside eighteen minutes, i.e. one selection.
#``select_translation_model`` skips a provider we hold no API key for, and this
#module's own header plus ``seed_ai_models`` say why that is the likely reason:
#*"on stage/prod only OPENAI_API_KEY is guaranteed set"*. Haiku is seeded and
#enabled; the key is what it loses on.
#
#So the measured effect of turning this divisor off, on the next deploy: a
#REQUESTER-CAUSED failure on gpt-4o settles 2.5x-3.1x higher than it does today
#(3 -> 8 2Z at ``in=29066 out=500``; 4 -> 10 2Z at ``in=6751 out=8228``). That
#is what  item 2 asked for and it is bounded in three ways that did not
#change -- ``min(metered_cost, charged)`` is the quote the creator consented
#to, it is only reached when ``fault == REQUEST``, and the forgiveness
#allowance stands in front of it -- but it is a real number moving on a real
#deploy and must not be described as dormant.
#
#The same correction runs the other way for the good news: the  item 1
#lockout fix is live too. The Hindi- and Arabic-writing creators who were
#reaching the failure ceiling at about a third of an English writer's
#allowance are fixed on this deploy, not at some future model switch.
#
#:func:`_uncertainty` is the switch, and it asks
#``service.counts_in_provider_encoding``, which answers ``False`` for
#anything it cannot establish -- an unmappable model, a BPE file that would
#not load, an exception on the way to finding out. So the discount is the
#DEFAULT and removing it requires positive evidence, which is the right way
#round for a number that decides what a creator is billed.
#
#WHY 1.0 AND NOT SOME SMALLER MARGIN. The residual that the codex adversarial
#review named -- ``num_tokens_from_messages`` adding the 2023 gpt-3.5 framing
#(+4 a message, +2 priming) where gpt-4o documents +3 and +3 -- is a KNOWN
#over-count with a known sign, so it is not covered by a fudge factor: it is
#subtracted, in ``service._framing_overcount``, and only where this divisor is
#1.0. Removing the discount while leaving that in place would have been the
#same compensating-errors mistake pointing the other way, and one token is one
#whole 2Z at a ``ceil`` boundary.
#
#What is left has no known sign: ``stream_chat`` yields text deltas and no
#usage block, so we re-encode the text we read back rather than counting what
#was generated. Inventing a margin for that would be hand-rolling a
#statistical fudge onto a money bound. The real protections are structural and
#unchanged -- ``metered_cost`` is capped at ``min(metered_cost, charged)``, it
#is only ever billed when ``fault == REQUEST``, and the forgiveness allowance
#stands in front of that. Provider-reported usage, when added, will remove the
#remaining estimate uncertainty;  only supplies termination reasons.
OUTPUT_TOKEN_UNCERTAINTY = 3.2


def _uncertainty(ai_model):
    """The divisor to apply to this model's metered counts before pricing.

    1.0 when the counts are already in the provider's own encoding, and
    :data:`OUTPUT_TOKEN_UNCERTAINTY` otherwise. Must never raise: a pricing
    detail may not fail a settlement, and the exception path takes the discount
    because under-billing is the error this module chooses.

    ``AIModel.get_tuzi_price`` now performs the shared cost calculation in
    ``Decimal`` and rounds up only once at the whole-2Z boundary. In particular,
    the gpt-4o pair ``(1996, 501)`` costs exactly one cent and remains one 2Z.
    This is shared by translation settlement, chat, language detection and AI
    cover pricing, so the exact-cent correction applies consistently across
    those paid paths.
    """
    from dj.apps.g12f.translation import service

    try:
        if service.counts_in_provider_encoding(ai_model):
            return 1.0
    except Exception:
        logger.exception(
            "could not establish the tokenizer for %s -- discounting the "
            "metered spend as if it were counted in the wrong encoding",
            getattr(ai_model, "model", ai_model),
        )
    return OUTPUT_TOKEN_UNCERTAINTY


def _discount(tokens, divisor):
    return int(int(tokens or 0) / max(1.0, divisor))


def _price(ai_model, meter, input_tokens, output_tokens, what):
    from dj.apps.g12f.translation import service

    if ai_model is None or meter is None or not meter.billable:
        return 0
    try:
        return int(
            service.translation_price(ai_model, input_tokens, output_tokens)
        )
    except Exception:
        # A pricing failure must not strand a queued charge. Zero means "we
        # could not establish a cost", and an unestablished cost is not billed.
        logger.exception(
            "could not price %s translation spend (in=%s out=%s) -- settling "
            "at zero", what, input_tokens, output_tokens,
        )
        return 0


def metered_cost(ai_model, meter):
    """What we may BILL for the provider work this meter recorded, in whole 2Z.

    The SAME arithmetic as the quote -- ``service.translation_price``, cost-plus
    at the translation markup -- so a settlement and a quote for the same token
    counts are the same number. Notably that includes the ceil to a whole 2Z,
    which is the platform's margin everywhere else and here means any nonzero
    provider spend settles at at least 1 2Z.

    Both counts are discounted by:data:`OUTPUT_TOKEN_UNCERTAINTY` when they
    are NOT in the provider's own encoding, so what comes back is a FLOOR on
    our real spend. they are in that encoding for every model
    tiktoken can map, and then the divisor is 1.0 and this is simply the price
    of what we metered -- still capped at the quote by the caller. Use it for
    charging and for nothing else;:func:`estimated_cost` is the number that
    describes our loss.
    """
    divisor = _uncertainty(ai_model)
    return _price(
        ai_model, meter,
        _discount(meter.input_tokens if meter else 0, divisor),
        _discount(meter.output_tokens if meter else 0, divisor),
        "billable",
    )


def estimated_cost(ai_model, meter):
    """What the provider work this meter recorded PROBABLY cost, in whole 2Z.

    Undiscounted, so it is the better estimate of our actual loss -- and it is
    what the failure-spend ceilings are summed from.

    AND NOW IT IS IN THE RIGHT UNIT **FOR A MODEL TIKTOKEN CAN MAP** (item 1). At the default translation markup of 1.0,
    ``get_tuzi_price`` is ``ceil(dollars * 100)`` -- so one 2Z of this number is
    one cent of real provider spend, *provided* the token counts are the
    provider's own. Until the prompt moved to ``provider_message_tokens`` they
    were not for any model, and the ceilings this feeds were reached at a
    fraction of their nominal dollar value for any creator whose article is not
    in English: about a third of it for Hindi or Arabic. That is fixed for every
    OpenAI row. The constants did not change; what they mean did.

    IT IS NOT FIXED FOR AN UNMAPPABLE VENDOR, and the scope matters because
    ``DEFAULT_MODEL_PREFERENCE`` lists one first. For Anthropic and Kimi we do
    not know what the provider meters at all, so ``cl100k_base`` is a proxy, and
    it is a proxy that inflates non-Latin scripts. Measured on parallel ~1.8 kB
    articles saying the same thing, the prompt-side cost relative to the English
    one is:

    ==========  ===============  ===============
    source      gpt-4o (o200k)   Haiku (cl100k)
    ==========  ===============  ===============
    Hindi       1.47x            **4.66x**
    Thai        1.73x            4.09x
    Arabic      1.37x            3.08x
    Russian     1.18x            2.19x
    Spanish     1.15x            1.37x
    ==========  ===============  ===============

    The o200k column is REAL cost -- Hindi genuinely takes more tokens to say
    the same thing -- so language neutrality never meant "every language costs
    the same". It means the MEASUREMENT stops adding a penalty on top of the
    real cost, and the penalty is the excess of one column over the other:
    3.17x of pure measurement error for Hindi, still there for Haiku.
    :data:`OUTPUT_TOKEN_UNCERTAINTY` is the acknowledgement of that on the
    charge side; on the ceiling side it is an open residual.  supplies
    termination reasons, not provider usage, so this estimate remains.

    Keeping this apart from:func:`metered_cost` is the point, and the two COINCIDE on the common path -- which is a reason to keep them apart,
    not to merge them. They answer two different questions and want opposite
    errors: a charge must err low, or we bill a creator for arithmetic we know is
    inflated; a loss budget must err high, or the ceiling meant to bound a drain
    under-reports it by the size of the discount and lets ~2.4x more spend
    through than it says. The first version used one number for both, and the
    platform ceiling silently became a 4,800 2Z ceiling wearing a 2,000 label.
    (codex adversarial review of, round 4.)

    What changed is only the SIZE of the gap. With the counts in the provider's
    own encoding the divisor is 1.0 and this function returns exactly what
    :func:`metered_cost` does -- there is a test asserting that -- so anyone
    reading the two side by side today sees no difference and might reasonably
    ask what the split is for. It is for the case where they diverge again: an
    unmappable vendor (Haiku, Kimi) still runs at 3.2, and so does any model
    whose vocabulary failed to load. Collapsing them because they agree on
    gpt-4o would silently restore the 4,800-wearing-2,000 bug for every other
    row. (Noted in review of.)
    """
    return _price(
        ai_model, meter,
        meter.input_tokens if meter else 0,
        meter.output_tokens if meter else 0,
        "estimated",
    )
