import uuid

from django.db import models, transaction
from django.conf import settings
from django.contrib.contenttypes.fields import GenericForeignKey
from django.contrib.contenttypes.models import ContentType
from django.utils.text import Truncator
from django.utils.translation import gettext_lazy as _

from taggit.managers import TaggableManager
from taggit.models import GenericUUIDTaggedItemBase, TaggedItemBase


from dj.apps.g12f.models.creator import Bannable


class UUIDTaggedItem(GenericUUIDTaggedItemBase, TaggedItemBase):
    # If you only inherit GenericUUIDTaggedItemBase, you need to define
    # a tag field. e.g.
    # tag = models.ForeignKey(Tag, related_name="uuid_tagged_items", on_delete=models.CASCADE)

    class Meta:
        verbose_name = _("Tag")
        verbose_name_plural = _("Tags")


# Headlines older clients wrote instead of leaving the field empty: the new
# Svelte UI sent "N/A" on every comment and reply, the classic React reply flow
# sent "re". Migration comments.0006 blanked the stored ones, but a rolled-back
# pod or a cached client can still send one, so everything that *displays* a
# headline keeps filtering them.
PLACEHOLDER_HEADLINES = frozenset({'n/a', 're'})

SOCIAL_DESCRIPTION_CHARS = 200


class Comment(Bannable):
    uuid = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4, editable=False, unique=True)

    # Fields for the comment content and metadata
    # Optional. Plain comments and replies have no headline at all:
    # only a converse "conversation" (a top-level post) gets a title. Historic
    # rows carried the literal placeholders "N/A"/"re" instead of an empty
    # string; migration 0006 blanks those.
    headline = models.CharField(max_length=100, blank=True, default='')
    content = models.TextField(max_length=1000)
    tuzis = models.IntegerField(default=1)

    author = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    # Foreign key to the parent comment (if this is a reply)
    parent = models.ForeignKey(
        'self', null=True, blank=True, on_delete=models.CASCADE,
        related_name='replies', to_field='uuid',
    )

    # Generic foreign key to the content that the comment is on
    content_type = models.ForeignKey(
        ContentType, on_delete=models.CASCADE, null=True, blank=True)
    # object_id = models.PositiveIntegerField(null=True, blank=True)
    object_id = models.TextField(null=True, blank=True)
    content_object = GenericForeignKey('content_type', 'object_id')
    tags = TaggableManager(through=UUIDTaggedItem)

    class Meta:
        ordering = ['-tuzis', '-created_at']

    def __str__(self):
        return f'Comment by {self.author} on {self.created_at}'

    def get_url(self):
        return f"/converse/{self.uuid}"

    @property
    def display_headline(self) -> str:
        """The headline worth showing, or '' — placeholders filtered out."""
        headline = (self.headline or '').strip()
        if headline.lower() in PLACEHOLDER_HEADLINES:
            return ''
        return headline

    @property
    def social_description(self) -> str:
        """Text for og:/twitter: description on the /converse/<uuid> card.

        Plain comments have no headline any more, and an empty
        og:description is a blank social card, so fall back to the start of
        the comment body.
        """
        headline = self.display_headline
        if headline:
            return headline
        return Truncator(' '.join((self.content or '').split())).chars(
            SOCIAL_DESCRIPTION_CHARS
        )

    def get_content_for_ai_tagging(self) -> str:
        from .visibility import author_redacted, tagging_content_owner_active

        parent_context = self.parent.get_content_for_ai_tagging() if self.parent else ""
        # A thread placeholder must not disclose its author's text to the
        # tagger either. Keep walking so visible ancestors still give context.
        if author_redacted(self):
            return parent_context
        content_object = self.content_object
        object_context = (
            content_object.get_content_for_ai_tagging()
            if tagging_content_owner_active(content_object) else ""
        )
        # TODO: if the comment is very deeply nested the context could
        # get too big... but, I don't think we've seen that yet
        return f"""
        {f"Parent comment: {parent_context}" if parent_context else ""}
        {f"Content object: {object_context}" if object_context else ""}

        Comment:
        {self.display_headline}

        {self.content}
        """


class CommentConsumerClaim(models.Model):
    """Permanent at-most-once claim for an external comment consumer.

    A comment has several independent subscribers, each with its own side
    effect.  The consumer name is therefore part of the key: claiming a
    comment for tagging must not suppress its tweet (or its score).

    The row is committed before the consumer calls an external provider.  A
    unique constraint makes concurrent deliveries wait for that commit and
    then lose the race without paying for a second call.  Claims are
    intentionally permanent and are not stale-taken-over: after an external
    call starts, PostgreSQL cannot tell whether a crashed process made the
    call, so retrying an old claim could duplicate a paid or public effect.
    This is an at-most-once boundary; a crash after the claim commits but
    before the external effect may leave the promised effect undone and
    require operator reconciliation.

    There is deliberately no completion column: existence proves only that
    this consumer claimed the comment, not that its external effect succeeded.
    Ambiguous failures are logged with the comment UUID and consumer so an
    operator can reconcile them without retrying blindly.
    """

    comment = models.ForeignKey(
        Comment,
        on_delete=models.CASCADE,
        related_name="consumer_claims",
    )
    consumer = models.CharField(max_length=32)
    claimed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["comment", "consumer"],
                name="comments_consumer_claim_uniq",
            ),
        ]
        indexes = [
            models.Index(
                fields=["consumer", "claimed_at"],
                name="comments_claim_consumer_idx",
            ),
        ]

    def __str__(self):
        return f"{self.consumer}:{self.comment_id}"


def claim_comment_consumer(comment, consumer: str) -> bool:
    """Durably claim one comment for one external consumer.

    ``get_or_create`` delegates the race to the database uniqueness
    constraint rather than making an application-level exists/create pair.
    Its internal savepoint also leaves the caller's connection usable when a
    concurrent delivery wins the insert.
    """
    using = comment._state.db or "default"
    if not transaction.get_autocommit(using):
        raise RuntimeError(
            "comment consumer claims must commit before external work; "
            "call claim_comment_consumer outside an outer transaction"
        )
    with transaction.atomic(using=using):
        _claim, created = CommentConsumerClaim.objects.using(using).get_or_create(
            comment_id=comment.pk,
            consumer=consumer,
        )
    return created


class ContentReport(models.Model):
    """Private intake retained independently of target deletion; no content copy."""
    class Reason(models.TextChoices):
        CSAE = 'csae', 'Child sexual abuse or exploitation'
        HARASSMENT = 'harassment', 'Harassment or threats'
        HATE = 'hate', 'Hateful content'
        SEXUAL = 'sexual', 'Sexual content'
        VIOLENCE = 'violence', 'Violence'
        SPAM = 'spam', 'Spam or scam'
        OTHER = 'other', 'Other'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reporter = models.ForeignKey(settings.AUTH_USER_MODEL, null=True,
                                 on_delete=models.SET_NULL, related_name='content_reports')
    target_kind = models.CharField(max_length=10, choices=[
        ('comment', 'Comment'), ('zpage', 'zPage'), ('creator', 'Creator')])
    target_id = models.CharField(max_length=150)
    reason = models.CharField(max_length=20, choices=Reason.choices)
    details = models.TextField(max_length=2000, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    status = models.CharField(max_length=12, default='open', choices=[
        ('open', 'Open'), ('reviewing', 'Reviewing'), ('resolved', 'Resolved')])
    staff_notes = models.TextField(blank=True, default='')

    class Meta:
        constraints = [models.UniqueConstraint(
            fields=['reporter', 'target_kind', 'target_id', 'reason'],
            name='unique_reporter_target_reason')]
        indexes = [models.Index(fields=['reporter', 'created_at']),
                   models.Index(fields=['status', 'reason', 'created_at'])]
