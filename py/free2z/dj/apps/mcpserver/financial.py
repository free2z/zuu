"""Narrow hosted financial delegation over native receipts and subscriptions.

No balance writer or second receipt table: the hosted intent is committed on
native IdempotencyKey receipts in the SAME transaction as native settlement.
"""

from decimal import Decimal

from rest_framework.exceptions import APIException, PermissionDenied, ValidationError

DONATE = "tuzis_donate_idempotent_create"
PURCHASE = "tuzis_subscribe_confirmed_create"
RECOVER = "tuzis_subscribe_recovery_create"
CAP = "tuzis_subscribe_partial_update"
CANCEL = "tuzis_subscribe_destroy"
STATUS = "tuzis_subscription_status_retrieve"
FINANCIAL = {DONATE, PURCHASE, RECOVER, CAP, CANCEL, STATUS}
BODIES = {
    DONATE: {"recipient_id", "amount", "anon"},
    PURCHASE: {"recipient_id", "expected_price", "renewal_max_price"},
    RECOVER: {"key", "expected_price", "username"},
    CAP: {"recipient_id", "max_price"},
    CANCEL: {"recipient_id"},
    STATUS: set(),
}


def recipient_id(operation, path, body, query):
    # Reads use query.recipient_id; recovery already has an immutable path id.
    value = (
        path.get("creator_id")
        if operation == RECOVER
        else query.get("recipient_id")
        if operation == STATUS
        else body.get("recipient_id")
    )
    if type(value) is not int or value < 1:
        raise ValidationError(
            "Supply the exact positive integer recipient_id from the creator profile."
        )
    return value


def scopes(operation):
    if operation in {CAP, CANCEL}:
        return ["mcp:renew"]
    return ["mcp:account"] if operation == STATUS else ["mcp:transfer"]


class IntentMismatch(APIException):
    status_code = 409


def _mismatch():
    raise IntentMismatch(
        {
            "code": "idempotency_mismatch",
            "detail": "Retain the original payer, recipient, price, renewal policy and ceiling; use a fresh key for a new intent.",
        }
    )


def execute(actor, operation, recipient, body, key, ceiling, native, original):
    from dj.apps.g12f.models import Creator, Subscription
    from dj.apps.tuzis.models import IdempotencyKey, uuid4_key
    from dj.apps.tuzis.views import CONFIRMED_SUBSCRIBE_SCOPE

    star = Creator.objects.get(pk=recipient)  # already locked by authorization
    native_body = {
        k: v for k, v in body.items() if k not in {"recipient_id", "renewal_max_price"}
    }
    records = []
    binding = None
    replay = False
    if operation in {DONATE, PURCHASE}:
        binding = {
            "version": 1,
            "payer": actor.user.pk,
            "recipient": recipient,
            "operation": operation,
            "body": body,
            "max_charge_tuzis": ceiling,
        }
        scope = (
            "donate-idempotent" if operation == DONATE else CONFIRMED_SUBSCRIBE_SCOPE
        )
        # A connection can select several payers. Reusing its pending handle
        # with another selected payer is changed intent, not a second gift.
        # Use only this connection's linked accounts and native receipt indexes;
        # the connection lifecycle lock serializes this check with its calls.
        payer_ids = actor.connection.account_grants.values_list("user_id", flat=True)
        prior = IdempotencyKey.objects.filter(
            user_id__in=payer_ids, key=key, scope=scope
        )
        for record in prior:
            stored = (record.response_body or {}).get("_mcp_financial")
            # Native browser receipts have looser cross-route compatibility;
            # they cannot prove this stricter hosted intent. Never reuse them.
            if stored != binding:
                _mismatch()
            replay = record.response_status is not None
        if operation == DONATE:
            if type(body.get("anon")) is not bool:
                raise ValidationError("Supply an explicit boolean anon.")
        else:
            renewal = body.get("renewal_max_price")
            if type(renewal) is not int or renewal < 0:
                raise ValidationError(
                    "Supply an explicit whole renewal_max_price (0 disables renewals)."
                )
            if renewal > 0 and "mcp:renew" not in actor.scopes:
                raise PermissionDenied(
                    "Future membership spending requires separate mcp:renew consent."
                )
            sub = Subscription.objects.filter(fan=actor.user, star=star).first()
            if not replay:
                if sub is None:
                    if renewal not in {0, body["expected_price"]}:
                        raise ValidationError(
                            "A new membership's renewal_max_price must be 0 or expected_price. Update its cap separately afterwards."
                        )
                elif Decimal(renewal) != sub.max_price:
                    raise ValidationError(
                        "Existing memberships retain their renewal cap. Read status and explicitly update or cancel it before buying."
                    )
            native_body["creator_id"] = recipient
    elif operation == RECOVER:
        if uuid4_key(body.get("key")) != body.get("key") or not body.get("key"):
            raise ValidationError("Supply the original canonical UUIDv4 key.")

    result = native(star, native_body)
    if result["status"] < 400 and binding is not None:
        if operation == PURCHASE and not replay and body["renewal_max_price"] == 0:
            # Native creation inherits expected_price. Revoke that future
            # authority before the outer transaction commits or jobs can run.
            # This is the native cancellation policy, not another money path.
            from dj.apps.tuzis.views import CreatorSubscribeView
            from .operations import _native

            cancelled = _native(
                actor,
                original,
                CreatorSubscribeView,
                "DELETE",
                f"/api/tuzis/subscribe/{star.username}",
                kwargs={"username": star.username},
            )
            if cancelled["status"] >= 400:
                raise ValidationError(
                    "Could not disable renewals; the purchase was rolled back."
                )
        scopes_to_bind = (
            ["donate-idempotent"]
            if operation == DONATE
            else [CONFIRMED_SUBSCRIBE_SCOPE, f"subscribe-intent:{recipient}"]
        )
        records = list(
            IdempotencyKey.objects.filter(
                user=actor.user, key=key, scope__in=scopes_to_bind
            )
        )
        if not records:
            raise RuntimeError("Native settlement did not persist a receipt")
        for record in records:
            stored = dict(record.response_body)
            stored["_mcp_financial"] = binding
            if operation == PURCHASE and not replay and body["renewal_max_price"] == 0:
                stored["subscription"] = {**stored["subscription"], "max_price": "0"}
                result["data"]["subscription"]["max_price"] = "0"
            record.response_body = stored
            record.save(update_fields=["response_body"])
    if result["status"] < 400:
        if operation in {DONATE, PURCHASE}:
            result["charge_tuzis"] = (
                result["data"]["charged"]
                if operation == DONATE
                else str(body["expected_price"] if result["data"]["charged"] else 0)
            )
        result["payer_account_id"] = str(actor.account_id)
        result["recipient_id"] = recipient
        if operation != DONATE:
            sub = Subscription.objects.filter(fan=actor.user, star=star).first()
            result["renewal_policy"] = (
                None
                if sub is None
                else {
                    "max_price": str(sub.max_price),
                    "automatic_renewal": sub.max_price > 0,
                    "expires": sub.expires.isoformat(),
                }
            )
    return result


CONTRACT = {
    "recipient": "Exact positive integer recipient_id is authoritative, prelocked before native entry; path.username is a display locator. Select account explicitly from list_accounts.",
    "retry": "Charging calls require a canonical lowercase hyphenated UUIDv4 idempotency_key and decimal-string max_charge_tuzis. Keep the same payer, recipient, body, ceiling and key after ambiguity. Changed intent returns 409. Native receipts retain their native retention period; never fall back to legacy charging routes.",
    "consent": "mcp:transfer authorizes immediate donation/membership debit only. mcp:renew separately authorizes future recurring spending and cap management. mcp:spend grants neither. No scope or omitted field defaults a purchase into recurrence.",
    "receipt": {
        "donation": "charge_tuzis: decimal string original transferred 2Z. data.balance: decimal string frozen at original settlement; data.charged: decimal string original transferred 2Z; data.replayed: boolean. payer_account_id: selected grant UUID; recipient_id: immutable Creator integer.",
        "membership": "charge_tuzis: decimal string exact original debit (0 for debounce/free extension). data.balance: decimal string live at reply; data.charged: boolean (native extension outcome, true also for free extension); data.replayed: boolean; data.expires: original receipt expiry; data.subscription: original receipt fan/star/expires/max_price snapshot. payer_account_id: selected grant UUID; recipient_id: immutable Creator integer. Replaying does not restore an old renewal cap or undo cancellation.",
        "renewal_policy": "Top-level live renewal_policy is null when no subscription exists; otherwise it has max_price (decimal string 2Z per native 30-day renewal), automatic_renewal (boolean; false at cap 0), expires (live ISO timestamp). Native eligibility/balance/active-account gates remain authoritative. A worker may attempt renewal 24 hours before expiry. A cancellation that wins the locks blocks renewal; one that follows a committed renewal preserves that expiry and disables subsequent renewals. Revoking OAuth stops delegated calls; cancel the subscription separately to revoke already-created recurring authority.",
    },
    "purchase": "Require body.recipient_id, whole expected_price and explicit whole renewal_max_price. For a new membership choose 0 (one purchase, no recurrence) or expected_price (requires mcp:renew). Existing memberships retain their cap; explicitly acknowledge it. Update/cancel separately before purchasing under a different policy. No renewal-policy change is applied on receipt replay.",
    "cap": "PATCH requires body.recipient_id and native max_price (whole 1..1000000, within native price/balance rules). No immediate charge; mcp:renew required. DELETE requires body.recipient_id and sets max_price=0; preserves paid expiry, works for an inactive recipient and requires mcp:renew. PATCH data has fan/star/expires/max_price; DELETE data is the string OK. Both also return live renewal_policy. These are explicit policy setters, not new purchases; no retry key/charge ceiling accepted.",
    "recovery": "Recovery path.creator_id is immutable; body.key must be the original canonical UUIDv4. Optional expected_price/username identify historical native receipts. data.status is resolved (committed receipt), abandoned (terminal fence against that key), or unchanged (no evidence). No debit or new recurring authority; never interpret an ambiguous response as rollback.",
}
