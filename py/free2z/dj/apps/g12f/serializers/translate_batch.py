"""Shapes for the per-zPage translation JOBS routes.

``GET  /api/zpage/{free2zaddr}/translations/``         the job tray
``GET  /api/zpage/{free2zaddr}/translations/quote/``   a multi-language quote
``POST /api/zpage/{free2zaddr}/translations/``         a bulk purchase

Kept apart from ``serializers/translate.py`` (the single-language routes) so the
two can change independently; the per-job record is the SAME charge record
either way, and the bulk purchase answers with ``TranslationJobSerializer``
items so a client parses one shape for "a job".
"""
from rest_framework import serializers

from f2z import languages

from dj.apps.g12f.serializers.translate import (
    ExistingVariantSerializer,
    TranslationJobSerializer,
    TranslationWarningSerializer,
)


MAX_TRANSLATION_BATCH_ITEMS = len(languages.TRANSLATABLE)


class TranslationBatchItemSerializer(serializers.Serializer):
    language = serializers.CharField(
        max_length=35,
        help_text="BCP-47 tag to translate INTO. Same rules as the "
                  "single-language purchase; bare `pt` canonicalizes to "
                  "`pt-BR`.",
    )
    expected_price = serializers.IntegerField(
        min_value=0,
        help_text="This language's `price` from "
                  "`GET .../translations/quote/`, as shown to the creator.",
    )


class TranslationBatchPurchaseSerializer(serializers.Serializer):
    """`POST.../translations/` -- buy several translations at once."""

    items = TranslationBatchItemSerializer(
        many=True,
        allow_empty=False,
        # A fixed bound -- no batch can name more languages than we sell. The
        # configurable limit (`max_items`) is applied after the idempotency
        # claim, so a lowered cap can never refuse the replay of a paid batch.
        max_length=MAX_TRANSLATION_BATCH_ITEMS,
        help_text=(
            "One entry per target language, each with the price the creator "
            "approved. At most `max_items` from the quote; a language may "
            "appear once."
        ),
    )
    source_digest = serializers.RegexField(
        regex=r"^[0-9a-f]{64}$",
        min_length=64,
        max_length=64,
        help_text=(
            "The quote's `source_digest`. **Required** here (unlike the "
            "single-language purchase, there is no legacy caller to keep "
            "working). If the article changed, the whole batch is refused "
            "with 409 `source_changed` and nothing is charged."
        ),
    )
    settlement_policy = serializers.IntegerField(
        min_value=0,
        required=False,
        help_text=(
            "Which refund terms the buyer was shown, applied to every job in "
            "the batch. Same meaning as on the single-language purchase: omit "
            "it and every failure is refunded in full."
        ),
    )


class TranslationItemFailureSerializer(serializers.Serializer):
    language = serializers.CharField()
    code = serializers.CharField(
        help_text=(
            "Why THIS language was refused: `price_changed`, "
            "`source_changed`, `variant_published`, "
            "`translation_in_progress` (a job for this exact language is "
            "already running), `published_variant_limit`, "
            "`draft_variant_limit`, `not_translatable`, `same_language`, "
            "`empty_article`, `unknown_source_language`, `invalid_language`, "
            "`duplicate_language`."
        )
    )
    error = serializers.CharField(help_text="Human-readable message.")
    price = serializers.IntegerField(
        required=False,
        help_text="On `price_changed`: this language's current price.",
    )


class TranslationBatchErrorSerializer(serializers.Serializer):
    """Every non-2xx answer of the bulk purchase except 402."""

    code = serializers.CharField(
        help_text=(
            "`items_refused` (see `items` -- the batch is all-or-nothing, so "
            "NOTHING was bought), `source_changed` (the article moved; every "
            "item is listed), `translation_in_progress` (the account cap: "
            "`in_flight` of `max_in_flight` are running), "
            "`translation_backlog`, `translation_failure_cooldown`, "
            "`translation_failing`, `translation_unavailable`, "
            "`idempotency_key_required`, `idempotency_mismatch`, "
            "`request_in_progress`, `invalid_request`, `invalid_language`, "
            "`duplicate_language`, `too_many_languages`."
        )
    )
    error = serializers.CharField(help_text="Human-readable message.")
    items = TranslationItemFailureSerializer(
        many=True,
        required=False,
        help_text="The languages that failed, and why. Only the failing "
                  "ones; an item absent here would have been accepted.",
    )
    source_digest = serializers.CharField(
        required=False,
        help_text="On `source_changed`: the article's current digest.",
    )
    in_flight = serializers.IntegerField(required=False)
    max_in_flight = serializers.IntegerField(required=False)
    max_items = serializers.IntegerField(required=False)
    retry_after = serializers.IntegerField(required=False)


class TranslationBatchJobsSerializer(serializers.Serializer):
    """202 from the bulk purchase, and its idempotent replay."""

    batch_id = serializers.CharField(
        help_text="The `Idempotency-Key` this batch was bought under. Every "
                  "job it created carries it as `batch_id`."
    )
    total = serializers.IntegerField(help_text="2Z debited for the batch.")
    jobs = TranslationJobSerializer(
        many=True,
        help_text="One charge record per language, in request order. On a "
                  "replay each reports its CURRENT status.",
    )
    replayed = serializers.BooleanField()


class TranslationBatchQuoteItemSerializer(serializers.Serializer):
    language = serializers.CharField(
        help_text="The normalized tag, or the raw input when it could not "
                  "be parsed (`reason: invalid_language`)."
    )
    available = serializers.BooleanField(
        help_text="Whether this language could be bought right now, in this "
                  "batch. Advisory: the purchase re-checks under its locks."
    )
    price = serializers.IntegerField(
        allow_null=True,
        help_text="Price in whole 2Z; null when `available` is false.",
    )
    reason = serializers.CharField(
        allow_null=True,
        help_text="Same codes as `TranslationItemFailure.code`; null when "
                  "available.",
    )
    error = serializers.CharField(allow_null=True)
    existing_variant = ExistingVariantSerializer(allow_null=True)


class TranslationBatchQuoteSerializer(serializers.Serializer):
    """`GET.../translations/quote/` -- per-language prices plus a total."""

    source_language = serializers.CharField()
    source_digest = serializers.CharField(
        help_text="Send back as the purchase's `source_digest`."
    )
    ai_model = serializers.CharField(allow_null=True)
    balance = serializers.CharField(help_text="The creator's 2Z balance.")
    items = TranslationBatchQuoteItemSerializer(many=True)
    total = serializers.IntegerField(
        help_text="Sum of `price` over the AVAILABLE items."
    )
    affordable = serializers.BooleanField(help_text="`balance >= total`.")
    capacity = serializers.IntegerField(
        help_text="How many more translations this account may start now "
                  "(its own cap and the platform queue, whichever is "
                  "tighter). A purchase of more is refused whole."
    )
    in_flight = serializers.IntegerField(
        help_text="Translations this account has running."
    )
    max_items = serializers.IntegerField(
        help_text="Most languages one quote or purchase may name."
    )


class TranslationDraftReviewSerializer(serializers.Serializer):
    """Current saved draft, trusted provenance and prior warning context."""

    job_id = serializers.CharField(
        allow_null=True,
        help_text="The delivered job whose exact output is still this draft.",
    )
    warnings = TranslationWarningSerializer(many=True)
    prior_warnings = TranslationWarningSerializer(
        many=True,
        required=False,
        default=list,
        help_text=(
            "Warnings from the newest delivery for this language. Historical "
            "context only; they do not describe an edited draft's current "
            "contents and never authorize publication."
        ),
    )
    revision = serializers.CharField(
        help_text="Strong variant ETag; send as `If-Match` when publishing.",
    )


class TranslationJobListItemSerializer(serializers.Serializer):
    """The newest job for one language of this zPage."""

    language = serializers.CharField()
    job_id = serializers.CharField()
    batch_id = serializers.CharField(
        required=False,
        help_text="Present when the job was bought in a bulk purchase.",
    )
    # A CharField, not a second ChoiceField over the same four values: two
    # components with an identical `status` enum make drf-spectacular rename
    # the existing `TranslationJobStatusEnum` to a hash, breaking every
    # generated-client import of it.
    status = serializers.CharField(
        help_text="`queued`, `delivered`, `refunded` or `settled` -- same "
                  "meaning as `TranslationJob.status`.",
    )
    source_digest = serializers.CharField(
        allow_null=True,
        help_text="The source text this job translates. Not equal to the "
                  "list's own `source_digest` means it was bought against an "
                  "older revision.",
    )
    price = serializers.IntegerField(allow_null=True)
    charged = serializers.CharField(allow_null=True)
    refunded = serializers.CharField(allow_null=True)
    billed = serializers.CharField(required=False)
    fault = serializers.CharField(required=False)
    error = serializers.CharField(allow_null=True)
    error_detail = serializers.CharField(allow_null=True)
    ai_model = serializers.CharField(allow_null=True)
    created_at = serializers.CharField(help_text="ISO-8601 purchase time.")
    settled_at = serializers.CharField(
        required=False,
        help_text="ISO-8601 time of a failure's settlement.",
    )
    # The same typed contract as `TranslationJob.warnings`, not a JSONField:
    # the tray and the single-job route must agree on what a warning is, and a
    # generated client cannot branch on `code` through an untyped blob.
    warnings = TranslationWarningSerializer(
        many=True,
        required=False,
        help_text="On `delivered`: the content-preservation checks this draft "
                  "did not pass, passed through from the charge record. "
                  "Delivered and billed anyway; these name what the creator "
                  "should review. Empty for a clean delivery; absent on records "
                  "delivered before warnings existed.",
    )
    draft = TranslationDraftReviewSerializer(
        required=False,
        allow_null=True,
        help_text=(
            "The current saved draft, when one exists. `revision` is its "
            "strong variant ETag and must be sent as `If-Match` when "
            "publishing the reviewed text. `job_id` and `warnings` identify "
            "the delivery only when its persisted output digest still matches "
            "the draft; otherwise the draft has no trusted AI provenance."
        ),
    )
    has_attempted_output_preview = serializers.BooleanField(
        help_text="Whether the charge record carries an "
                  "`attempted_output_preview`. The text itself is not "
                  "listed here; read it from `GET .../variants/{language}/"
                  "translate/` for the one job being opened.",
    )
    is_published = serializers.BooleanField(
        allow_null=True,
        help_text="Whether this language's translation is live, in either "
                  "storage shape. Null when no translation exists in it.",
    )
    is_stale = serializers.BooleanField(
        allow_null=True,
        help_text="True when the translation was made from an older source "
                  "revision; null when that is unknown or nothing exists.",
    )


class TranslationJobListSerializer(serializers.Serializer):
    """`GET.../translations/` -- the job tray, rediscoverable from any device."""

    source_digest = serializers.CharField(
        help_text="The article's current content digest."
    )
    jobs = TranslationJobListItemSerializer(
        many=True,
        help_text="Newest job per language, newest first, from the last 30 "
                  "days.",
    )
    drafts = serializers.DictField(
        child=TranslationDraftReviewSerializer(),
        help_text="Current unpublished drafts and trusted review provenance, "
                  "independent of whether their producing jobs remain in the "
                  "recent jobs list.",
    )
    in_flight = serializers.IntegerField(
        help_text="Translations this ACCOUNT has running (any article)."
    )
    capacity = serializers.IntegerField(
        help_text="How many more this account may start now."
    )
    max_in_flight = serializers.IntegerField(
        help_text="The per-account concurrent-translation cap."
    )
