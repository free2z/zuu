"""The chat-request notification email.

Procrastinate task (autodiscovered via procrastinate.contrib.django). The job
row is inserted inside the transaction that charges the sender, so a request
that rolled back never mails anyone, and a web pod that dies right after the
commit still leaves the email queued.

Delivery semantics. The task claims the row (``pending`` -> ``sending``)
before calling the mail provider, so two copies of the job can never both send.
A worker killed mid-send leaves ``sending`` forever (no email rather than a
guess). A failure the task can SEE -- a database error while checking
preferences, or the provider raising -- puts the row back to ``pending`` and
the job retries (on the last attempt the row is marked ``failed`` instead);
if the provider had in fact accepted the message before the error, that retry
sends a duplicate. We accept that: it is one extra copy of a
notification, and the request itself is also in the feed, the badge and the
WebSocket push. The claim is why this task is ``NEVER`` in
``jobs.reclaim_policy``.

The provider call is BOUNDED (``EMAIL_SEND_TIMEOUT_SECONDS``). This runs on
the shared ``default`` queue, and the stock sendgrid backend would otherwise
wait forever on a provider that accepts the connection and never answers,
stalling every other job on that lane. A queue of its own would not isolate it
today: the catch-all worker consumes every ordinary queue from one
concurrency-1 slot (``k8s/free2z/worker/BUILD.bazel``), so real isolation is a
new worker deployment, which is an infrastructure change.

Who gets mailed is decided at SEND time, not at request time, from the same
preferences every other notification path honours:

* the recipient is still active and so is the sender;
* the recipient has a CONFIRMED address (``emails.Email.confirmed_at``);
* they asked for notification mail (``Email.get_notifications``, which is
  opt-in and off by default);
* the address is not on the do-not-email list (``emails.OptOutEmail``);
* and nothing else is mailing, or has mailed, this pair within the window
  (``_claim_pair_delivery``), so a sender using the whole per-pair rate limit
  produces one email, not three.
"""
import logging
from datetime import timedelta

from django.core.mail import EmailMultiAlternatives, get_connection
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.template.loader import render_to_string
from procrastinate import RetryStrategy
from procrastinate.contrib.django import app
from procrastinate.exceptions import AlreadyEnqueued

logger = logging.getLogger(__name__)

SEND_TASK_NAME = "e2ee.send_chat_request_email"
#procrastinate waits ``wait + exponential_wait ** (attempts + 1)`` seconds,
#so the exponent BASE is what matters here: 4 gives retries after roughly
#34s, 46s, 94s, 286s and 1054s (~25 minutes in all). The first version used
#``exponential_wait=60``, which put the third retry 2.5 days out and the
#fifth 1.5 years out.
EMAIL_RETRY = RetryStrategy(max_attempts=5, wait=30, exponential_wait=4)
#How long an earlier request's email counts as "on its way" while it is
#still `pending` or `sending`, measured from its last status change (or,
#before its first claim, from the request). Comfortably longer than the gap
#between two retries plus a send timeout; past it, a row stuck in `sending`
#by a killed worker (or `pending` behind a dead queue) stops suppressing
#mail.
EMAIL_IN_FLIGHT_WINDOW = timedelta(hours=1)
#One email per (sender, recipient) per this window.
PAIR_EMAIL_WINDOW = timedelta(hours=24)
#Per-request socket timeout for the mail provider, in seconds. The sendgrid
#backend makes one HTTPS request per message and does not retry itself.
EMAIL_SEND_TIMEOUT_SECONDS = 30


def enqueue_chat_request_email(chat_request_id) -> None:
    """Queue the email in the CURRENT transaction (see the module docstring).

    The savepoint confines a refused duplicate (``AlreadyEnqueued``) so it
    cannot abort the money transaction around it -- the same shape as
    ``ktauth.tasks.enqueue_session_sweep``.
    """
    try:
        with transaction.atomic():
            send_chat_request_email.configure(
                queueing_lock=f"e2ee-chat-request-email-{chat_request_id}",
            ).defer(chat_request_id=str(chat_request_id))
    except AlreadyEnqueued:
        logger.info("chat request email already queued: %s", chat_request_id)


def _skip(chat_request, detail: str) -> None:
    from .models import ChatRequest

    ChatRequest.objects.filter(
        pk=chat_request.pk, email_status=ChatRequest.EMAIL_SENDING,
    ).update(
        email_status=ChatRequest.EMAIL_SKIPPED, email_detail=detail,
        email_updated_at=timezone.now(),
    )
    logger.info(
        "chat request email skipped: request=%s reason=%s",
        chat_request.pk, detail,
    )


def _deliverable_address(chat_request):
    """Return ``(Email, None)`` or ``(None, reason)``. Reads only."""
    from dj.apps.emails.models import Email, OptOutEmail

    recipient = chat_request.recipient
    sender = chat_request.sender
    if not recipient.is_active:
        return None, "recipient_inactive"
    if not sender.is_active:
        return None, "sender_inactive"
    if not chat_request.sender_handle_is_current():
        return None, "sender_handle_changed"
    # A block made after the request was queued still stops the email.
    # The ENCRYPTED_CHAT_REQUEST event itself stays listed: it is the
    # recipient's receipt for 2Z already credited (g12f/blocks.py).
    from dj.apps.g12f.blocks import has_blocked
    if has_blocked(recipient.pk, sender.pk):
        return None, "recipient_blocked_sender"
    email = Email.objects.filter(user_id=recipient.pk).first()
    if email is None:
        return None, "no_address"
    if email.confirmed_at is None:
        return None, "unconfirmed"
    if not email.get_notifications:
        return None, "notifications_off"
    if OptOutEmail.objects.filter(email=email.email).exists():
        return None, "opted_out"
    return email, None


DELIVERING = "delivering"


def _claim_pair_delivery(chat_request) -> bool:
    """Decide, for the whole sender->recipient pair, whether THIS row mails.

    Runs under a transaction-scoped advisory lock on the pair, so two
    workers deciding for the same pair take turns, and the winner marks its
    row ``email_detail = "delivering"`` before the lock is released. The row
    does NOT mail if, for this pair:

    * any other row (either order) SENT in the last PAIR_EMAIL_WINDOW, or is
      ``delivering`` and was marked within EMAIL_IN_FLIGHT_WINDOW -- a
      decision already made, even for a later request;
    * or an EARLIER request's email is still on its way: claimed or handed
      back recently, or never claimed and itself recent. (Only earlier rows
      count here, so two undecided rows can never silence each other: the
      earlier one does not wait for the later.)

    `skipped` and `failed` rows never suppress, and in-flight rows older than
    EMAIL_IN_FLIGHT_WINDOW stop suppressing, so a stuck email cannot silence
    the pair for a whole day.
    """
    from django.db import connection

    from .models import ChatRequest

    sender_id = chat_request.sender_id
    recipient_id = chat_request.recipient_id
    now = timezone.now()
    in_flight_since = now - EMAIL_IN_FLIGHT_WINDOW
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                [f"e2ee-chat-email:{sender_id}:{recipient_id}"],
            )
        pair = ChatRequest.objects.filter(
            sender_id=sender_id, recipient_id=recipient_id,
        ).exclude(pk=chat_request.pk)
        pair_since = now - PAIR_EMAIL_WINDOW
        decided = pair.filter(
            Q(
                email_status=ChatRequest.EMAIL_SENT,
                email_updated_at__gte=pair_since,
            )
            | Q(
                email_status=ChatRequest.EMAIL_SENDING,
                email_detail=DELIVERING,
                email_updated_at__gte=in_flight_since,
            )
            # A SENT row from the previous release has no timestamp (the
            # column did not exist): judge it by the request's age, so it
            # keeps suppressing while those workers drain.
            | Q(
                email_status=ChatRequest.EMAIL_SENT,
                email_updated_at__isnull=True,
                created_at__gte=pair_since,
            )
        ).exists()
        earlier_on_its_way = pair.filter(
            created_at__gte=chat_request.created_at - PAIR_EMAIL_WINDOW,
            created_at__lt=chat_request.created_at,
        ).filter(
            Q(
                email_status__in=(
                    ChatRequest.EMAIL_PENDING, ChatRequest.EMAIL_SENDING,
                ),
                email_updated_at__gte=in_flight_since,
            )
            | Q(
                email_status=ChatRequest.EMAIL_PENDING,
                email_updated_at__isnull=True,
                created_at__gte=in_flight_since,
            )
            # A NULL-stamped `sending` row is an old-release worker that has
            # claimed but not necessarily decided. The old code lets only
            # EARLIER rows suppress, so apply exactly that rule to it: an
            # earlier one suppresses this row, a later one never does.
            # Either-order suppression here would let both versions skip.
            # And the old release's 24h window, not the in-flight one: its
            # claim leaves no timestamp, so a request created hours ago may be
            # sending right now. Transitional -- no new NULL-stamped rows are
            # written once the previous release's workers are gone.
            | Q(
                email_status=ChatRequest.EMAIL_SENDING,
                email_updated_at__isnull=True,
            )
        ).exists()
        if decided or earlier_on_its_way:
            return False
        return bool(ChatRequest.objects.filter(
            pk=chat_request.pk, email_status=ChatRequest.EMAIL_SENDING,
        ).update(email_detail=DELIVERING, email_updated_at=timezone.now()))


def bounded_mail_connection():
    """The configured mail backend, with the provider call time-bounded.

    ``sendgrid_backend.SendgridBackend`` builds a ``SendGridAPIClient`` whose
    ``python_http_client.Client`` defaults to ``timeout=None`` (urllib then
    blocks forever); the client passes its ``timeout`` to every request it
    builds, so setting it here bounds the send. Other backends (locmem in
    tests, SMTP) have no ``sg`` and are returned unchanged.
    """
    connection = get_connection()
    client = getattr(getattr(connection, "sg", None), "client", None)
    if client is not None:
        client.timeout = EMAIL_SEND_TIMEOUT_SECONDS
    return connection


def build_chat_request_message(chat_request, email):
    """The message itself, separated from sending so it can be read in tests."""
    from dj.apps.emails.sender import get_email_sender
    from dj.apps.emails.views import build_opt_out_url, unsubscribe_headers

    opt_out_url = build_opt_out_url(email)
    context = {
        "recipient_username": chat_request.recipient.username,
        "sender_username": chat_request.sender.username,
        "chat_url": chat_request.get_url(),
        "opt_out_url": opt_out_url,
    }
    subject = (
        f"{chat_request.sender.username} wants to chat with you privately"
    )
    message = EmailMultiAlternatives(
        subject,
        render_to_string("e2ee/chat_request_email.txt", context),
        # The one configured sender, shared with emails/views.py. It used to
        # be a third copy of the literal here, with a docstring that said so
        #. Raising on a misconfigured value is correct even in a
        # retried task: unaligned mail is accepted by SendGrid, reported as
        # sent, and then silently not delivered.
        get_email_sender(),
        [email.email],
        headers=unsubscribe_headers(opt_out_url),
        connection=bounded_mail_connection(),
    )
    message.attach_alternative(
        render_to_string("e2ee/chat_request_email.html", context),
        "text/html",
    )
    return message


def _is_last_attempt(context) -> bool:
    job = getattr(context, "job", None)
    attempts = getattr(job, "attempts", 0) or 0
    return attempts >= EMAIL_RETRY.max_attempts


# `pass_context` only changes how the WORKER calls the task; the stored job
# arguments are unchanged, so jobs queued by the previous release still run.
@app.task(
    name=SEND_TASK_NAME, queue="default", retry=EMAIL_RETRY,
    pass_context=True,
)
def send_chat_request_email(context, chat_request_id: str):
    from .models import ChatRequest

    with transaction.atomic():
        chat_request = (
            ChatRequest.objects.select_for_update(of=("self",))
            .select_related("sender", "recipient")
            .filter(pk=chat_request_id, email_status=ChatRequest.EMAIL_PENDING)
            .first()
        )
        if chat_request is None:
            # Gone, already sent, already being sent, or skipped.
            return
        chat_request.email_status = ChatRequest.EMAIL_SENDING
        chat_request.email_updated_at = timezone.now()
        chat_request.save(update_fields=["email_status", "email_updated_at"])

    try:
        email, reason = _deliverable_address(chat_request)
        if email is None:
            _skip(chat_request, reason)
            return
        if not _claim_pair_delivery(chat_request):
            _skip(chat_request, "pair_already_mailed")
            return
        build_chat_request_message(chat_request, email).send()
    except Exception:
        # A database blip while checking preferences, or a provider error:
        # hand the row back so the retry can claim it again. (See the module
        # docstring for the duplicate this can cause on an ambiguous send.)
        # On the LAST attempt there is no retry to claim it, so mark it
        # failed instead of leaving a `pending` row nobody will ever run.
        last = _is_last_attempt(context)
        ChatRequest.objects.filter(
            pk=chat_request.pk, email_status=ChatRequest.EMAIL_SENDING,
        ).update(
            email_status=(
                ChatRequest.EMAIL_FAILED if last
                else ChatRequest.EMAIL_PENDING
            ),
            email_detail="retries_exhausted" if last else "",
            email_updated_at=timezone.now(),
        )
        raise
    ChatRequest.objects.filter(
        pk=chat_request.pk, email_status=ChatRequest.EMAIL_SENDING,
    ).update(
        email_status=ChatRequest.EMAIL_SENT, email_detail="",
        email_updated_at=timezone.now(),
    )
