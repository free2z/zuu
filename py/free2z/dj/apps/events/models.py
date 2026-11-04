import uuid
from decimal import Decimal

from django.db import models
from django.contrib.auth import get_user_model
from django.contrib.contenttypes.fields import GenericForeignKey
from django.contrib.contenttypes.models import ContentType

User = get_user_model()


# ``Event.amount`` carries the ledger's own precision. ``Creator.tuzis``,
# ``ProviderReservation.amount`` and ``ZecCreditReceipt.tuzis_credited`` are
# all ``DecimalField(max_digits=17, decimal_places=3)``; until  this
# column was an ``IntegerField`` and Django prepared ``Decimal("1.5")`` for it
# as ``int(1)`` -- truncation, not rounding, and silent -- so the audit row
# disagreed with the balance movement written in the same transaction. Same
# digits and places as the ledger means any amount the ledger can hold, the
# audit row records verbatim. Change these only together with the ledger's.
AMOUNT_MAX_DIGITS = 17
AMOUNT_DECIMAL_PLACES = 3
# The largest value the column can store: 14 integer digits, 3 fractional.
AMOUNT_MAX = (
    Decimal(10) ** (AMOUNT_MAX_DIGITS - AMOUNT_DECIMAL_PLACES)
    - Decimal(1).scaleb(-AMOUNT_DECIMAL_PLACES)
)


def format_amount(amount) -> str:
    """Render an amount for notification copy: ``5`` not ``5.000``.

    The column stores three decimal places, so a whole-number donation reads
    back as ``Decimal("5.000")``; interpolating that raw would turn "You
    received 5 tuzi" into "You received 5.000 tuzi" for every historical row.
    Trailing zeros are dropped and a genuine fraction is kept (``1.5``).
    ``None`` and non-Decimal values render exactly as before.
    """
    if not isinstance(amount, Decimal):
        return str(amount)
    text = format(amount, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in ("", "-0"):
        return "0"
    return text


def _reader_is_actor(ev) -> bool:
    """True on the row written to the person who caused the event.

    Templates get duck-typed objects (see the comment above EVENT_TEMPLATES),
    so this reads the ids defensively and treats "unknown" as "not the actor".
    """
    reader = getattr(ev, 'receiving_user_id', None)
    return reader is not None and reader == getattr(ev, 'contributor_id', None)


FINANCIAL_EVENTS = [
    'AISCORE_COMMENT',
    'MADE_COMMENT',
    'VOTE_COMMENT_SENT',
    'DONATION_SENT',
    'DONATION_RECEIVED',
    'SUBSCRIPTION_SENT',
    'SUBSCRIPTION_RECEIVED',
    'BOUGHT_TUZI',
    'CHAT2Z',
]
SOCIAL_EVENTS = [
    # Purchase receipts and confirmation progress belong in the default bell
    # feed as well as the balance history. Most financial events stay in the
    # separate financial view; these are explicit buyer notifications.
    'BOUGHT_TUZI',
    'ZEC_PENDING',
    'VOTE_COMMENT_RECEIVED',
    'NEW_REPLY',
    'PAGE_UPDATE',
    'PAGE_VOTE',
    'DONATION_SENT',
    'DONATION_RECEIVED',
    'ENCRYPTED_CHAT_REQUEST',
    'PAGE_MENTION',
]

# A template is handed *anything* carrying the attributes it names -- tests
# pass a duck-typed object with nothing but ``amount``
# (``comments/test_comment_headline_optional.py``), and that contract is
# deliberate: the copy depends on the row's fields, not on ``Event``'s
# methods. So a template interpolates ``format_amount(ev.amount)``, never an
# ``Event``-only property.
EVENT_TEMPLATES = {
    'AISCORE_COMMENT': {
        'get_message':
            lambda ev: f'You received {format_amount(ev.amount)} tuzi from the AI for your comment',
    },
    'MADE_COMMENT': {
        'get_message':
            lambda ev: f'You made a comment for {format_amount(ev.amount)}',
    },
    'VOTE_COMMENT_RECEIVED': {
        'get_message':
            lambda ev: f'{ev.contributor.username} voted on your comment with {format_amount(ev.amount)} tuzi',
    },
    'VOTE_COMMENT_SENT': {
        # Interpolated `content_object.headline` until: that rendered
        # "You voted on N/A with 5 tuzi" for new-UI comments and, once the
        # headline went away, "You voted on  with 5 tuzi". The mirror-image
        # event (VOTE_COMMENT_RECEIVED) never named the comment either, so
        # say the same thing rather than interpolate a field that is usually
        # empty by design.
        'get_message':
            lambda ev: f'You voted on a comment with {format_amount(ev.amount)} tuzi',
    },
    'NEW_REPLY': {
        'get_message':
            lambda ev: f'New comment from {ev.contributor.username}',
    },
    'PAGE_UPDATE': {
        'get_message':
            lambda ev: f'"{ev.content_object.title}" by {ev.contributor.username} was updated',
    },
    'PAGE_VOTE': {
        'get_message':
            lambda ev: f'Voted on "{ev.content_object.title}" with {format_amount(ev.amount)} tuzi',
    },
    'PAGE_MENTION': {
        'get_message':
            lambda ev: f'{ev.contributor.username} mentioned you in "{ev.content_object.title}"',
    },
    'DONATION_RECEIVED': {
        'get_message':
            lambda ev: f'You received {format_amount(ev.amount)} tuzi from {ev.contributor.username if ev.contributor else "Anonymous"}',
    },
    'DONATION_SENT': {
        'get_message':
            lambda ev: f'You sent {format_amount(ev.amount)} tuzi to {ev.payee.username}',
    },
    'SUBSCRIPTION_RECEIVED': {
        'get_message':
            lambda ev: f'Subscription payment from {ev.contributor.username} for {format_amount(ev.amount)} tuzi',
    },
    'SUBSCRIPTION_SENT': {
        'get_message':
            lambda ev: f'Subscription paid to {ev.payee.username} for {format_amount(ev.amount)} tuzi',
    },
    'BOUGHT_TUZI': {
        'get_message':
            lambda ev: f'You bought {format_amount(ev.amount)} tuzi',
    },
    # Detection is factual; confirmation and actual credit are separate.
    # Old notices may retain a projected amount. Authenticated purchase-intent
    # notices leave it null and never promise a rate-based credit.
    'ZEC_PENDING': {
        'get_message': lambda ev: (
            'Your Zcash payment was detected. We’re processing it. '
            'Check billing for its status and any credited 2Zs.'
        ),
    },
    'CHAT2Z': {
        'get_message':
            lambda ev: f'You paid {format_amount(ev.amount)} tuzi for your Chat2Z prompt',
    },
    'PLATFORM_FEE': {
        'get_message':
            lambda ev: f'Platform fee of {format_amount(ev.amount)} tuzi',
    },
    'PAY_PER_VIEW_REVENUE': {
        'get_message':
            lambda ev: f'{ev.contributor.username} paid you {format_amount(ev.amount)} tuzi for PPV',
    },
    'PAY_PER_VIEW_SPEND': {
        'get_message':
            lambda ev: f'You gave {ev.payee.username} {format_amount(ev.amount)} tuzi for PPV',
    },
    # dj.apps.e2ee (free2z/zuu#1022). Two rows per request, like PAGE_VOTE:
    # the recipient's (unread; its content object is the ChatRequest, whose
    # URL opens e2e2z's first-contact screen for the sender's handle) and the
    # sender's own spend record (read, no content object). The reader is the
    # actor exactly on the sender's row.
    'ENCRYPTED_CHAT_REQUEST': {
        'get_message':
            lambda ev: (
                f'You paid {format_amount(ev.amount)} tuzi to ask {ev.payee.username} '
                f'for an encrypted chat'
                if _reader_is_actor(ev) else
                f'{ev.contributor.username} paid {format_amount(ev.amount)} tuzi to start an '
                f'encrypted chat with you. Open the link in the e2e2z app to reply.'
            ),
    },
}


class Event(models.Model):
    """
    For notifications
    """
    id = models.UUIDField(
        primary_key=True, default=uuid.uuid4, editable=False)
    read = models.BooleanField(default=False)

    type = models.CharField(
        max_length=32,
        choices=[[k, k] for k in EVENT_TEMPLATES.keys()],
    )
    # Decimal, not integer, -- see AMOUNT_MAX_DIGITS above. Rows
    # written before that migration may hold a truncated value; the
    # ``repair_event_amounts`` command reconciles the ones that are provably
    # derivable from an authoritative record and reports the rest.
    amount = models.DecimalField(
        max_digits=AMOUNT_MAX_DIGITS, decimal_places=AMOUNT_DECIMAL_PLACES,
        null=True, blank=True,
    )
    # This is the user who is receiving the event
    receiving_user = models.ForeignKey(
        User, on_delete=models.CASCADE,
        related_name="received_events",
        help_text="The user who is receiving the event",
    )

    # the contributor is the user who is paying or originating the event
    contributor = models.ForeignKey(
        User, on_delete=models.CASCADE,
        related_name="contributor_events", null=True, blank=True,
        help_text="The user who is paying or originating the event",
    )
    # only fill this in if amount is not 0?
    payee = models.ForeignKey(
        User, on_delete=models.CASCADE,
        related_name="payee_events", null=True, blank=True)

    # TODO: standardize on a get_url method?
    content_type = models.ForeignKey(
        ContentType, on_delete=models.CASCADE, null=True, blank=True)
    # can accommodate UUIDs and integers
    object_id = models.CharField(max_length=200, null=True, blank=True)
    content_object = GenericForeignKey('content_type', 'object_id')

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']

    def __str__(self):
        return f'{self.type}: {self.amount}'

    def message(self):
        # print(self.type)
        return EVENT_TEMPLATES[self.type]['get_message'](self)

    def to_dict(self):
        from .serializers import EventSerializer
        return EventSerializer(
            self, context={'recipient': self.receiving_user},
        ).data
