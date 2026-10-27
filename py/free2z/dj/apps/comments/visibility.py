"""Comment-thread visibility — a comment is only as visible as its parent.

The comments app attaches a comment (through a ``GenericForeignKey``) to one of
three things:

* nothing at all — a top-level *converse* post (``content_type IS NULL``),
  which is microblog content that stays public only while its **author's
  account is active**;
* a ``zPage`` — the comment thread under a page;
* an AI ``Conversation`` — the comment thread under a conversation.

Historically the view layer derived comment visibility from almost nothing: the
``zpage`` thread needed only a non-empty ``vanity`` slug and the
``ai_conversation`` thread needed *nothing at all*. So a leaked or guessed parent
id exposed — and let anyone write into — the comment thread on unpublished
drafts, subscriber-only pages and private AI conversations (issues, ),
and ``GET /api/comments/`` bulk-returned every comment on the platform including
those threads.

This module is the single predicate every comment read/write path routes
through. The rule lives in exactly one place and **fails closed** for any parent
type it does not explicitly understand.
"""
from django.contrib.contenttypes.models import ContentType
from django.db.models import Exists, OuterRef, Q, TextField
from django.db.models.functions import Cast
from django.utils import timezone

from dj.apps.g12f.models import zPage
from dj.apps.g12f.models.creator import Subscription
from dj.apps.openai.models import Conversation
from dj.apps.openai.visibility import (
    conversation_subscriber_visible,
    public_conversation_q,
)


# Labels are intentionally distinct from uploads' access labels. This keeps
# drf-spectacular's stable ThreadAccessEnum override from collapsing the two
# public schemas into one component.
COMMENT_THREAD_ACCESS_CHOICES = (
    ("public", "Public thread"),
    ("members", "Members thread"),
    ("private", "Private thread"),
)


def _auth_user(user):
    """Return ``user`` only when it is a real authenticated user, else ``None``."""
    if user is not None and getattr(user, "is_authenticated", False):
        return user
    return None


# --------------------------------------------------------------------------
# Single-object predicates
# --------------------------------------------------------------------------


def zpage_visible(page: zPage, user) -> bool:
    """Is ``page`` visible to ``user`` — the same rule ``zPageView`` enforces.

    Owner sees any state; everyone else needs it published, authored by an
    account that has not been deactivated, and — for a subscriber-only
    page — an active subscription to the creator.

    The owner check comes first and reads ``creator_id``, so the ``creator``
    dereference below (one query when the caller did not ``select_related``)
    only happens for a non-owner, which is the only caller it can change the
    answer for.
    """
    u = _auth_user(user)
    if u is not None and page.creator_id == u.id:
        return True
    if not page.is_published:
        return False
    if not page.creator.is_active:
        return False
    if page.is_subscriber_only:
        if u is None:
            return False
        return Subscription.objects.filter(
            fan=u, star_id=page.creator_id, expires__gte=timezone.now()
        ).exists()
    return True


def conversation_visible(conversation: Conversation, user) -> bool:
    """Is ``conversation`` visible to ``user`` — the exact rule the conversation
    endpoints enforce.

    Private conversations remain visible only to their owner. Public
    conversations additionally require an active owner and, when
    ``is_subscriber_only`` is set, an active subscription.  (Closes )
    made that a real, enforced access tier, so the comment thread under a
    public-but-subscriber-only conversation must obey the same rule or the
    paywall leaks one layer over (issues  and ). The subscriber half
    is delegated to
    :func:`dj.apps.openai.visibility.conversation_subscriber_visible` — the same
    source of truth the conversation queryset uses — so the two cannot drift.
    """
    u = _auth_user(user)
    if not conversation.is_public:
        return u is not None and conversation.user_id == u.id
    if not conversation.user.is_active:
        return False
    if u is not None and conversation.user_id == u.id:
        return True
    return conversation_subscriber_visible(conversation, u)


def parent_visible(parent_object, user) -> bool:
    """Is a comment's parent ``content_object`` visible to ``user``?

    ``None`` means parentless; the standalone-post rule (active author,
    ) lives in:func:`comment_visible`, which is the only caller that
    can legitimately pass ``None`` here. Any content type this module does
    not explicitly understand fails closed to *not visible*.

    Prefer:func:`comment_visible` when you hold the ``Comment``: it can tell a
    genuinely parentless post apart from one whose parent row has been deleted
    (a stale generic pointer whose ``content_object`` also resolves to ``None``).
    """
    if parent_object is None:
        return True
    if isinstance(parent_object, zPage):
        return zpage_visible(parent_object, user)
    if isinstance(parent_object, Conversation):
        return conversation_visible(parent_object, user)
    return False


#Comments whose author's self-service deletion is pending
#(``g12f.account_deletion``). Hidden everywhere -- on other people's pages
#too, where a comment otherwise inherits its parent's visibility -- from
#the request on: "your account is hidden right away". Reversible: keeping
#the account clears ``deletion_requested_at`` (and reactivates), and the
#purge deletes them. One exception, in the thread views only: a comment
#other people replied to stays as a PLACEHOLDER (no text, no author --
#``CommentListSerializer``), exactly what the purge will leave, so their
#replies stay reachable (``pending_author_leaf``, ``placeholder_ok``).
#Not after the purge (``deleted_at``): what the purge keeps of a comment
#(an emptied parent that others replied to) is a thread placeholder and
#must stay reachable.
DELETION_PENDING_AUTHOR = Q(
    author__is_active=False, author__deletion_requested_at__isnull=False,
    author__deleted_at__isnull=True,
)


#Comments served as placeholders (``author_redacted``): pending or purged
#authors. A filter on author, text or tags must never match one -- that
#would answer, by 200 versus 404 or by a row count, what the placeholder hides.
REDACTED_AUTHOR = DELETION_PENDING_AUTHOR | Q(author__deleted_at__isnull=False)


def pending_author_leaf():
    """A pending author's comment that nobody replied to: hidden even in the
    thread views (one with replies shows as a placeholder there)."""
    from .models import Comment

    return DELETION_PENDING_AUTHOR & ~Q(
        Exists(Comment._base_manager.filter(parent=OuterRef("pk"))))


def pending_author_report_hold():
    """A pending author's comment under active moderation review stays hidden.

    The deletion purge marks reported comments banned, but during the grace
    period the reply-placeholder exception must not expose a reported parent.
    """
    from .models import ContentReport

    return DELETION_PENDING_AUTHOR & Q(Exists(
        ContentReport.objects.filter(
            target_kind="comment",
            target_id=Cast(OuterRef("pk"), output_field=TextField()),
            status__in=("open", "reviewing"),
        )
    ))


def author_deletion_pending(comment) -> bool:
    author = comment.author
    return author is not None and (
        not author.is_active and author.deletion_requested_at is not None
        and author.deleted_at is None)


def author_redacted(comment) -> bool:
    """Serve this comment as a placeholder (no text, tags or author): its
    author's deletion is pending, or done -- a purge keeps a comment others
    replied to, emptied, while the username stays reserved on the row."""
    author = comment.author
    return author is not None and (
        author_deletion_pending(comment) or author.deleted_at is not None)


def tagging_content_owner_active(content_object) -> bool:
    """Only active owners contribute attached-object text to AI tagging.

    GenericForeignKey resolution does not apply public visibility filters.
    A queued comment can therefore resolve a page retained during deletion,
    or a conversation whose other authors' turns remain readable. Check the
    object's owner as well as the individual comment/turn authors. This is
    the account boundary, not a change to active owners' publication or
    subscription policies. Unknown attachment types fail closed.
    """
    if isinstance(content_object, zPage):
        owner = content_object.creator
    elif isinstance(content_object, Conversation):
        owner = content_object.user
    else:
        return False
    return owner.is_active and owner.deleted_at is None


def comment_visible(comment, user, *, placeholder_ok=False) -> bool:
    """Is ``comment`` visible to ``user`` — the object-level gate for a Comment.

    A comment with no ``content_type`` is a standalone converse post. It stays
    public only while its author's account is active: deactivating an
    author must take their posts off the API list, the anonymous RSS feed and
    the OG/social card, exactly as ``is_active=False`` takes their pages down
    . There is deliberately no owner carve-out — a deactivated author can
    no longer authenticate, so nobody can be the owner here.

    Otherwise a comment inherits its parent's visibility (unchanged: the
    *parent* governs, not the comment's own author) — and if the parent row no
    longer resolves (deleted zPage/Conversation leaving a stale generic
    pointer), it fails **closed** rather than being treated as parentless.
    """
    # A report hold takes precedence over the pending author's thread
    # placeholder. The purge marks held comments banned, but they must stay
    # hidden throughout the grace period too.
    if author_deletion_pending(comment):
        from .models import ContentReport

        if ContentReport.objects.filter(
            target_kind="comment",
            target_id=str(comment.pk),
            status__in=("open", "reviewing"),
        ).exists():
            return False

    # Pending or purged author: only ever a thread placeholder, and only where
    # the caller serves one redacted (placeholder_ok). Everything else -- the
    # OG card, announcements, votes, reports -- would show the author.
    if author_redacted(comment) and not (
        placeholder_ok and comment.replies.exists()
    ):
        return False
    if comment.content_type_id is None:
        # `author` is prefetched/select_related on the API queryset; worst case
        # this is one query, and only for the caller whose answer it changes.
        # A deleted (or pending) author's standalone post that others replied
        # to stays reachable as its thread's placeholder, like an attached one.
        return bool(comment.author.is_active) or (
            placeholder_ok and author_redacted(comment) and comment.replies.exists())
    parent = comment.content_object
    if parent is None:
        return False
    return parent_visible(parent, user)


def comment_thread_access(comment):
    """Return the media access tier inherited by ``comment``'s thread.

    Standalone Converse posts are public, published zPages expose either a
    public or members tier, and drafts or other parent types are private. An
    unknown or deleted parent must never be mistaken for a public thread.
    """
    if comment.content_type_id is None:
        return "public"

    parent = comment.content_object
    if isinstance(parent, zPage):
        if not parent.is_published or not parent.creator.is_active:
            return "private"
        return "members" if parent.is_subscriber_only else "public"

    # AI conversation threads and content types not understood here remain
    # private until they have an explicit media policy.
    return "private"


def comment_thread_access_owner_id(comment):
    """Return the owner whose audience authorizes a thread's media.

    A members-tier GenericFile is served to subscribers of the file owner,
    while a comment under a zPage is visible to subscribers of the zPage
    creator. The client must compare those owners before inserting a saved
    members image; never infer this from the comment author.
    """
    if comment.content_type_id is None:
        return None

    parent = comment.content_object
    if isinstance(parent, zPage):
        return parent.creator_id
    return None


# --------------------------------------------------------------------------
# Queryset scoping (for the bulk list)
# --------------------------------------------------------------------------


def visible_zpages(user):
    """zPages visible to ``user`` — mirrors ``zPageView.get_queryset`` retrieve.

    The ``creator__is_active`` half is as load-bearing as ``is_published``
    : this queryset is what keeps a comment thread off a hidden page, and
    a deactivated creator's page is hidden. Without it, banning an account left
    the comment list and the public Converse RSS feed republishing every thread
    hanging off its articles — including the article title and link that the
    comment serializer renders as the thread's context.
    """
    u = _auth_user(user)
    if u is None:
        return zPage.objects.published_and_active().filter(
            is_subscriber_only=False)
    star_ids = Subscription.objects.filter(
        fan=u, expires__gte=timezone.now()
    ).values_list("star_id", flat=True)
    # Same shape as the retrieve queryset: the canonical published-and-active
    # queryset gates every public arm, while the owner arm remains the
    # explicit private carve-out used by the comment API.
    public = zPage.objects.published_and_active().filter(
        Q(is_subscriber_only=False) | Q(creator_id__in=star_ids)
    )
    return public | zPage.objects.filter(creator_id=u.id)


def visible_conversations(user):
    """Conversations visible to ``user`` — the queryset the comment list scopes to.

    An owner may still see private conversations, while a public conversation
    must also belong to an active creator and satisfy the subscriber-only gate.
    This is the public predicate the conversation endpoints apply, reused here
    so a subscriber-only or deactivated conversation's comment thread is
    hidden in the bulk list / feeds just as the single-object gate hides it
    elsewhere (issues  and ).
    """
    u = _auth_user(user)
    q = public_conversation_q(u)
    if u is not None:
        # Preserve the owner carve-out for private conversations only. An
        # inactive creator's public conversation must not re-enter through the
        # owner arm after the active-creator predicate above rejects it.
        q |= Q(user_id=u.id, is_public=False)
    return Conversation.objects.filter(q)


def scope_comments_to_visible_parents(queryset, user, *, placeholders=False):
    """Restrict a ``Comment`` queryset to comments whose parent is visible.

    A comment's ``object_id`` is a ``TextField``, so parent ids are compared as
    strings (parent primary keys are cast to text in-DB — this stays a single
    query and remains paginatable). Standalone converse posts
    (``content_type IS NULL``) are included only while their author's account
    is active ( — the SQL twin of:func:`comment_visible`'s standalone
    rule, and the arm that scopes the anonymous Converse RSS feed); comments on
    any other, non-null content type are excluded (fail closed).
    """
    zpage_ct = ContentType.objects.get_for_model(zPage)
    conv_ct = ContentType.objects.get_for_model(Conversation)

    zpage_ids = visible_zpages(user).annotate(
        _id_text=Cast("id", output_field=TextField())
    ).values_list("_id_text", flat=True)
    conv_ids = visible_conversations(user).annotate(
        _id_text=Cast("id", output_field=TextField())
    ).values_list("_id_text", flat=True)

    standalone = Q(content_type__isnull=True) & Q(author__is_active=True)
    if placeholders:
        from .models import Comment

        # A deleted or pending author's standalone post others replied to:
        # its thread's placeholder (comment_visible's standalone arm).
        standalone |= (
            Q(content_type__isnull=True) & REDACTED_AUTHOR
            & Q(Exists(Comment._base_manager.filter(parent=OuterRef("pk"))))
        )
    return queryset.filter(
        standalone
        | Q(content_type=zpage_ct, object_id__in=zpage_ids)
        | Q(content_type=conv_ct, object_id__in=conv_ids)
    ).exclude(
        pending_author_leaf() | pending_author_report_hold()
        if placeholders else REDACTED_AUTHOR
    )
