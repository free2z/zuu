"""Startup validation of the two halves of our outbound mail identity.

Where the links point (``CANONICAL_ORIGIN``) and who the mail comes from
(``DEFAULT_FROM_EMAIL``) are both security-relevant configuration with no safe
default, and both fail in ways nothing else in the system would report.

``link_origin`` refuses to build a link with a missing or malformed
``CANONICAL_ORIGIN``, but discovering that while a user is trying to recover
their account is a bad place to learn it. This check runs under
``manage.py check`` — which CI already runs on every PR, and which Django runs
for every management command — so a broken config is a red build rather than a
password-reset mail nobody can act on. The sender check has the same shape and
a quieter failure still -- see:func:`check_email_sender`.

Registered from ``EmailsConfig.ready()``.
"""

from __future__ import annotations

from django.conf import settings
from django.core.checks import Error

from .link_origin import EMAIL_LINK_ORIGIN_SETTING, _describe_problem
from .sender import (
    AUTHENTICATED_SENDER_DOMAIN,
    EMAIL_SENDER_SETTING,
    _describe_problem as _describe_sender_problem,
)


def check_email_link_origin(app_configs, **kwargs):
    problem = _describe_problem(
        getattr(settings, EMAIL_LINK_ORIGIN_SETTING, None)
    )
    if problem is None:
        return []
    return [
        Error(
            f"{EMAIL_LINK_ORIGIN_SETTING} {problem}.",
            hint=(
                "Set it to this environment's public origin "
                "(scheme://host[:port]), e.g. 'https://free2z.cash'. Every "
                "emailed link is built from it, and it must never be derived "
                "from the request Host header (#1016)."
            ),
            id="emails.E001",
        )
    ]


def check_email_sender(app_configs, **kwargs):
    """The From address must stay inside the domain SendGrid signs for.

    A misaligned sender is not a crash: SendGrid accepts the message, the send
    reports success, and the mail is then filed or dropped by the recipient's
    DMARC evaluation. There is no signal anywhere -- which is why this is a
    deploy-time Error rather than something to notice in production. See
    ``dj.apps.emails.sender`` and.
    """
    problem = _describe_sender_problem(
        getattr(settings, EMAIL_SENDER_SETTING, None)
    )
    if problem is None:
        return []
    return [
        Error(
            f"{EMAIL_SENDER_SETTING} {problem}.",
            hint=(
                f"Every message we send is sent from it, and it must stay "
                f"inside {AUTHENTICATED_SENDER_DOMAIN} -- the domain we have "
                f"SendGrid domain authentication (DKIM/SPF) for. The web "
                f"origin is free2z.cash and the mail domain is "
                f"{AUTHENTICATED_SENDER_DOMAIN}; they differ deliberately, "
                f"and free2z.cash has no domain authentication at all, so "
                f"'harmonising' them silently breaks DMARC alignment (#1995)."
            ),
            id="emails.E002",
        )
    ]
