"""Startup validation of the chat-request settings.

A bad price is a money bug, not a cosmetic one: ``ledger.to_tuzis`` would
quietly accept ``1.5`` or ``"1"``, the price endpoint would publish something
the client's whole-2Z parser refuses, and a zero or negative price would turn
the route into a free (or paying) notification cannon. So the values are
checked under ``manage.py check``, which CI runs and which Django runs before
every management command -- including the ``migrate`` a release waits on.

Registered from ``E2eeConfig.ready()``.
"""
from __future__ import annotations

from django.conf import settings
from django.core.checks import Error

#: The donation route's published ceiling for one whole-2Z amount.
MAX_COST = 2_147_483_647


def _positive_int(value) -> bool:
    # bool is an int subclass; True must not read as "1 2Z".
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def check_chat_request_settings(app_configs, **kwargs):
    errors = []
    cost = getattr(settings, "E2EE_CHAT_REQUEST_COST", None)
    if not _positive_int(cost) or cost > MAX_COST:
        errors.append(Error(
            f"E2EE_CHAT_REQUEST_COST must be a positive whole number of 2Z "
            f"(1..{MAX_COST}); got {cost!r}.",
            hint="It is charged to the sender and published as an integer by "
                 "GET /api/e2ee/chat-requests/price/.",
            id="e2ee.E001",
        ))
    for name in (
        "E2EE_CHAT_REQUEST_SENDER_HOURLY_LIMIT",
        "E2EE_CHAT_REQUEST_SENDER_DAILY_LIMIT",
        "E2EE_CHAT_REQUEST_PAIR_DAILY_LIMIT",
    ):
        value = getattr(settings, name, None)
        if not _positive_int(value):
            errors.append(Error(
                f"{name} must be a positive whole number; got {value!r}.",
                id="e2ee.E002",
            ))
    if not isinstance(getattr(settings, "E2EE_CHAT_REQUESTS_ENABLED", None), bool):
        errors.append(Error(
            "E2EE_CHAT_REQUESTS_ENABLED must be a boolean.",
            id="e2ee.E003",
        ))
    return errors
