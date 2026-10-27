import decimal
from decimal import Decimal, ROUND_HALF_UP

from django.utils import timezone
from django.db import models, router, transaction
from django.db.models import Sum, IntegerField
from django.db.models.functions import Coalesce
from django.contrib.auth.hashers import make_password, check_password
from django.contrib.contenttypes.models import ContentType

import markdown2
from taggit.managers import TaggableManager

from dj.apps.comments.models import Comment
from dj.apps.g12f.branding import default_logo_url
from dj.apps.g12f.validators import (
    validate_canonical_url,
    validate_zcash_address,
)
from dj.apps.g12f.zpage_paths import canonical_zpage_path
from dj.apps.uploads.models import GenericFile

from f2z import languages


def quantize_decimal(number) -> Decimal:
    if isinstance(number, (int, float, str)):
        number = Decimal(number)
    elif not isinstance(number, Decimal):
        raise TypeError('number must be of type int, float, str, or Decimal')
    return number.quantize(Decimal('0.0001'), rounding=ROUND_HALF_UP)


# https://gist.github.com/iandmyhand/b2c32311715113e8c470932a053a6732
class AbsoluteSum(Sum):
    name = 'AbsoluteSum'
    template = '%(function)s(%(absolute)s(%(expressions)s))'

    def __init__(self, expression, **extra):
        super(AbsoluteSum, self).__init__(
            expression, absolute='ABS ', output_field=IntegerField(), **extra)

    def __repr__(self):
        return "SUM(ABS({}))".format(
            self.arg_joiner.join(str(arg) for arg in self.source_expressions)
        )


CATEGORY_CHOICES = [
    ["", "None"],
    ['ART', "Art"],
    ["COMEDY", "Comedy"],
    ["COMMUNITY", "Community"],
    ["CHARITY", "Charity"],
    ["CRYPTO", "Crypto"],
    ["EDUCATION", "Education"],
    ["FICTION", "Fiction"],
    ["FOR TRADE", "For Trade"],
    ["FREE2Z", "Free2z"],
    ["FUNDRAISING", "Fundraising"],
    ["GAMING", "Gaming"],
    ["HEALTH", "Health"],
    ["LIFESTYLE", "Lifestyle"],
    ["MATH", "Math"],
    ["MUSIC", "Music"],
    ["PODCAST", "Podcast"],
    ["POLITICS", "Politics"],
    ["RELIEF", "Relief"],
    ["SCIENCE", "Science"],
    ["SERVICE", "Service"],
    ["SPORTS", "Sports"],
    ["TECHNOLOGY", "Technology"],
    ["ZCASH", "Zcash"],
]

# Language is data, not an enum ( Part 3 §3.3). The four-item
# `SUPPORTED_ZPAGE_LANGUAGES` tuple that used to live here is gone, and so is
# the `choices=` list it fed to every language column. Two reasons:
#
#   1. A creator writes in whatever language they write in. `f2z.languages`
#      validates a tag against the IANA subtag registry + CLDR at the
#      serializer boundary, which accepts any real human language instead of
#      the four we happened to have UI strings for.
#   2. `choices=` on a model field is schema state: adding a language would
#      require a migration, so the enum would keep re-growing back into the
#      thing this issue exists to delete. Nothing in Postgres ever enforced it
#      anyway -- it only drove the admin widget and `get_FOO_display()`.
#
# Validation therefore lives in exactly one place, the registry, reached
# through `dj.apps.g12f.localization.normalize_zpage_language`.
LANGUAGE_TAG_MAX_LENGTH = languages.MAX_TAG_LENGTH

# `und` is the legacy "nobody ever asked" sentinel. It is still the create-path
# default and still resolves exactly as it does today;  M7 deletes it once
# detection has drained the corpus and  has retired the classic editor,
# which  hard-wired to strip language metadata. Until then this constant is
# the single place that names it.
LEGACY_UNDETERMINED_LANGUAGE = "und"

# How `zPage.source_language` came to hold its current value. A genuine closed
# enum -- unlike a language, there will only ever be these two answers -- so
# `choices=` is the right tool here.
LANGUAGE_SOURCE_DETECTED = "detected"
LANGUAGE_SOURCE_CREATOR = "creator"
LANGUAGE_SOURCE_CHOICES = (
    (LANGUAGE_SOURCE_DETECTED, "Detected"),
    (LANGUAGE_SOURCE_CREATOR, "Creator"),
)

# These are the fields indexed by the full-text search path.  Keep this
# definition next to the model write guard so a future save path cannot
# accidentally make an unrelated page edit look like fresh searchable
# content.
SEARCHABLE_CONTENT_FIELDS = frozenset({"title", "content"})


# The creator-state half of every public zPage visibility rule.
#
# `Creator.is_active` is the moderation lever: `ban_and_soft_delete()` is the
# only writer in this codebase and it flips exactly this flag (plus `is_banned`
# on the creator's Bannable relations -- Comment is Bannable, zPage is NOT).
# Deactivating therefore does not unpublish a single page, so every read path
# that serves a zPage to somebody other than its owner has to join to the
# creator and check it. Exported as a `Q` rather than only as a queryset method
# because several call sites compose visibility out of ORed `Q` objects
# (subscriber carve-out, owner-sees-drafts) and need the creator gate ANDed
# onto some arms and not others.
ACTIVE_CREATOR = models.Q(creator__is_active=True)

#The full public-visibility predicate: published AND authored by an account
#that has not been deactivated. Anything ORed on top of this (an owner's own
#drafts, a subscriber's paid access) is a deliberate carve-out.
PUBLICLY_VISIBLE = models.Q(is_published=True) & ACTIVE_CREATOR


class zPageQuerySet(models.QuerySet):
    """Visibility vocabulary shared by every zPage read path.

    : eight separate call sites each remembered `is_published=True` and
    seven of them forgot `creator__is_active=True`, so a moderation ban took
    the profile down and left every article, feed entry and sitemap URL
    serving. Naming the rule once means the next route to be written inherits
    it instead of re-deriving it.
    """

    def from_active_creators(self):
        """Drop rows whose creator has been deactivated/banned."""
        return self.filter(ACTIVE_CREATOR)

    def published_and_active(self):
        """Published pages from creators who have not been deactivated.

        This -- not `filter(is_published=True)` -- is what "a zPage the public
        may see" means. Callers that additionally hide subscriber-only pages
        chain `.filter(is_subscriber_only=False)`; callers that additionally
        show the requester their OWN drafts OR this in.
        """
        return self.filter(PUBLICLY_VISIBLE)

    def update(self, **kwargs):
        """Record effective bulk writes to searchable/publication fields.

        QuerySet updates bypass ``zPage.save()`` and its persisted-value
        comparison. Direct title/content assignments get a SQL conditional so
        a no-op write preserves the old timestamp while a mixed bulk update
        still updates its unrelated fields. Expression assignments are
        supported only when the caller supplies
        ``searchable_content_updated_at`` explicitly; the expression may
        change per row and cannot safely be classified in Python without
        loading every row. This deliberately makes ``bulk_update()`` with a
        title/content field and no explicit freshness field raise the same
        actionable ``ValueError``: Django implements ``bulk_update()`` with
        per-row ``Case`` expressions, so it cannot infer which rows changed.
        """
        searchable_updates = SEARCHABLE_CONTENT_FIELDS.intersection(kwargs)
        expression_updates = {
            field: kwargs[field]
            for field in searchable_updates
            if hasattr(kwargs[field], "resolve_expression")
            and not (
                isinstance(kwargs[field], models.F)
                and kwargs[field].name == field
            )
        }
        if expression_updates and "searchable_content_updated_at" not in kwargs:
            fields = ", ".join(sorted(expression_updates))
            raise ValueError(
                "expression bulk writes for "
                f"{fields} must set searchable_content_updated_at explicitly"
            )

        freshness_conditions = []
        if searchable_updates and not expression_updates:
            # All assignments matching means that none of the searchable
            # values changed. Q() accepts F(field) self-assignments too.
            unchanged = models.Q(
                **{
                    field: kwargs[field]
                    for field in searchable_updates
                }
            )
            freshness_conditions.append(~unchanged)
        if kwargs.get("is_published") is True:
            # Bulk publication bypasses save() and must make the canonical
            # document (and any already-published translations) fresh, but a
            # repeated publish is a no-op and must not gain recency.
            freshness_conditions.append(models.Q(is_published=False))

        if freshness_conditions and "searchable_content_updated_at" not in kwargs:
            now = timezone.now()
            kwargs["searchable_content_updated_at"] = models.Case(
                *(
                    models.When(condition, then=models.Value(now))
                    for condition in freshness_conditions
                ),
                default=models.F("searchable_content_updated_at"),
                output_field=models.DateTimeField(),
            )
        return super().update(**kwargs)



def _send_first_publication(zpage_id, using):
    """Lazy import: ``g12f.publication`` imports serializers, which import
    this module."""
    from dj.apps.g12f.publication import send_first_publication

    send_first_publication(zpage_id, using=using)

class zPage(models.Model):
    """
    PK is the free2zaddr, which is the UUID to get the zPage.
    """
    # `use_in_migrations` is deliberately left False (the default): this
    # manager exists to express read visibility, and putting it in migration
    # state would add a migration -- and a migration leaf -- for a pure
    # queryset helper.
    objects = zPageQuerySet.as_manager()

    creator = models.ForeignKey(
        'g12f.Creator', null=False, blank=False,
        # if a Creator chooses to delete themselves, so go the Pages
        on_delete=models.CASCADE,
    )
    tags = TaggableManager(blank=True)
    vanity = models.SlugField(
        blank=True, null=True, unique=True,
        help_text="Optional vanity URL field",
        max_length=128,
    )
    title = models.CharField(max_length=128, blank=False, db_index=True)
    content = models.TextField(max_length=100000)
    description = models.CharField(
        max_length=255, blank=True,
        help_text="Description for meta tag, AI if blank",
    )
    canonical_url = models.URLField(
        blank=True,
        max_length=2048,
        validators=[validate_canonical_url],
        help_text=(
            "Optional original article URL used as the canonical URL when "
            "this page republishes content from another site"
        ),
    )
    source_language = models.CharField(
        max_length=LANGUAGE_TAG_MAX_LENGTH,
        # NULL means "detection has not run yet" ( §3.2) -- the honest,
        # transient representation of not-knowing that replaces `und`. Nothing
        # writes NULL in this wave: the create path still defaults to `und` and
        # the database default is unchanged, so a rolling deploy and a rollback
        # both behave exactly as they do today. Dropping NOT NULL now is what
        # lets the detection wave ( M4) stop minting a sentinel without
        # taking another ACCESS EXCLUSIVE lock on this table.
        null=True,
        blank=True,
        default=LEGACY_UNDETERMINED_LANGUAGE,
        db_default=LEGACY_UNDETERMINED_LANGUAGE,
        db_index=True,
        help_text="Language of the canonical title, description and content.",
    )
    # Detection provenance ( §3.2). All nullable and all unread in this
    # wave -- the detector that fills them ships in P5/wave 2c. They live on
    # `zPage` rather than on the source variant because they describe how we
    # learned the *page's* language, which survives the source variant being
    # rewritten or relabelled.
    detected_language = models.CharField(
        max_length=LANGUAGE_TAG_MAX_LENGTH,
        null=True,
        blank=True,
        help_text="Most recent machine-detected language of the source text.",
    )
    detection_confidence = models.FloatField(
        null=True,
        blank=True,
        help_text="Detector confidence, 0.0-1.0. Low confidence is not an "
                  "error: it drives a soft 'is this right?' affordance, never "
                  "a block.",
    )
    detected_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="When detection last ran. NULL means it never has.",
    )
    language_source = models.CharField(
        max_length=16,
        choices=LANGUAGE_SOURCE_CHOICES,
        null=True,
        blank=True,
        help_text="Whether source_language came from the detector or from the "
                  "creator. A creator override is never overwritten by a "
                  "later detection.",
    )
    category = models.CharField(
        max_length=64,
        choices=CATEGORY_CHOICES,
        blank=True,
        default="",
    )

    # Using pk in memo methinks (shorter than UUID).
    # This could go away completely? Nah, UUID for private pages...
    free2zaddr = models.CharField(
        blank=False, max_length=128, unique=True,
        help_text="UUID to get the zPage",
    )

    tuzi_total = models.IntegerField(
        default=0, help_text="The number of 2Zs used to boost")

    # cache from transaction_set, ultimate source of truth
    total = models.DecimalField(default=0, decimal_places=8, max_digits=10)
    # TODO: remove completely
    is_funded = models.BooleanField(default=False)
    is_published = models.BooleanField(default=False, db_index=True)
    is_subscriber_only = models.BooleanField(default=False)

    is_verified = models.BooleanField(default=False)
    f2z_score = models.DecimalField(
        default=0, decimal_places=8, max_digits=20,
        help_text="Cache of rank calculation"
    )

    p2paddr = models.CharField(
        blank=True, max_length=255,
        help_text="Creator's zaddress for funding and sending private memos",
        validators=[validate_zcash_address],
    )
    featured_image: GenericFile = models.ForeignKey(
        'uploads.GenericFile', null=True, blank=True,
        on_delete=models.SET_NULL,
    )
    enclosure: GenericFile = models.ForeignKey(
        'uploads.GenericFile', null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name='enclosure_for',
    )

    # HEY! Goal could be in 2Zs:thinking:
    # Maybe never
    # https://free2z.cash/saying-goodbye-to-viewing-key-features-for-now
    # https://forum.zcashcommunity.com/t/zcash-regexes/41381
    viewing_key = models.CharField(max_length=512, blank=True)
    vk_updated_at = models.DateTimeField(
        null=True, help_text="last time VK was read and updated")
    goal = models.DecimalField(
        decimal_places=8,
        max_digits=11,
        null=True,
        blank=True,
        default=None,
    )
    poll = models.OneToOneField(
        'g12f.Poll', blank=True, null=True,
        on_delete=models.PROTECT,
    )
    ###

    # TODO: never used password per-page but may be an idea there
    password = models.CharField(
        max_length=256, blank=True,
        help_text="Hashed and salted password to edit page"
    )

    #
    # ############################################################
    # optional_private_free_contact = models.TextField(
    #     default="", blank=True, max_length=5000,
    #     help_text="If you want to explain how we can get in touch with you.")

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True, db_index=True)
    searchable_content_updated_at = models.DateTimeField(
        null=True,
        blank=True,
        editable=False,
        help_text=(
            "Most recent change to the title or body used by search ranking. "
            "NULL is retained as a safe fallback for rolling deployments."
        ),
    )
    publish_at = models.DateTimeField(null=True, blank=True)
    # The first time a page becomes public.  Unlike updated_at this never
    # changes when the author edits an already-published page.  Existing rows
    # are backfilled from created_at by the migration; the model fallback keeps
    # old/partially migrated rows orderable while the rollout completes.
    published_at = models.DateTimeField(
        null=True, blank=True,
    )
    # Set exactly once, as part of the first real publication transaction.
    # This is separate from published_at because old rows and republished
    # pages must not cause a second mention pass.
    mention_notifications_processed_at = models.DateTimeField(
        null=True, blank=True, editable=False,
    )

    class Meta:
        verbose_name = "zPage"
        verbose_name_plural = "zPages"
        # ordering = ["-f2z_score", "-created_at"]
        indexes = [
            models.Index(fields=['vanity']),
            models.Index(fields=['title']),
            models.Index(fields=['is_published']),
            models.Index(fields=['updated_at']),
            models.Index(fields=['featured_image_id']),
            models.Index(fields=['creator_id']),
            models.Index(fields=['is_published', 'title', 'vanity', 'updated_at']),
            models.Index(fields=['is_published', 'title', 'vanity', 'f2z_score']),
            # Partial index for the "Creators to watch" discovery aggregate:
            # counting/qualifying by published pages per creator. Indexing only
            # the published rows keeps it small and makes the discovery
            # GROUP-BY/HAVING cheap without bloating writes for drafts.
            models.Index(
                fields=['creator_id'],
                condition=models.Q(is_published=True),
                name='g12f_zpage_pub_creator_idx',
            ),
            # Public latest-feed pagination: deterministic order for rows that
            # share a created_at timestamp, without indexing draft rows.
            models.Index(
                fields=['-created_at', '-id'],
                condition=models.Q(is_published=True),
                name='g12f_zpage_pub_latest_idx',
            ),
            # Public chronological feeds order by the immutable publication
            # moment; the migration backfills every existing published row.
            models.Index(
                Coalesce('published_at', 'created_at').desc(),
                models.F('id').desc(),
                condition=models.Q(is_published=True),
                name='g12f_zpage_pub_published_idx',
            ),
            # An authenticated non-mine feed also includes the requesting
            # creator's drafts. Its ``is_published OR creator_id`` predicate
            # cannot use the public partial index above, so retain a full
            # chronological index for the global authenticated homepage.
            models.Index(
                Coalesce('published_at', 'created_at').desc(),
                models.F('id').desc(),
                name='g12f_zpage_chrono_idx',
            ),
            # A creator's own public profile can include their drafts. The
            # leading creator key keeps that profile path from walking the
            # global chronological index until it happens to find their rows.
            models.Index(
                models.F('creator_id'),
                Coalesce('published_at', 'created_at').desc(),
                models.F('id').desc(),
                name='g12f_zpage_creator_chrono_idx',
            ),
        ]

    def __str__(self) -> str:
        # remove when DB is clean and validation is good
        z = "XXXXXX"
        if self.free2zaddr:
            z = self.free2zaddr[:8]
        return f"{z} - {self.title}"

    # TODO: rm page-level password completely
    def save(self, *args, **kwargs) -> None:
        # hacky, easy way to enforce salt/hash
        if not self.password.startswith("pbkdf2_sha256"):
            self.password = make_password(self.password)
        if not self.vanity:
            self.vanity = None
        # Capture publication once.  A later unpublish/re-publish keeps the
        # original timestamp so edits (or a rescheduled page) cannot make an
        # old publication jump to the top of chronological feeds.
        update_fields = kwargs.get("update_fields")
        if update_fields is not None:
            # Normalize once before inspecting it: callers may pass any
            # iterable, including a generator that membership testing would
            # otherwise consume before Django receives it.
            update_fields = set(update_fields)
            kwargs["update_fields"] = update_fields
        writes_searchable_content = (
            update_fields is None
            or bool(SEARCHABLE_CONTENT_FIELDS & update_fields)
        )
        # ``update_fields`` can intentionally leave an in-memory publication
        # state change out of the SQL UPDATE. Do not capture a durable first
        # publication timestamp until this save actually writes
        # ``is_published``; otherwise a title-only save could stamp a draft
        # years before its real public transition.
        writes_publication_state = (
            update_fields is None
            or bool({"is_published", "published_at"} & update_fields)
        )
        writes_is_published = (
            update_fields is None or "is_published" in update_fields
        )
        writes_mention_marker = (
            update_fields is None
            or "mention_notifications_processed_at" in update_fields
        )

        # A full save from a stale editor can race publish_zpage(): the task
        # writes the publication state with QuerySet.update(), while the
        # editor later sends its old is_published=False/published_at=None.
        # Lock the row for the whole read-and-save sequence so the timestamp
        # protection previously supplied by the database trigger remains in
        # application code. Title/content targeted saves also take this lock
        # because their persisted comparison and timestamp update must use one
        # snapshot. Metadata-only targeted saves still avoid the lock. Do not
        # restore is_published here: an explicit unpublish is still supported.
        if (
            (
                writes_publication_state
                or writes_searchable_content
                or writes_mention_marker
            )
            and not self._state.adding
            and self.pk is not None
        ):
            using = kwargs.get("using") or self._state.db
            if using is None:
                using = router.db_for_write(type(self), instance=self)
            with transaction.atomic(using=using):
                first_publication = False
                manager = type(self)._base_manager.using(using)
                persisted = manager.select_for_update().filter(
                    pk=self.pk,
                ).values(
                    "is_published", "published_at", "created_at",
                    "title", "content", "searchable_content_updated_at",
                    "mention_notifications_processed_at",
                ).first()
                if persisted:
                    # The mention pass uses a queryset UPDATE while this
                    # instance may have been read by an older editor. A
                    # stale full save must never turn the monotonic marker
                    # back into NULL and make a later edit notify again.
                    self.mention_notifications_processed_at = persisted[
                        "mention_notifications_processed_at"
                    ]
                    if writes_searchable_content:
                        fields_to_compare = (
                            SEARCHABLE_CONTENT_FIELDS
                            if update_fields is None
                            else SEARCHABLE_CONTENT_FIELDS & update_fields
                        )
                        if any(
                            getattr(self, field) != persisted[field]
                            for field in fields_to_compare
                        ):
                            self.searchable_content_updated_at = timezone.now()
                            if update_fields is not None:
                                update_fields.add(
                                    "searchable_content_updated_at"
                                )
                        elif update_fields is None:
                            # A full stale-instance save must not erase a
                            # newer translation/content freshness update.
                            self.searchable_content_updated_at = (
                                persisted["searchable_content_updated_at"]
                            )
                    if persisted["is_published"]:
                        # The old trigger always restored the committed
                        # publication event, even if a stale caller supplied
                        # a different non-null timestamp.
                        self.published_at = (
                            persisted["published_at"]
                            or persisted["created_at"]
                            or timezone.now()
                        )
                    elif writes_is_published and self.is_published:
                        # This is the first transition from draft to public.
                        # Keep an explicitly supplied timestamp, matching the
                        # trigger's COALESCE(OLD.published_at, NEW...).
                        #
                        # "First EVER" only when nothing was captured before:
                        # a page that was published, unpublished and is now
                        # republished keeps its published_at and must not
                        # re-announce.
                        first_publication = persisted["published_at"] is None
                        self.searchable_content_updated_at = timezone.now()
                        if update_fields is not None:
                            update_fields.add("searchable_content_updated_at")
                        self.published_at = (
                            persisted["published_at"]
                            or self.published_at
                            or timezone.now()
                        )
                    if (
                        self.published_at is not None
                        and update_fields is not None
                    ):
                        kwargs["update_fields"] = (
                            update_fields | {"published_at"}
                        )
                result = super().save(*args, **kwargs)
                if first_publication:
                    _send_first_publication(self.pk, using)
                return result

        if self._state.adding:
            self.searchable_content_updated_at = timezone.now()
            if update_fields is not None:
                kwargs["update_fields"] = (
                    update_fields | {"searchable_content_updated_at"}
                )

        # A page INSERTED already public is a first publication too.
        # An existing row reaches this branch only for saves that write
        # neither publication state nor searchable content, which cannot be
        # a draft -> public transition.
        first_publication = bool(
            self._state.adding
            and self.is_published
            and self.published_at is None
            and writes_is_published
        )
        if (
            self.is_published
            and self.published_at is None
            and writes_is_published
        ):
            self.published_at = timezone.now()
            if update_fields is not None:
                kwargs["update_fields"] = update_fields | {"published_at"}
        if not first_publication:
            return super().save(*args, **kwargs)
        using = kwargs.get("using") or router.db_for_write(
            type(self), instance=self,
        )
        with transaction.atomic(using=using):
            result = super().save(*args, **kwargs)
            _send_first_publication(self.pk, using)
        return result

    def get_featured_image(self) -> str:
        """
        don't forget to prepend domain if needed
        this is used for social sharing
        """
        if self.featured_image:
            return self.featured_image.get_thumbnail()
        else:
            return default_logo_url()

    def get_p2paddr(self) -> str:
        """The EFFECTIVE support address: this page's own, else the creator's."""
        return self.p2paddr or self.creator.p2paddr

    @property
    def p2paddr_override(self) -> str | None:
        """This page's OWN address, or ``None`` when it inherits.

        ``get_p2paddr`` answers "where does support go"; this answers "did the
        creator pick an address for this page". An editor needs the second:
        hydrating the address field from the effective value and saving it
        back pins the creator's current profile address onto the page, and a
        later profile address change then never reaches it.
        """
        return self.p2paddr or None

    def html_content(self) -> str:
        return markdown2.markdown(self.content)

    @property
    def total_raised(self) -> decimal.Decimal:
        return self.viewedtxs.aggregate(
            models.Sum('amount')
        )['amount__sum'] or 0

    def set_password(self, raw) -> None:
        self.password = make_password(raw)
        self.save()

    def check_password(self, raw) -> bool:
        return check_password(raw, self.password)


    # deprecated
    def get_score(self) -> decimal.Decimal:
        # {'amount__sum': Decimal('0.80232887')}
        donations = self.transaction_set.all().aggregate(
            models.Sum('amount')
        )['amount__sum']

        factor = 1
        if self.is_verified:
            factor = 3

        return donations * factor

    def cache_total(self):
        old_total = self.total
        old_f2z_score = self.f2z_score

        from django.db.models import Sum

        # Old Zcash votes and comments
        upvotes = self.transaction_set.filter(
            action__in=["page_fund", "page_comment"])
        downvotes = self.transaction_set.filter(
            action__in=["page_defund", "page_decomment"])
        up = upvotes.aggregate(Sum('amount'))['amount__sum'] or 0
        down = downvotes.aggregate(Sum('amount'))['amount__sum'] or 0

        total = up - down
        self.total = total

        # Calculate f2z_score
        # total is ZEC in
        total = total * 1000

        # Count threaded Comments
        content_type = ContentType.objects.get_for_model(self)
        object_id = self.id
        comment_tuzis = Comment.objects.filter(
            content_type=content_type,
            object_id=object_id,
        ).aggregate(
            tuzis__sum=AbsoluteSum('tuzis')
        )['tuzis__sum'] or 0

        # print("COMMENT", comment_tuzis)
        # Add page tuzis
        f2z_score = total + decimal.Decimal(self.tuzi_total) + comment_tuzis

        # print("rawf2z", f2z_score)
        # TODO: add Twitter...
        if self.is_verified:
            f2z_score = f2z_score * 3

        # print("veri", f2z_score)
        # Update page bonus - 10 for same day, decays to 0 in 10 days
        f2z_score = f2z_score * 10
        now = timezone.now()
        days_since_update = (
            now - self.updated_at
        ).days + 1
        f2z_score = f2z_score / min([days_since_update, 10])

        if self.featured_image:
            f2z_score = f2z_score * 3

        self.f2z_score = f2z_score

        if (
            quantize_decimal(old_total) != quantize_decimal(self.total)
        ) or (
            quantize_decimal(old_f2z_score) != quantize_decimal(self.f2z_score)
        ):
            print("cache_total SAVING", self.total,
                  self.f2z_score, old_total, old_f2z_score)
            self.save(update_fields=['total', 'f2z_score'])

        # if old_total != self.total or old_f2z_score != self.f2z_score:
        #     print("cache_total SAVING", self.total,
        #           self.f2z_score, old_total, old_f2z_score)
        #     self.save(update_fields=[
        #         'total', 'f2z_score',
        #     ])

    # Content object methods
    def get_url(self):
        return f"/{self.creator.username}/zpage/{self.vanity or self.free2zaddr}"

    get_absolute_url = get_url

    def get_public_url(self):
        """Canonical public URL, escaping product-route collisions.

        This is the shape the sitemap publishes (``lib/server/sitemap.ts``)
        and the one the SvelteKit UI declares canonical; ``get_url`` above is
        the pre- ``/{username}/zpage/{...}`` shape, which SvelteKit now
        301s here. ``get_url`` is left alone on purpose: it is serialized to
        API clients as the ``get_url`` field, so changing it is an API
        contract change, not an SEO fix.
        """
        return canonical_zpage_path(
            self.creator.username,
            self.vanity,
            self.free2zaddr,
        )

    def get_content_for_ai_tagging(self):
        return f"{self.title} {self.content[:3000]}"


class ZPageTranslation(models.Model):
    """A non-source-language content variant for one logical zPage.

    .. deprecated::  M2

        Superseded by:class:`ZPageVariant`, which stores the source *and*
        every translation in one shape. This table is still the read path and
        still the write path -- ``ZPageVariant`` is populated alongside it
        (M3 dual-write) and read by nothing yet.  M8 drops this model.
    """

    zpage = models.ForeignKey(
        zPage,
        on_delete=models.CASCADE,
        related_name="translations",
    )
    language = models.CharField(max_length=LANGUAGE_TAG_MAX_LENGTH)
    title = models.CharField(max_length=128)
    content = models.TextField(max_length=100000)
    description = models.CharField(max_length=255, blank=True)
    is_published = models.BooleanField(default=False, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["language"]
        constraints = [
            models.UniqueConstraint(
                fields=["zpage", "language"],
                name="g12f_unique_zpage_translation_language",
            ),
        ]
        indexes = [
            models.Index(
                fields=["zpage", "is_published"],
                name="g12f_zpage_translation_pub_idx",
            ),
        ]

    def __str__(self):
        return f"{self.zpage_id}:{self.language} - {self.title}"


class ZPageVariant(models.Model):
    """One language of one zPage. The source is a variant too ( §3.1).

    The whole point is that there is no longer an asymmetry between "the
    original" (columns on ``zPage``) and "a translation" (a row in
    ``ZPageTranslation``). Every language is a row here, and exactly one of
    them carries ``origin="source"``. That symmetry is what makes
    ``source_language`` mutable, makes a variant deletable, and removes the
    ``und`` special cases from resolution.

    **This table is written but not read.**  M3 dual-writes it alongside
    the legacy columns so the two shapes stay in step; M5 flips reads over
    behind a flag; M8 drops the legacy shape. Until M5, a bug here cannot
    affect a reader -- which is the entire reason the rollout is staged this
    way.
    """

    SOURCE = "source"
    HUMAN = "human"
    AI = "ai"
    ORIGIN_CHOICES = (
        (SOURCE, "Source"),
        (HUMAN, "Human translation"),
        (AI, "AI translation"),
    )

    zpage = models.ForeignKey(
        zPage,
        on_delete=models.CASCADE,
        related_name="variants",
    )
    language = models.CharField(
        max_length=LANGUAGE_TAG_MAX_LENGTH,
        help_text="BCP-47 tag, validated against f2z.languages.",
    )
    title = models.CharField(max_length=128)
    description = models.CharField(max_length=255, blank=True)
    content = models.TextField(max_length=100000)
    is_published = models.BooleanField(default=False, db_index=True)

    origin = models.CharField(
        max_length=16,
        choices=ORIGIN_CHOICES,
        default=HUMAN,
        help_text="Where this variant's text came from. Exactly one variant "
                  "per zPage is the source.",
    )
    ai_model = models.ForeignKey(
        "openai.AIModel",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
        help_text="The model that produced this variant, when origin='ai'. "
                  "SET_NULL because retiring a model must never delete a "
                  "creator's content.",
    )

    source_digest = models.CharField(
        max_length=64,
        null=True,
        blank=True,
        help_text=(
            "SHA-256 of the source variant's content this variant was "
            "translated from. Three states, and callers MUST honour all "
            "three: NULL on the source variant itself (it has no source); "
            "NULL on a variant whose provenance we never recorded (every row "
            "the #980 M2 backfill created from a legacy ZPageTranslation) -- "
            "that is *unknown*, not *stale*; and a digest that either matches "
            "the current source content (fresh) or does not (stale). "
            "Rendering NULL as 'Stale' would fire on ~100% of existing "
            "translations, which is the #805 mistake."
        ),
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["language"]
        constraints = [
            models.UniqueConstraint(
                fields=["zpage", "language"],
                name="uniq_zpage_variant_language",
            ),
            # A partial unique index: at most one source variant per zPage.
            # This is what makes "change the source language" a single UPDATE
            # of one row rather than a reconciliation between two tables.
            models.UniqueConstraint(
                fields=["zpage"],
                condition=models.Q(origin="source"),
                name="uniq_zpage_source_variant",
            ),
        ]
        indexes = [
            models.Index(
                fields=["zpage", "is_published"],
                name="g12f_zpage_variant_pub_idx",
            ),
        ]

    def __str__(self):
        return f"{self.zpage_id}:{self.language} ({self.origin})"


class ZPageMutationActor(models.Model):
    """Durable actor evidence for authenticated zPage mutation boundaries.

    These identifiers intentionally have no foreign keys: a deletion event
    must remain queryable after the page and its creator have been cascaded
    away. Queryset/raw SQL writes do not create these rows and stay unknown.
    """

    SOURCE_CONTENT = "source_content"
    SOURCE_LANGUAGE = "source_language"
    VARIANT_CONTENT = "variant_content"
    VARIANT_PUBLISHED = "variant_published"
    VARIANT_UNPUBLISHED = "variant_unpublished"
    VARIANT_DELETED = "variant_deleted"
    PAGE_DELETED = "page_deleted"
    OWNERSHIP_CHANGED = "ownership_changed"
    ACTION_CHOICES = (
        (SOURCE_CONTENT, "Canonical content changed"),
        (SOURCE_LANGUAGE, "Source language changed"),
        (VARIANT_CONTENT, "Translation content changed"),
        (VARIANT_PUBLISHED, "Translation published"),
        (VARIANT_UNPUBLISHED, "Translation unpublished"),
        (VARIANT_DELETED, "Translation deleted"),
        (PAGE_DELETED, "Page deleted"),
        (OWNERSHIP_CHANGED, "Page ownership changed"),
    )

    # Deliberately plain numeric values rather than FKs. See class docstring.
    zpage_id = models.PositiveBigIntegerField()
    actor_id = models.PositiveBigIntegerField()
    action = models.CharField(max_length=32, choices=ACTION_CHOICES)
    language = models.CharField(max_length=64, blank=True, default="")
    state_digest = models.CharField(max_length=64, blank=True, default="")
    occurred_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(
                fields=["zpage_id", "occurred_at"],
                name="g12f_zp_actor_page_time_idx",
            ),
            models.Index(
                fields=["actor_id", "occurred_at"],
                name="g12f_zp_actor_user_time_idx",
            ),
            models.Index(
                fields=["occurred_at"],
                name="g12f_zp_actor_time_idx",
            ),
        ]
