"""The ``sys:*`` accounts and the account/transfer vocabulary (design §2.1, §3.1).

The migration that seeds these keeps its OWN frozen copy of the list: a later
kind added here must ship with its own migration (the ``kind`` CHECK is part
of the schema), and ``0001_initial`` must keep producing the schema it
produced on the day it ran. ``tests/test_schema.py`` asserts the two agree.
"""
from __future__ import annotations

USER_KINDS = ("user", "user_debt")

#: (key, kind), in the order the design lists them. Every one is journal-only.
SYSTEM_ACCOUNTS: tuple[tuple[str, str], ...] = (
    ("sys:platform_revenue", "platform_revenue"),
    ("sys:provider_cost", "provider_cost"),
    ("sys:ai_clearing", "ai_clearing"),
    ("sys:bad_debt", "bad_debt"),
    ("sys:markup_reversal", "markup_reversal"),
    ("sys:opening_equity", "opening_equity"),
    ("sys:reservation_clearing", "reservation_clearing"),
    ("sys:promo", "promo"),
    ("sys:clearing_stripe", "clearing_stripe"),
    ("sys:clearing_zec", "clearing_zec"),
    ("sys:clearing_iap_apple", "clearing_iap_apple"),
    ("sys:clearing_iap_google", "clearing_iap_google"),
)

ACCOUNT_KINDS: tuple[str, ...] = USER_KINDS + tuple(kind for _, kind in SYSTEM_ACCOUNTS)

PURCHASE_RAILS: tuple[str, ...] = ("stripe", "zec", "iap_apple", "iap_google")

TRANSFER_CODES: tuple[str, ...] = (
    "opening", "legacy_adjustment", "reservation_import",
    "purchase", "debt_repay", "restore", "grant", "refund",
    "spend", "spend_up_to", "transfer",
    "ai_settle", "ai_rollup", "markup_reversal",
    "clawback", "clawback_debt", "writeoff", "merge",
)


def user_account_key(creator_id: int) -> str:
    return f"user:{int(creator_id)}"


def user_debt_account_key(creator_id: int) -> str:
    return f"user_debt:{int(creator_id)}"


def clearing_account_key(rail: str) -> str:
    if rail not in PURCHASE_RAILS:
        raise ValueError(f"unknown purchase rail {rail!r}")
    return f"sys:clearing_{rail}"
