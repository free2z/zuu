"""Server-authoritative @mention parsing and first-publication delivery."""

import logging
import re
from urllib.parse import urlsplit
from datetime import timedelta

from django.db import connection, transaction
from django.db.models.functions import Lower
from django.utils import timezone

from dj.apps.events.models import Event

from .models import (
    Creator, CreatorBlock, CreatorMute, PageMentionDelivery, Subscription,
    zPage,
)

logger = logging.getLogger(__name__)

MAX_RECIPIENTS_PER_PAGE = 5
MAX_NOTIFICATIONS_PER_AUTHOR_24H = 20
PAIR_COOLDOWN = timedelta(days=7)
#: pg_advisory_xact_lock namespace for "one author's mention accounting".
#: Two-key form: (namespace, author_id). The value is arbitrary but must not be
#: reused by another two-key advisory lock in this database.
_AUTHOR_MENTION_LOCK_NAMESPACE = 954
AUTHOR_WINDOW = timedelta(hours=24)
USERNAME_PATTERN = r"[\w.@+-]{1,150}"
MAX_MENTION_TEXT_CHARS = 20_000
MAX_MENTION_CANDIDATES = 100
MAX_MENTION_LOOKUP_KEYS = 200
TRAILING_PUNCTUATION = ".,!?;:)+-"
MENTION_RE = re.compile(
    rf"(?<![\w@\\])@(?P<handle>{USERNAME_PATTERN})(?![\w.@+-])",
    re.UNICODE,
)
AUTOCOMPLETE_RE = re.compile(
    rf"\[@(?P<handle>{USERNAME_PATTERN})\]\((?P<url>[^)\s]+)\)",
    re.UNICODE,
)
FENCED_CODE_RE = re.compile(
    r"(?ms)^ {0,3}(?P<fence>`{3,}|~{3,})[^\n]*\n.*?^ {0,3}(?P=fence)[ \t]*$"
)
UNTERMINATED_FENCE_RE = re.compile(r"(?ms)^ {0,3}(?P<fence>`{3,}|~{3,})[^\n]*\n.*$")
BLOCKQUOTE_RE = re.compile(r"(?m)^ {0,3}>[^\n]*(?:\n|$)")
INDENTED_CODE_RE = re.compile(r"(?m)^(?: {4}|\t)[^\n]*(?:\n|$)")
MARKDOWN_LINK_RE = re.compile(r"(?s)\[[^\]]*\]\([^)]*\)")
REFERENCE_LINK_RE = re.compile(r"(?s)\[[^\]]*\]\[[^\]]*\]")
LINK_DEFINITION_RE = re.compile(
    r"(?m)^ {0,3}\[[^\]]+\]:[^\n]*(?:\n|$)"
)
HTML_CODE_RE = re.compile(r"(?is)<(?:pre|code)\b[^>]*>.*?</(?:pre|code)>")
AUTOLINK_RE = re.compile(r"<[^>\n]+>")
HTML_BLOCKQUOTE_RE = re.compile(r"(?is)<blockquote\b[^>]*>.*?</blockquote>")
RAW_URL_RE = re.compile(r"(?i)\b(?:https?://|www\.)[^\s<]+")
TRAILING_TOKEN_RE = re.compile(r"\S+\Z")


def _blank(match):
    # Keep newlines intact: masking must not join two Markdown blocks and
    # change which block-level rules apply to the remaining text.
    return "".join("\n" if char == "\n" else " " for char in match.group(0))


def _mask_inline_code(text: str) -> str:
    """Mask inline-code spans with a bounded left-to-right scanner.

    A regex with a lazy body and a backreference can repeatedly rescan a
    hostile run of backticks. The publish payload is bounded, and this scanner
    advances past each opener and its matching closer in one pass.
    """
    chars = list(text)
    length = len(chars)
    index = 0
    while index < length:
        if chars[index] != "`":
            index += 1
            continue
        opener = index
        while index < length and chars[index] == "`":
            index += 1
        width = index - opener
        close = index
        found = None
        while close < length:
            if chars[close] != "`":
                close += 1
                continue
            run_start = close
            while close < length and chars[close] == "`":
                close += 1
            if close - run_start >= width:
                found = close
                break
        end = found if found is not None else length
        for position in range(opener, end):
            if chars[position] != "\n":
                chars[position] = " "
        index = end
    return "".join(chars)


def _visible_text(text: str) -> str:
    """Mask markdown regions where visible text is quoted/imported/code."""
    text = text or ""
    if len(text) > MAX_MENTION_TEXT_CHARS:
        # Cut back to whitespace so the cap cannot split a token: the tail of
        # "@alicebob" must not become a mention of "@alice".
        text = TRAILING_TOKEN_RE.sub("", text[:MAX_MENTION_TEXT_CHARS])
    masked = FENCED_CODE_RE.sub(_blank, text)
    masked = UNTERMINATED_FENCE_RE.sub(_blank, masked)
    masked = BLOCKQUOTE_RE.sub(_blank, masked)
    masked = HTML_BLOCKQUOTE_RE.sub(_blank, masked)
    masked = HTML_CODE_RE.sub(_blank, masked)
    masked = INDENTED_CODE_RE.sub(_blank, masked)
    masked = _mask_inline_code(masked)
    masked = REFERENCE_LINK_RE.sub(_blank, masked)
    masked = LINK_DEFINITION_RE.sub(_blank, masked)
    return masked


def _canonical_autocomplete_handle(url: str, handle: str) -> bool:
    """Accept only the editor's profile-link form, not arbitrary links."""
    try:
        parsed = urlsplit(url)
    except ValueError:
        # e.g. "http://[" is an invalid IPv6 netloc. A malformed link is simply
        # not an autocomplete mention; it must never fail the publication (the
        # scheduled task would re-raise on the same stored content forever).
        return False
    # The editor emits a root-relative profile URL. Without a request origin
    # available here, accepting an absolute URL would turn any external link
    # ending in /alice into an autocomplete mention.
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        return False
    path = parsed.path.rstrip('/')
    return path.casefold() == f"/{handle}".casefold()


def extract_mention_handles(text: str) -> list[str]:
    """Return exact, ordered, case-folded handles from publishable text.

    Autocomplete writes ``[@handle](profile-url)``. Typed mentions are parsed
    only at a token boundary, so email addresses, partial usernames, ordinary
    links and markdown/code/blockquote text cannot become recipients.
    """
    visible = _visible_text(text or "")
    mentions = []
    for match in AUTOCOMPLETE_RE.finditer(visible):
        handle = match.group('handle')
        if not _canonical_autocomplete_handle(match.group('url'), handle):
            continue
        mentions.append((match.start(), handle))
    masked_links = MARKDOWN_LINK_RE.sub(_blank, visible)
    masked_links = AUTOLINK_RE.sub(_blank, masked_links)
    masked_links = RAW_URL_RE.sub(_blank, masked_links)
    for match in MENTION_RE.finditer(masked_links):
        mentions.append((match.start(), match.group('handle')))

    # Both scans use the original string offsets. Sort before deduplicating so
    # a typed occurrence cannot be displaced by a later autocomplete token.
    result = []
    seen = set()
    for _position, handle in sorted(mentions, key=lambda item: item[0]):
        key = handle.lower()
        if key not in seen:
            seen.add(key)
            result.append(handle)
    return result[:MAX_MENTION_CANDIDATES]


def _handle_spellings(handle: str) -> list[str]:
    """The handle as written, then with up to 3 trailing punctuation marks off.

    Usernames may legitimately end in ``.``/``+``/``-``, so "Thanks @alice."
    tries ``alice.`` first and only then ``alice``.
    """
    spellings = [handle]
    trimmed = handle
    for _ in range(3):
        if not trimmed or trimmed[-1] not in TRAILING_PUNCTUATION:
            break
        trimmed = trimmed[:-1]
        if trimmed:
            spellings.append(trimmed)
    return spellings


def _lookup_handles(handles: list[str]) -> list[str]:
    """Bounded, lower()-ed lookup keys for every spelling of every handle.

    ``lower()`` and NOT ``casefold()``: the lookup is ``LOWER(username)`` in
    Postgres, and ``"Straße".casefold()`` is ``strasse`` -- a different
    account (same rule as ``dyte.views``).
    """
    requested = []
    for handle in handles[:MAX_MENTION_CANDIDATES]:
        requested.extend(spelling.lower() for spelling in _handle_spellings(handle))
    return list(dict.fromkeys(requested))[:MAX_MENTION_LOOKUP_KEYS]


def _pick_recipient(group, spelling):
    """Resolve one lower()-key group, refusing to guess between legacy twins.

    ``0110_creator_username_ci_unique`` preserves pre-existing case-variant
    duplicate groups (``Alice`` and ``alice``). Only an exact-case match may
    pick one of them; otherwise the mention is ambiguous and nobody is
    notified, rather than whichever row the query happened to return last.
    """
    if not group:
        return None
    if len(group) == 1:
        return group[0]
    exact = [recipient for recipient in group if recipient.username == spelling]
    return exact[0] if len(exact) == 1 else None


def _log_suppression(page, author, reason, recipient=None):
    logger.info(
        "page mention suppressed",
        extra={
            'event': 'page_mention_suppressed',
            'reason': reason,
            'page_id': page.pk,
            'author_id': author.pk,
            'recipient_id': getattr(recipient, 'pk', None),
        },
    )


def _eligible_recipient_sets(page, author, recipient_ids, now):
    """Load directional admission checks once for the whole page.

    Mention delivery holds the page and author locks while it establishes the
    rolling cap. Keep that critical section bounded to bulk queries instead of
    repeating subscription, block, mute, and cooldown queries for every
    candidate that is skipped.
    """
    if page.is_subscriber_only:
        authorized = set(
            Subscription.objects.filter(
                star_id=page.creator_id,
                fan_id__in=recipient_ids,
                expires__gte=now,
            ).values_list('fan_id', flat=True)
        )
    else:
        authorized = set(recipient_ids)

    blocked = set(
        CreatorBlock.objects.filter(
            blocker_id__in=recipient_ids,
            blocked_id=author.pk,
        ).values_list('blocker_id', flat=True)
    )
    muted = set(
        CreatorMute.objects.filter(
            muter_id__in=recipient_ids,
            muted_id=author.pk,
        ).values_list('muter_id', flat=True)
    )
    cooled_down = set(
        PageMentionDelivery.objects.filter(
            author=author,
            recipient_id__in=recipient_ids,
            status=PageMentionDelivery.SENT,
            created_at__gte=now - PAIR_COOLDOWN,
        ).values_list('recipient_id', flat=True)
    )
    return authorized, blocked, muted, cooled_down


def _delivery(page, author, recipient, status):
    delivery, created = PageMentionDelivery.objects.get_or_create(
        zpage=page,
        recipient=recipient,
        defaults={'author': author, 'status': status},
    )
    if not created and delivery.status != PageMentionDelivery.SENT:
        # A concurrent caller can only get here after the page lock is held,
        # but keeping the operation monotonic makes retries safe if a future
        # caller uses this helper independently.
        delivery.status = status
        delivery.save(update_fields=['status'])
    return delivery, created


@transaction.atomic
def process_page_mentions(page_id: int) -> dict[str, int]:
    """Deliver mentions once, atomically with the first public transition."""
    # Lock ONLY the page row. A bare select_for_update() with select_related
    # also takes FOR UPDATE on the joined g12f_creator row, and this runs on
    # every save of a published page (autosave included), after zPage.save()
    # already holds the page row. The ledger's global order is Creator row
    # first, then the zPage (tuzis.ledger.lock_in_order): a vote, fund or
    # translation purchase by the author on this page holds their Creator row
    # and waits for the page, so taking the Creator row here, second, is a
    # deadlock cycle Postgres breaks by killing one side.
    page = zPage.objects.select_for_update(of=("self",)).select_related(
        'creator',
    ).get(pk=page_id)
    if page.mention_notifications_processed_at is not None:
        return {'sent': 0, 'suppressed': 0, 'skipped': 1}
    if (
        not page.is_published
        or not page.creator.is_active
    ):
        return {'sent': 0, 'suppressed': 0, 'skipped': 1}

    # This lock serializes publications by one author and makes the rolling
    # sent-count check atomic. It is a transaction-scoped advisory lock rather
    # than a row lock on the author's Creator row for the reason given above:
    # the page row is already held, and no ledger writer ever waits on this
    # advisory key, so it cannot close a cycle with them. It does not
    # serialize a recipient changing their own preference; that preference is
    # deliberately read as a suppression check below.
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_advisory_xact_lock(%s, %s)",
            [_AUTHOR_MENTION_LOCK_NAMESPACE, page.creator_id],
        )
    author = Creator._base_manager.get(pk=page.creator_id)
    if not author.is_active:
        return {'sent': 0, 'suppressed': 0, 'skipped': 1}
    handles = extract_mention_handles(
        '\n'.join((page.title, page.description, page.content))
    )
    now = timezone.now()
    # Resolve all unique handles with one lower()-ed bulk lookup. The
    # delivery ledger below is intentionally bounded to actual sends; invalid
    # and suppressed handles produce aggregate telemetry, not one row each.
    handle_keys = _lookup_handles(handles)
    recipients = Creator._base_manager.annotate(
        _mention_username=Lower('username'),
    ).filter(_mention_username__in=handle_keys)
    recipients_by_key: dict[str, list] = {}
    for recipient in recipients:
        recipients_by_key.setdefault(recipient.username.lower(), []).append(
            recipient,
        )
    resolved = []
    resolved_ids = set()
    for handle in handles[:MAX_MENTION_CANDIDATES]:
        for spelling in _handle_spellings(handle):
            group = recipients_by_key.get(spelling.lower())
            if not group:
                continue
            # A matching key ends the fallback chain even when ambiguous:
            # "@Alice." must not silently become a different account.
            recipient = _pick_recipient(group, spelling)
            if recipient is not None and recipient.pk not in resolved_ids:
                resolved.append(recipient)
                resolved_ids.add(recipient.pk)
            break
    if len(handles) > len(resolved):
        _log_suppression(page, author, 'invalid')

    recipient_ids = [recipient.pk for recipient in resolved]
    authorized_ids, blocked_ids, muted_ids, cooled_down_ids = (
        _eligible_recipient_sets(page, author, recipient_ids, now)
    )

    sent = 0
    suppressed = 0
    author_sent = PageMentionDelivery.objects.filter(
        author=author,
        status=PageMentionDelivery.SENT,
        created_at__gte=now - AUTHOR_WINDOW,
    ).count()

    for position, recipient in enumerate(resolved):
        if sent >= MAX_RECIPIENTS_PER_PAGE:
            suppressed += len(resolved) - position
            _log_suppression(page, author, PageMentionDelivery.PAGE_CAP)
            break
        reason = None
        if not recipient.is_active:
            reason = PageMentionDelivery.INACTIVE
        elif recipient.pk == author.pk:
            reason = PageMentionDelivery.SELF
        elif recipient.pk not in authorized_ids:
            reason = PageMentionDelivery.UNAUTHORIZED
        elif recipient.pk in blocked_ids:
            reason = PageMentionDelivery.BLOCKED
        elif recipient.pk in muted_ids:
            reason = PageMentionDelivery.MUTED
        elif not recipient.mention_notifications_enabled:
            reason = PageMentionDelivery.OPTED_OUT
        elif author_sent >= MAX_NOTIFICATIONS_PER_AUTHOR_24H:
            reason = PageMentionDelivery.DAILY_CAP
        elif recipient.pk in cooled_down_ids:
            reason = PageMentionDelivery.COOLDOWN

        if reason is not None:
            _log_suppression(page, author, reason, recipient)
            suppressed += 1
            continue

        _delivery_row, created = _delivery(
            page, author, recipient, PageMentionDelivery.SENT,
        )
        if not created:
            # Existing SENT rows are the idempotency barrier for any retry.
            suppressed += 1
            continue
        Event.objects.create(
            type='PAGE_MENTION',
            receiving_user=recipient,
            contributor=author,
            content_object=page,
        )
        author_sent += 1
        sent += 1

    zPage.objects.filter(pk=page.pk).update(
        mention_notifications_processed_at=now,
    )
    return {'sent': sent, 'suppressed': suppressed, 'skipped': 0}
