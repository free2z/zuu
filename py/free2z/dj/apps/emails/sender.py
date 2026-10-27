"""The one From address every outbound free2z email is sent from.

Why this module exists
----------------------
Until  the sender identity was a **literal, copied three times**::

    py/dj/apps/emails/views.py:391   "skylar@free2z.com"
    py/dj/apps/emails/views.py:603   'skylar@free2z.com',  # Replace with your actual sender email
    py/dj/apps/e2ee/tasks.py:71      FROM_ADDRESS = "skylar@free2z.com"

— the last of which documented the duplication in its own docstring ("the
sender address every other free2z mail uses"). One of them still carried its
scaffolding comment, on a production sender identity.

Why a *guard*, and not just a constant
--------------------------------------
``free2z.com`` has SendGrid domain authentication, verified live
in DNS::

    _dmarc.free2z.com  TXT    v=DMARC1; p=none; rua=mailto:skylar@free2z.com; fo=1
    free2z.com         TXT    v=spf1 include:_spf.google.com include:sendgrid.net ~all
    s1._domainkey      CNAME  s1.domainkey.u40530696.wl197.sendgrid.net.
    s2._domainkey      CNAME  s2.domainkey.u40530696.wl197.sendgrid.net.

**DMARC alignment is a property of the ``From:`` domain.** SendGrid signs our
mail with ``d=free2z.com`` because that is the domain we authenticated; the
published record sets no ``adkim``, so relaxed alignment applies and the
organizational domain of the ``From:`` address must be ``free2z.com``.

The failure this module exists to prevent is specific and very easy to commit:
``free2z.cash`` is the product/web domain — it is what ``CANONICAL_ORIGIN``
points at, it is what every link in the mail we send points at, and it is
therefore the obvious thing for a future contributor to "harmonise" the From
address to. It has **no** SendGrid domain authentication and no
``sendgrid.net`` in its SPF record (only
``include:spf.efwd.registrar-servers.com ~all``). Sending from
``@free2z.cash`` today would fail DKIM alignment outright.

The mail domain and the web domain differ **on purpose**. Do not unify them.

What makes this worth a check rather than a comment: the mail would still be
accepted by SendGrid and the send would still return success. The symptom is a
message that was sent and never arrived, for one mail type only, with nothing
red anywhere — which is exactly the shape of the report that cost the most
triage time in.

Failing loudly
--------------
Same posture as:mod:`dj.apps.emails.link_origin`: this is
**configuration, never a request value**, and there is deliberately **no
fallback**. A missing, malformed or misaligned setting raises
``ImproperlyConfigured`` at send time, and the Django system check in
``dj.apps.emails.checks`` catches it at ``manage.py check`` / startup, which is
where it should actually be caught. Quietly falling back to a hardcoded address
would defeat the entire point: the next person's wrong value would be accepted
in silence.
"""

from __future__ import annotations

from email.utils import getaddresses

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.core.validators import validate_email

EMAIL_SENDER_SETTING = "DEFAULT_FROM_EMAIL"

#The domain SendGrid domain authentication covers, and therefore the only
#organizational domain a ``From:`` address of ours can carry and still be
#DMARC-aligned. This is a fact about DNS, not a preference, which is why it
#is a constant here and not another environment variable: an env var would
#let a deploy disagree with the DNS zone and call itself configured.
AUTHENTICATED_SENDER_DOMAIN = "free2z.com"


def _describe_problem(value) -> str | None:
    """Why ``value`` cannot be used as our From address, or ``None``.

    Shared by:func:`get_email_sender` and the system check so the send path
    and the deploy-time check can never disagree about what counts as valid.
    """
    if not isinstance(value, str) or not value.strip():
        return "is not set"

    raw = value.strip()
    if "\r" in raw or "\n" in raw:
        # A From address is written into a header; a line break in it is
        # header injection, not a typo.
        return f"contains a line break (got {raw!r})"

    # ``getaddresses``, not ``parseaddr``: parseaddr silently returns only the
    # FIRST address of a list, so 'evil@example.com, ok@free2z.com' would be
    # judged on a value that is not what the header would carry. A comma
    # inside a quoted display name is still one address and stays legal.
    parsed = getaddresses([raw])
    if len(parsed) != 1:
        return (
            f"is not a single email address — 'local@domain' or "
            f"'Name <local@domain>' (got {raw!r})"
        )
    _display_name, address = parsed[0]
    if address.count("@") != 1:
        return (
            f"is not a single email address — 'local@domain' or "
            f"'Name <local@domain>' (got {raw!r})"
        )
    # Syntax before alignment. A suffix test alone would accept
    # 'skylar@.free2z.com' and 'skylar@foo..free2z.com': aligned-looking,
    # invalid, and rejected by SendGrid with a 400 at send time -- which the
    # reset path swallows to avoid an enumeration oracle, so the operator's
    # typo would surface only as mail that never arrives. (Caught by the codex
    # adversarial review of this change.)
    try:
        validate_email(address)
    except ValidationError:
        return f"is not a valid email address (got {raw!r})"

    _local, _, domain = address.partition("@")
    domain = domain.strip().rstrip(".").lower()

    aligned = domain == AUTHENTICATED_SENDER_DOMAIN or domain.endswith(
        f".{AUTHENTICATED_SENDER_DOMAIN}"
    )
    if not aligned:
        return (
            f"sends from {domain!r}, which we have no SendGrid domain "
            f"authentication for. DKIM signs our mail with "
            f"d={AUTHENTICATED_SENDER_DOMAIN}, so a From address outside "
            f"{AUTHENTICATED_SENDER_DOMAIN} is not DMARC-aligned and the "
            f"message can be delivered nowhere while still reporting a "
            f"successful send (got {raw!r})"
        )
    return None


def get_email_sender() -> str:
    """The ``From:`` value for every message we send.

    Returns the configured value verbatim (minus surrounding whitespace), so
    both ``local@domain`` and ``Name <local@domain>`` work.

    Raises ``ImproperlyConfigured`` if it is unset, malformed, or outside the
    domain we have SendGrid domain authentication for — never falls back to a
    hardcoded address.
    """
    value = getattr(settings, EMAIL_SENDER_SETTING, None)
    problem = _describe_problem(value)
    if problem is not None:
        raise ImproperlyConfigured(
            f"{EMAIL_SENDER_SETTING} {problem}. Every message we send "
            "(password reset, address confirmation, chat request) is sent "
            f"from it, and it must stay inside "
            f"{AUTHENTICATED_SENDER_DOMAIN} — the domain SendGrid signs for. "
            "Note that the web origin is free2z.cash and the mail domain is "
            f"{AUTHENTICATED_SENDER_DOMAIN}; they differ deliberately. "
            "See #1995."
        )
    return value.strip()
