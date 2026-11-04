"""The free, non-billing creator relationship.

``Subscription`` is the only other creator-to-creator relationship in this app
and it is a **paid** one: it moves 2Z, carries ``expires``/``max_price``, and
its DELETE only zeroes the renewal ceiling while leaving subscriber entitlement
live until expiry. Reusing it for a "Follow" button would make a free gesture
perform a paid operation, and would make "Unfollow" not actually remove the
relationship. So Follow is its own row, with no monetary field on it at all,
and nothing in this module reads or writes ``tuzis``, ``Subscription``, or
``member_price``.

Follow is also deliberately orthogonal to ``Creator.member_price``: a creator
who changes their price must not have their existing follower history
rewritten.
"""

from django.db import models


class CreatorFollow(models.Model):
    """``follower`` follows ``creator``. Directional; free; no entitlement."""

    #The account doing the following. ``CASCADE`` because a follow has no
    #meaning once either side of the pair is gone -- unlike a Subscription,
    #there is no payment record to preserve here.
    # ``db_index=False`` on both FKs, and no index on ``created_at``, on
    # purpose. Django's default would add three more single-column indexes to
    # a four-column table, and every one of them is dead weight here:
    #
    # * ``follower_id`` alone is a redundant leading prefix of the unique
    #   ``(follower, creator)`` index, which already answers every
    #   follower-scoped lookup and the CASCADE delete.
    # * ``creator_id`` alone is a redundant leading prefix of
    #   ``g12f_follow_creator_idx (creator, follower)``, same story.
    # * ``created_at`` is never queried unscoped -- the list is always
    #   ``follower=`` then ordered, and both counts are always
    #   ``creator=``/``follower=`` -- so an index on it is only ever written,
    #   never read.
    #
    # Follow/unfollow is the write path, so those three cost an index write
    # each on every PUT and DELETE for nothing. Doing this now is free; doing
    # it later means a ``DROP INDEX CONCURRENTLY`` on a populated table.
    follower = models.ForeignKey(
        'g12f.Creator', on_delete=models.CASCADE,
        related_name='creator_follows',
        db_index=False,
        help_text="The account that follows.",
    )
    creator = models.ForeignKey(
        'g12f.Creator', on_delete=models.CASCADE,
        related_name='creator_followers',
        db_index=False,
        help_text="The account being followed.",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        # Newest first, with the primary key as the tiebreaker so a page
        # boundary cannot duplicate or drop a row when two follows share a
        # timestamp (auto_now_add is not unique).
        ordering = ['-created_at', '-id']
        constraints = [
            # The uniqueness is what makes PUT idempotent *in the database*
            # rather than only in the view: two concurrent PUTs from the same
            # user cannot both insert. The view uses get_or_create, which
            # relies on exactly this constraint to resolve the race.
            models.UniqueConstraint(
                fields=['follower', 'creator'],
                name='g12f_creatorfollow_unique_pair',
                violation_error_message="Already following this creator.",
            ),
            # Self-follow is refused in the view with a 400 so the client gets
            # a usable message, but it is refused HERE too: the view is not the
            # only writer (admin, shell, a future importer), and a self-follow
            # row would inflate a creator's own follower count forever.
            models.CheckConstraint(
                condition=~models.Q(follower=models.F('creator')),
                name='g12f_creatorfollow_no_self_follow',
                violation_error_message="A creator cannot follow themselves.",
            ),
        ]
        indexes = [
            # The two count queries the follow-state endpoint runs on every
            # GET/PUT/DELETE. Without these each one is a sequential scan of
            # the whole table. The unique constraint already covers
            # (follower, creator) lookups, so only the reverse direction needs
            # its own index.
            models.Index(
                fields=['creator', 'follower'],
                name='g12f_follow_creator_idx',
            ),
        ]

    def __str__(self) -> str:
        return f"{self.follower} follows {self.creator}"


class CreatorBlock(models.Model):
    """A directional block used by notification and future social features."""

    blocker = models.ForeignKey(
        'g12f.Creator', on_delete=models.CASCADE,
        related_name='creator_blocks_made', db_index=False,
    )
    blocked = models.ForeignKey(
        'g12f.Creator', on_delete=models.CASCADE,
        related_name='creator_blocks_received', db_index=False,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['blocker', 'blocked'],
                name='g12f_creatorblock_unique_pair',
            ),
            models.CheckConstraint(
                condition=~models.Q(blocker=models.F('blocked')),
                name='g12f_creatorblock_no_self_block',
            ),
        ]
        indexes = [
            models.Index(fields=['blocker', 'blocked'], name='g12f_block_pair_idx'),
        ]


class CreatorMute(models.Model):
    """A directional mute used by notification delivery."""

    muter = models.ForeignKey(
        'g12f.Creator', on_delete=models.CASCADE,
        related_name='creator_mutes_made', db_index=False,
    )
    muted = models.ForeignKey(
        'g12f.Creator', on_delete=models.CASCADE,
        related_name='creator_mutes_received', db_index=False,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['muter', 'muted'],
                name='g12f_creatormute_unique_pair',
            ),
            models.CheckConstraint(
                condition=~models.Q(muter=models.F('muted')),
                name='g12f_creatormute_no_self_mute',
            ),
        ]
        indexes = [
            models.Index(fields=['muter', 'muted'], name='g12f_mute_pair_idx'),
        ]


class PageMentionDelivery(models.Model):
    """One durable sent delivery for one page/recipient pair.

    Sent rows are the rolling-limit and cooldown accounting. The nullable page
    link preserves that accounting after content deletion without preventing a
    creator from deleting a page; suppressed candidates are aggregate telemetry
    only, so a large page cannot create an unbounded ledger.
    """

    SENT = 'sent'
    INACTIVE = 'inactive'
    SELF = 'self'
    PAGE_CAP = 'page_cap'
    UNAUTHORIZED = 'unauthorized'
    BLOCKED = 'blocked'
    MUTED = 'muted'
    OPTED_OUT = 'opted_out'
    DAILY_CAP = 'daily_cap'
    COOLDOWN = 'cooldown'
    STATUS_CHOICES = [(value, value) for value in (
        SENT, INACTIVE, SELF, PAGE_CAP, UNAUTHORIZED, BLOCKED, MUTED,
        OPTED_OUT, DAILY_CAP, COOLDOWN,
    )]

    zpage = models.ForeignKey(
        # Delivery accounting must survive deletion of the content that
        # caused it; only the optional page link is disposable.
        'g12f.zPage', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='mention_deliveries', db_index=False,
    )
    author = models.ForeignKey(
        'g12f.Creator', on_delete=models.CASCADE,
        related_name='page_mention_deliveries_sent', db_index=False,
    )
    recipient = models.ForeignKey(
        'g12f.Creator', on_delete=models.CASCADE,
        related_name='page_mention_deliveries_received', db_index=False,
    )
    status = models.CharField(max_length=24, choices=STATUS_CHOICES)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['zpage', 'recipient'],
                name='g12f_page_mention_unique_recipient',
            ),
        ]
        indexes = [
            models.Index(
                fields=['author', 'status', 'created_at'],
                name='g12f_mention_author_window_idx',
            ),
            models.Index(
                fields=['author', 'recipient', 'status', 'created_at'],
                name='g12f_mention_pair_window_idx',
            ),
        ]
