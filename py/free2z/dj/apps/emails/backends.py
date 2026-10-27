"""Mail backends. See ``EMAIL_BACKEND`` in settings.py."""

import http.client
from urllib.error import URLError

from django.conf import settings
from sendgrid_backend import SendgridBackend


def delivery_outcome_unknown(exc):
    """True when a send failed AFTER SendGrid may already have accepted it.

    ``urllib``'s ``do_open`` wraps every failure while CONNECTING or SENDING
    the request in ``URLError`` (and an HTTP error status is ``HTTPError``,
    a ``URLError`` subclass): the provider never took the message, or said
    no. A failure while READING the response -- the read timeout
    introduces, a reset mid-response -- escapes ``getresponse()`` as a bare
    ``OSError``/``TimeoutError``: the request was fully sent, so SendGrid may
    have queued it and the recipient may be about to receive it. Callers that
    compensate for a failed send (retracting a reset token) must not treat
    that case as "not delivered". Found by the codex review of.

    ``http.client.HTTPException`` (``IncompleteRead``, ``BadStatusLine``,
    ``RemoteDisconnected``...) is raised by ``getresponse()``/``read()`` on a
    truncated or garbled response and is NOT an ``OSError`` subclass (bar
    ``RemoteDisconnected``), so it is named separately (codex round 2).
    """
    if isinstance(exc, URLError):
        return False
    return isinstance(exc, (OSError, http.client.HTTPException))


class BoundedSendgridBackend(SendgridBackend):
    """``SendgridBackend`` whose HTTP call to SendGrid cannot block forever.

    ``SendGridAPIClient`` builds a ``python_http_client.Client`` with
    ``timeout=None`` (read from the installed package, not assumed), and the
    client hands that to ``urllib``'s ``opener.open`` -- no bound at all. The
    client copies its ``timeout`` into every sub-client it builds for a
    request path (``client.mail.send.post``), so setting it once here bounds
    every send made through this backend, including the ones third-party code
    (dj-rest-auth, allauth) makes via ``send_mail``.

    A timeout surfaces as the ``TimeoutError``/``URLError`` urllib raises,
    which every inline sender already has to handle as "the provider failed".
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.sg.client.timeout = settings.EMAIL_SEND_TIMEOUT_SECONDS
