"""Request/response shapes for paid AI translation ( Part 6).

Plain ``Serializer`` classes rather than model serializers: none of these
describe a row. The quote describes arithmetic, and the job describes a charge
whose durable form is a JSON body on an ``IdempotencyKey`` row (see
``dj.apps.g12f.translation.charges``), not a table of its own.

They exist mostly so ``f2z.yaml`` -- and therefore the generated TypeScript
client the translation manager will use -- carries the real contract instead of
an untyped blob.
"""
from rest_framework import serializers


class TranslationErrorSerializer(serializers.Serializer):
    """Every non-2xx answer except 402 on these routes has this shape."""

    code = serializers.CharField(
        help_text=(
            "Stable machine-readable reason. Branch on this, never on the "
            "prose: `idempotency_key_required`, `idempotency_mismatch`, "
            "`request_in_progress`, `price_changed`, "
            "`source_changed`, "
            "`variant_published`, `published_variant_limit`, "
            "`draft_variant_limit`, `not_translatable`, `same_language`, "
            "`empty_article`, `unknown_source_language`, "
            "`translation_unavailable`, `translation_in_progress`, "
            "`translation_backlog`, `translation_failure_cooldown`, "
            "`translation_failing`, `translation_too_long`."
        )
    )
    error = serializers.CharField(help_text="Human-readable message.")
    price = serializers.IntegerField(
        required=False,
        help_text="On `price_changed`: the current price in 2Z. Re-quote and "
                  "re-confirm with the creator before retrying.",
    )
    retry_after = serializers.IntegerField(
        required=False,
        help_text=(
            "On the 429s (`translation_failure_cooldown`, "
            "`translation_failing`): seconds to wait before buying again. "
            "Nothing was charged. Deliberately the whole cooldown window "
            "rather than the exact moment the rolling total clears it."
        ),
    )


class ExistingVariantSerializer(serializers.Serializer):
    """What is already sitting in the target language, if anything."""

    is_published = serializers.BooleanField()
    origin = serializers.CharField(allow_null=True)


class TranslationQuoteSerializer(serializers.Serializer):
    """`GET.../translate/quote/` -- the price, and the arithmetic behind it.

    Cost-plus and always metered, so there is no price list to look this up in:
    the number here is what this exact article, on this exact model, costs. It
    is computed from the token count of the REAL prompt and is stable for as
    long as the article is unchanged -- which `source_digest` lets a client
    prove.
    """

    price = serializers.IntegerField(
        help_text="What buying this translation costs, in whole 2Z. Show this "
                  "to the creator and send it back as `expected_price`."
    )
    balance = serializers.CharField(
        help_text="The creator's current 2Z balance."
    )
    affordable = serializers.BooleanField(
        help_text="`balance >= price` at the moment of the quote. Advisory: "
                  "the purchase re-checks authoritatively."
    )
    source_language = serializers.CharField()
    language = serializers.CharField(help_text="The target language (BCP-47).")
    source_digest = serializers.CharField(
        help_text=(
            "SHA-256 of the article body this price was computed against. The "
            "purchase is bound to it: edit the article and the quote is void "
            "(the purchase answers 409 `price_changed` or is refunded), which "
            "is what keeps the quote and the charge about the same text."
        )
    )
    ai_model = serializers.CharField(
        help_text="Display name of the model that will do the work."
    )
    input_tokens = serializers.IntegerField(
        help_text="Prompt tokens across every chunk, including the "
                  "per-chunk instruction overhead."
    )
    estimated_output_tokens = serializers.IntegerField(
        help_text="Estimated completion tokens. Unknowable exactly before "
                  "generation; the settlement bills this quote regardless and "
                  "absorbs an overrun."
    )
    chunks = serializers.IntegerField(
        help_text="Provider calls this translation will take. Code blocks are "
                  "never sent, so a code-heavy article costs less."
    )
    existing_variant = ExistingVariantSerializer(
        allow_null=True,
        help_text="The variant already in this language, or null. A PUBLISHED "
                  "one cannot be overwritten by machine output -- unpublish or "
                  "delete it first.",
    )


class TranslationPurchaseSerializer(serializers.Serializer):
    """`POST.../translate/` -- confirm the quoted price and buy."""

    expected_price = serializers.IntegerField(
        min_value=0,
        help_text=(
            "The price the creator was shown and approved, from "
            "`GET .../translate/quote/`. Required: with no flat price and no "
            "cap, a purchase that did not name a number would be a charge the "
            "creator never saw. A mismatch against the server's own "
            "recomputed price is refused with 409 `price_changed` and no "
            "money moves."
        ),
    )
    source_digest = serializers.RegexField(
        regex=r"^[0-9a-f]{64}$",
        min_length=64,
        max_length=64,
        required=False,
        help_text=(
            "SHA-256 of the article body shown in the quote. New clients "
            "must send it; the purchase is refused with 409 "
            "`source_changed` when the body has moved. It is optional for "
            "legacy callers, whose purchase is checked against the body read "
            "at request start."
        ),
    )
    settlement_policy = serializers.IntegerField(
        min_value=0,
        required=False,
        help_text=(
            "Which refund terms the buyer was SHOWN, as a version number "
            "(current: `1`). Send `1` only from a screen that states the one "
            "case in which a failed translation is not refunded in full: "
            "repeatedly changing or publishing the article while a translation "
            "you have already paid for is generating.\n\n"
            "**Omit it and every failure is refunded in full, always.** That is "
            "the legacy contract and it is the safe default on purpose -- a "
            "creator can only be charged against terms they actually saw, and "
            "the server cannot know what an already-open page is displaying. "
            "It never changes the price, only what happens if the job fails."
        ),
    )


class TranslationWarningSerializer(serializers.Serializer):
    """One content-preservation check a delivered draft did not pass."""

    code = serializers.ChoiceField(
        choices=[
            "code_identifier_not_preserved",
            "reference_not_in_source",
            "brand_term_not_preserved",
            "amount_not_in_source",
            "markup_not_in_source",
            "unsafe_url_scheme",
        ],
        help_text=(
            "Which check. Branch on this, never on `detail`. "
            "`url_not_in_source`, `zip321_amount_not_in_source`, "
            "`payment_math_not_verified`, and `payment_scan_limit` fail the "
            "job rather than deliver unverifiable payment instructions."
        ),
    )
    detail = serializers.CharField(help_text="Human-readable explanation.")
    items = serializers.ListField(
        child=serializers.CharField(),
        help_text=(
            "The offending strings -- the identifiers that changed, the "
            "schemes or tags that appeared, the amounts that differ -- "
            "sorted, at most 20. Untrusted model output: display as plain text."
        ),
    )


class TranslationJobSerializer(serializers.Serializer):
    """The charge record: what was paid, and what became of it.

    Returned by the purchase (202) and by `GET.../translate/`. Retrying the
    purchase with the same `Idempotency-Key` replays this same record, so a
    client that lost a response can always recover the truth about its money.
    """

    job_id = serializers.CharField(
        help_text="Opaque id for this purchase. Poll `GET .../translate/`."
    )
    status = serializers.ChoiceField(
        choices=["queued", "delivered", "refunded", "settled"],
        help_text=(
            "`queued` paid, translation in progress. `delivered` a DRAFT "
            "variant now exists -- review it, edit it, publish it; see "
            "`warnings` for anything it did not preserve. `refunded` "
            "the full amount was credited back and nothing was written. "
            "`settled` nothing was written and PART of the charge was kept, "
            "covering provider work that had already been done and billed to "
            "us when the buyer changed the article under their own paid job "
            "again -- see `fault` and `billed`. All three of "
            "`delivered`, `refunded` and `settled` are terminal: stop polling."
        ),
    )
    zpage_id = serializers.IntegerField()
    language = serializers.CharField()
    source_digest = serializers.CharField()
    target_digest = serializers.CharField(
        allow_null=True,
        required=False,
        help_text=(
            "Digest of the draft that occupied this language at purchase, or "
            "null. Covers its title, description AND content -- everything a "
            "delivery overwrites -- so polishing only a translated title still "
            "counts as a change. The worker refuses to deliver over a draft "
            "that changed since: a creator's own edits are never overwritten "
            "by machine output, and the purchase is refunded instead."
        ),
    )
    price = serializers.IntegerField(help_text="Quoted price in whole 2Z.")
    charged = serializers.CharField(help_text="Amount debited.")
    refunded = serializers.CharField(
        help_text="Amount credited back. Equal to `charged` when `status` is "
                  "`refunded` -- which is every failure caused by us, by the "
                  "provider, or before any generation happened. On `settled` "
                  "it is `charged` minus `billed`."
    )
    billed = serializers.CharField(
        required=False,
        help_text=(
            "Amount KEPT out of `charged`, in 2Z. `0` for everything except a "
            "`settled` record. Never exceeds `price`, and never exceeds the "
            "metered cost of provider work that was actually performed."
        ),
    )
    settlement_policy = serializers.IntegerField(
        required=False,
        allow_null=True,
        help_text=(
            "The refund terms this purchase recorded, echoed back from what the "
            "client declared. `null` means legacy terms: every failure is "
            "refunded in full. A client that sent a version and reads `null` "
            "here did not get the terms it thought it did."
        ),
    )
    fault = serializers.ChoiceField(
        choices=["platform", "provider", "request"],
        required=False,
        help_text=(
            "Who the failure was attributed to. `platform` our defect "
            "-- a mis-set cap, our timeout, our bug, a kill switch: always a "
            "full refund. `provider` an outage or unusable output: always a "
            "full refund. `request` the buyer changed the article under a job "
            "they had already paid for, repeatedly: settled at metered cost."
        ),
    )
    metered_cost = serializers.IntegerField(
        required=False,
        help_text=(
            "The most this failure could have been billed at, in whole 2Z: the "
            "provider work actually performed, priced with the same cost-plus "
            "arithmetic as the quote and deliberately under-counted so an "
            "estimate can never over-bill. Recorded on every failure, including "
            "the ones refunded in full."
        ),
    )
    estimated_cost = serializers.IntegerField(
        required=False,
        help_text=(
            "The better estimate of what this failure cost Free2Z, in whole 2Z "
            "-- not discounted. Never billed to anyone; it exists so the number "
            "used for a charge can err low while the number used to describe a "
            "loss errs high."
        ),
    )
    provider_billed = serializers.BooleanField(
        required=False,
        help_text="Whether the provider did billable work before the failure. "
                  "False means nobody paid for anything.",
    )
    provider_input_tokens = serializers.IntegerField(
        required=False,
        help_text="Prompt tokens sent across every provider call, including "
                  "attempts whose answer was discarded.",
    )
    provider_output_tokens = serializers.IntegerField(
        required=False,
        help_text="Completion tokens generated across every provider call, "
                  "including attempts whose answer was discarded -- a provider "
                  "bills a stream it generated whether or not we keep it.",
    )
    provider_calls = serializers.IntegerField(
        required=False,
        help_text="Provider calls made before the failure.",
    )
    settled_at = serializers.CharField(
        required=False,
        allow_null=True,
        help_text="ISO-8601 timestamp of the terminal failure transition.",
    )
    balance = serializers.CharField(
        help_text="The creator's balance as of the last change to this record."
    )
    ai_model = serializers.CharField()
    ai_model_id = serializers.CharField()
    error = serializers.CharField(
        allow_null=True,
        help_text=(
            "Why it failed, if it did: `provider_error`, `failure_cooldown`, "
            "`empty_output`, `output_truncated`, `timeout`, "
            "`output_too_long`, `source_changed`, `variant_published`, "
            "`variant_changed`, `same_language`, `model_unavailable`, "
            "`mirror_disabled`, `provenance_unwritten`, `zpage_gone`, "
            "`abandoned`, `wrong_script`, or a safety code "
            "(`url_not_in_source`, `zip321_amount_not_in_source`, "
            "`payment_math_not_verified`, `payment_scan_limit`, "
            "`unsafe_url_scheme`, `markup_not_in_source`, `amount_not_in_source`). "
            "Payment destination, amount, unverifiable math, and scan-budget "
            "failures reject the draft and refund the charge. Other safety "
            "codes are delivered as warnings."
        ),
    )
    error_detail = serializers.CharField(allow_null=True, required=False)
    warnings = TranslationWarningSerializer(
        many=True,
        required=False,
        help_text=(
            "On `delivered`: the content-preservation checks this draft did "
            "NOT pass. The draft was delivered anyway, and billed in "
            "full, because it is an unpublished draft the creator reviews -- "
            "these name what to look at before publishing. An empty list is a "
            "clean delivery; the key is absent on records delivered before "
            "warnings existed."
        ),
    )
    attempted_output_preview = serializers.CharField(
        required=False,
        help_text=(
            "Reserved: the start of what the model produced on a "
            "failed job, served only for failure codes whose output provably "
            "cannot be a usable translation -- currently NONE, because a "
            "refund that hands back a translation is a free translation. Use "
            "`error`, `error_detail` and `attempted_output_chars` to explain a "
            "failure. Owner-only if ever served. Untrusted model output: "
            "display it as PLAIN TEXT, never render it as Markdown or HTML."
        ),
    )
    attempted_output_chars = serializers.IntegerField(
        required=False,
        help_text="On a failure of the output itself: how many characters the "
                  "model had produced. Present whether or not "
                  "`attempted_output_preview` is.",
    )
    actual_cost = serializers.IntegerField(
        required=False,
        help_text="What the finished translation actually cost in 2Z at the "
                  "model's real token usage. Recorded for transparency; the "
                  "creator is always billed `price`.",
    )
    replayed = serializers.BooleanField(
        required=False,
        help_text="True when this response is the replay of an earlier "
                  "identical purchase rather than a new one.",
    )
