from django.db import models
from django.contrib.auth import get_user_model


class TwitterProfile(models.Model):
    creator = models.OneToOneField(
        get_user_model(),
        on_delete=models.CASCADE,
        related_name="twitter_profile",
        null=True,
    )
    allow_login = models.BooleanField(default=True)
    is_public = models.BooleanField(default=False)
    twitter_id = models.CharField(unique=True, max_length=64)
    username = models.CharField(unique=True, max_length=64)
    name = models.CharField(max_length=255, blank=True)
    description = models.TextField(max_length=255, blank=True)
    profile_image_url = models.URLField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    #The account epoch this profile was linked at. Same rule and
    #same reasoning as `social.SocialIdentity.linked_at_epoch`; this is the
    #legacy login family that predates `dj.apps.social` and is easy to miss
    #precisely because the newer app looks like it superseded it. It signs
    #in with a Django SESSION rather than a Knox token, so the eviction has
    #to hold on both credential shapes.
    #
    #`creator` is nullable here (an orphaned row from an interrupted OAuth
    #flow), and such a row grants nobody access, so its value is inert until
    #the row is adopted -- which sets it.
    linked_at_epoch = models.PositiveIntegerField(
        default=1,
        # `db_default` as well as `default`, and it is a DEPLOY-SAFETY
        # requirement rather than a duplicate (codex adversarial review).
        # `manage.py migrate` is a Cloud Build step that runs BEFORE the new
        # pods roll, and Django's AddField adds the column with a temporary
        # default and then DROPS it -- so for the length of the rollout the
        # still-running old pods, whose model has no such field, would INSERT
        # without it and take a NOT NULL violation on every new link. A row
        # written that way lands at the initial epoch, which is correct for
        # the overwhelming majority of accounts and fails CLOSED (a refused
        # login, "reconnect it") rather than open for the rest.
        db_default=1,
        editable=False,
        help_text=(
            "Creator.kt_account_epoch when this profile was linked. A login "
            "through it is refused once the account has moved past it."
        ),
    )
    #Durable record that this identity already lost passwordless fallback
    #selection.  It is cleared only by an explicit authenticated re-link.
    fallback_rejected_at_epoch = models.PositiveIntegerField(
        null=True,
        blank=True,
        editable=False,
        help_text=(
            "Account epoch at which this profile was rejected as a "
            "passwordless fallback. Explicit re-linking clears it."
        ),
    )
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.creator.get_username()


class Announcement(models.Model):
    """One @F2ZP2P post owed for one semantic event.

    THE ROW IS THE DURABLE RECORD. The Procrastinate job that executes it is
    only a wake-up: losing a job loses nothing, because the periodic sweep
    re-defers every due ``pending`` row. The Pub/Sub listener this replaces
    acknowledged -- and so destroyed -- every event whose tweet failed.

    ``event_key`` is UNIQUE, and is what makes "exactly one announcement per
    first publication / per comment" a database fact rather than a check:

    * ``zpage:first-published:{zpage_id}``
    * ``comment:created:{comment_uuid}``

    State machine (``status``)::

        pending --claim--> generating --> posting --> posted
           ^                   |             |
           |  retryable (429,  |             +--> needs_reconciliation
           +-- 503, connect) --+                  (ambiguous create: X may
                               |                   have accepted it -- NEVER
                               +--> suppressed     retried automatically)
                               +--> failed (401/402/403, invalid content,
                                    attempts exhausted, provider paused)
                               +--> dry_run (dry_run mode / non-live namespace)

    ``posting`` is committed BEFORE the create call, so a crash mid-call is
    visible as a row stuck in ``posting``, which the sweep moves to
    ``needs_reconciliation`` rather than retrying.
    """

    ZPAGE_FIRST_PUBLISHED = "zpage_first_published"
    COMMENT_CREATED = "comment_created"
    KIND_CHOICES = [
        (ZPAGE_FIRST_PUBLISHED, "zPage first published"),
        (COMMENT_CREATED, "Comment created"),
    ]

    PENDING = "pending"
    GENERATING = "generating"
    POSTING = "posting"
    POSTED = "posted"
    SUPPRESSED = "suppressed"
    FAILED = "failed"
    NEEDS_RECONCILIATION = "needs_reconciliation"
    DRY_RUN = "dry_run"
    STATUS_CHOICES = [
        (PENDING, "Pending"),
        (GENERATING, "Generating"),
        (POSTING, "Posting (create in flight)"),
        (POSTED, "Posted"),
        (SUPPRESSED, "Suppressed"),
        (FAILED, "Failed"),
        (NEEDS_RECONCILIATION, "Needs reconciliation"),
        (DRY_RUN, "Dry run"),
    ]
    #Rows whose create may have reached X; the rate caps count these.
    PROVIDER_REACHED = (POSTING, POSTED, NEEDS_RECONCILIATION)

    event_key = models.CharField(max_length=128, unique=True)
    kind = models.CharField(max_length=32, choices=KIND_CHOICES)
    # SET_NULL: the ledger outlives a deleted page/comment, so the rate caps
    # and the audit trail do not change retroactively.
    zpage = models.ForeignKey(
        "g12f.zPage", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="+",
    )
    comment = models.ForeignKey(
        "comments.Comment", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="+",
    )
    # Whose content this announces (page creator / comment author), for the
    # per-author cap. Survives deletion of the content row.
    subject_user = models.ForeignKey(
        get_user_model(), null=True, blank=True, on_delete=models.SET_NULL,
        related_name="+",
    )

    status = models.CharField(
        max_length=24, choices=STATUS_CHOICES, default=PENDING,
    )
    #Fresh on every claim. Every transition a running job makes is
    #conditional on it, so a job that stalled, lost its row to the sweep
    #and woke up later cannot overwrite the NEW attempt's state.
    lease = models.UUIDField(null=True, blank=True, editable=False)
    reason = models.CharField(max_length=64, blank=True, default="")
    attempts = models.PositiveIntegerField(default=0)
    next_attempt_at = models.DateTimeField(null=True, blank=True)

    text = models.TextField(blank=True, default="")
    url = models.CharField(max_length=512, blank=True, default="")
    #Whether ``text`` carries ``url`` (X bills a linked post ~13x a plain
    #one). Always true for zPages; F2ZP2P_COMMENT_LINKS for comments.
    includes_link = models.BooleanField(default=True)
    copy_source = models.CharField(max_length=16, blank=True, default="")
    #sha256 of the facts ``text`` was generated from; a retry whose facts
    #hash differently regenerates the copy (and the image).
    source_digest = models.CharField(max_length=64, blank=True, default="")
    image_source = models.CharField(max_length=16, blank=True, default="")
    media_id = models.CharField(max_length=64, blank=True, default="")
    #Paid image generations this row has started (success or not). Capped
    #by F2ZP2P_MAX_IMAGE_GENERATIONS: the budget reservation counts ROWS,
    #so without this a row could buy an image on every retry.
    image_generations = models.PositiveSmallIntegerField(default=0)
    #The generated JPEG, kept until the row is posted/suppressed so a retry
    #(expired media id, failed upload) re-uploads it instead of paying for
    #a new one. Cleared when the facts it was drawn from change.
    image_data = models.BinaryField(null=True, blank=True, editable=False)
    media_expires_at = models.DateTimeField(null=True, blank=True)

    last_status_code = models.PositiveIntegerField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")
    x_post_id = models.CharField(
        max_length=64, null=True, blank=True, unique=True,
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    #When this event took a slot in the spend budget (the hourly / daily /
    #per-author caps). Set ONCE, before any paid call, and kept through
    #retries and failures: generation and uploads cost money whether or
    #not the post lands, so a row stays counted for the whole window.
    budget_reserved_at = models.DateTimeField(null=True, blank=True)
    posting_started_at = models.DateTimeField(null=True, blank=True)
    posted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(
                fields=["status", "next_attempt_at"],
                name="twitter_ann_status_due_idx",
            ),
            models.Index(
                fields=["status", "posting_started_at"],
                name="twitter_ann_status_post_idx",
            ),
            models.Index(
                fields=["budget_reserved_at"],
                name="twitter_ann_budget_idx",
            ),
            models.Index(
                fields=["subject_user", "budget_reserved_at"],
                name="twitter_ann_subject_budget_idx",
            ),
        ]

    def __str__(self):
        return f"{self.event_key} [{self.status}]"
