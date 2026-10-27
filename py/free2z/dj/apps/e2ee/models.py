import uuid
from urllib.parse import quote

from django.conf import settings
from django.db import models

#: Contract B (free2z/zuu#1022). The handle goes in the FRAGMENT, never the
#: query: a fragment is not sent to any server, so opening the link does not
#: tell the landing page's access log who is being contacted.
CHAT_LINK_PATH = "/bridge/e2e2z/chat/"


def chat_link(handle: str) -> str:
    """The Contract B link that opens first contact with ``handle``.

    The origin is configuration, not the request's ``Host``: this link is
    written into notifications that outlive the request, and the App Link is
    verified for one domain only.
    """
    origin = settings.E2EE_CHAT_LINK_ORIGIN.rstrip("/")
    # `handle` already matches ^[a-z0-9_]{1,30}$ (handles.py); quoting is
    # belt and braces so nothing else can ever reach the fragment.
    return f"{origin}{CHAT_LINK_PATH}#peer={quote(handle, safe='')}"


class ChatRequest(models.Model):
    """One paid request to start an encrypted chat.

    The audit record of the charge (the ledger itself only moves balances),
    the ``content_object`` of the recipient's ``ENCRYPTED_CHAT_REQUEST``
    event, the counter the per-sender rate limit reads, and the email's
    at-most-once state.
    """

    EMAIL_PENDING = "pending"
    EMAIL_SENDING = "sending"
    EMAIL_SENT = "sent"
    EMAIL_SKIPPED = "skipped"
    #: Every retry used up without a send. Terminal, and -- unlike a row left
    #: `pending` -- never suppresses a later request's email.
    EMAIL_FAILED = "failed"
    EMAIL_STATUS_CHOICES = (
        (EMAIL_PENDING, "Pending"),
        (EMAIL_SENDING, "Sending"),
        (EMAIL_SENT, "Sent"),
        (EMAIL_SKIPPED, "Skipped"),
        (EMAIL_FAILED, "Failed"),
    )

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sender = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="sent_chat_requests",
    )
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="received_chat_requests",
    )
    #: The sender's handle AS OF THE REQUEST. Frozen on purpose: the link in
    #: an email that is already in an inbox must keep naming the peer the
    #: recipient was told about, whatever happens to handles afterwards.
    sender_handle = models.CharField(max_length=30)
    #: Same precision as ``Creator.tuzis`` and ``Event.amount``.
    charged = models.DecimalField(max_digits=17, decimal_places=3)
    created_at = models.DateTimeField(auto_now_add=True)
    email_status = models.CharField(
        max_length=8, choices=EMAIL_STATUS_CHOICES, default=EMAIL_PENDING,
    )
    #: When `email_status` last changed (null until the first claim). An
    #: in-flight email is judged by THIS, not by `created_at`: a request can
    #: sit in a backlog for hours and then be actively sending.
    email_updated_at = models.DateTimeField(null=True, blank=True)
    #: Why the email was skipped, for support. Never shown to anyone.
    email_detail = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        indexes = [
            models.Index(
                fields=["sender", "created_at"],
                name="e2ee_chatreq_sender_idx",
            ),
            models.Index(
                fields=["sender", "recipient", "created_at"],
                name="e2ee_chatreq_pair_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.sender_id} -> {self.recipient_id} ({self.id})"

    def sender_handle_is_current(self) -> bool:
        """Whether the frozen handle still names THIS sender.

        Handles are stored and permanent (``dj.apps.handles``), so a rename
        no longer changes this answer: a link to ``#peer=alice`` keeps naming
        the account that owned ``alice``. The check stays as defence in depth:
        if a binding is ever retired (the account was deleted), the request
        stops linking anywhere rather than pointing at a handle nobody owns.
        """
        from .handles import resolve_messaging_handle

        return resolve_messaging_handle(self.sender)[0] == self.sender_handle

    def get_url(self) -> str | None:
        """Read by ``EventSerializer.content_url`` (``negotiated_content_url``)."""
        if not self.sender_handle_is_current():
            return None
        return chat_link(self.sender_handle)

    @property
    def is_active(self) -> bool:
        """Read by the event serializer's ``_content_object_is_active``.

        A request from an account that has since been deactivated must stop
        pointing at that account's handle, the same way its username is
        already redacted from the event's ``contributor`` and ``message``.
        """
        return bool(self.sender.is_active)
