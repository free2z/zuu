"""Bounded dispatch into exact reviewed native identities, never caller URLs."""

from __future__ import annotations

from decimal import Decimal
import re
from uuid import UUID

from django.urls import resolve
from rest_framework.exceptions import PermissionDenied, ValidationError

from . import catalog, financial
from .operations import _native, exact_etag, perform
from .registry import REGISTRY


BODY_FIELDS = {
    **financial.BODIES,
    "emails_notifications_create": {"value"},
    "emails_public_create": {"value"},
    "ai_conversations_fork_create": {"conversation", "prompt_response"},
    "reports_create": {"target_kind", "target_id", "reason", "details"},
    "tagging_zpage_suggestions_decide_create": {"accept", "dismiss"},
    "comments_vote_create": {"vote"},
    "zpage_vote_create": {"vote"},
    "comments_create": {"parent", "headline", "content", "tuzis"},
    "comments_create_2": {"headline", "content", "tuzis"},
    "comments_replies_create": {"headline", "content", "tuzis"},
    "comments_update": {"headline", "content"},
    "comments_partial_update": {"headline", "content"},
    "events_mention_preference_partial_update": {"enabled"},
    "zpage_translation_purchase": {
        "expected_price",
        "source_digest",
        "settlement_policy",
    },
    "zpage_translation_batch_purchase": {"items", "source_digest", "settlement_policy"},
    "dyte_host_session_create": {"host_session", "action"},
}
for verb in ("update", "partial_update"):
    BODY_FIELDS["myuploads_" + verb] = {"title", "description", "access"}
    BODY_FIELDS["zpage_variants_" + verb] = {
        "tags",
        "title",
        "content",
        "description",
        "is_published",
    }

for verb in ("create", "update", "partial_update"):
    BODY_FIELDS["ai_conversations_" + verb] = {
        "display_name",
        "is_public",
        "is_subscriber_only",
        "ai_model",
        "personality",
    }
    BODY_FIELDS["ai_personalities_" + verb] = {
        "display_name",
        "system_message",
        "is_public",
    }
    BODY_FIELDS["g12f_series_mine_" + verb] = {
        "name",
        "pageorder_set",
        "expected_pageorder_set",
        "expected_name",
    }


def _whole(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValidationError("Quoted prices must be nonnegative whole 2Z integers.")
    return value


def _spending(kind, body, key, ceiling):
    try:
        parsed = UUID(key)
        if parsed.version != 4 or str(parsed) != key:
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise ValidationError("Supply a canonical UUIDv4 idempotency_key.") from None
    if not isinstance(ceiling, str) or not re.fullmatch(
        r"[0-9]{1,12}(?:\.[0-9]{1,3})?", ceiling
    ):
        raise ValidationError(
            "Supply max_charge_tuzis as a nonnegative decimal string with at most three decimal places."
        )
    if kind == "donation":
        amount = _whole(body.get("amount"))
        if not 1 <= amount <= 2147483647:
            raise ValidationError("Donation amount must be 1..2147483647 whole 2Z.")
    elif kind == "membership":
        amount = _whole(body.get("expected_price"))
        if amount > 999999:
            raise ValidationError("expected_price must be at most 999999.")
    elif kind == "comment":
        amount = _whole(body.get("tuzis"))
        if amount < 1:
            raise ValidationError("Comments cost at least 1 2Z.")
    elif kind == "vote":
        amount = 1
    else:
        if not isinstance(body.get("source_digest"), str) or not re.fullmatch(
            r"[0-9a-f]{64}", body["source_digest"]
        ):
            raise ValidationError(
                "Use the quote's source_digest when purchasing a translation."
            )
        if kind == "translation":
            amount = _whole(body.get("expected_price"))
        else:
            items = body.get("items")
            if (
                not isinstance(items, list)
                or not 0 < len(items) <= 250
                or any(
                    not isinstance(item, dict)
                    or set(item) != {"language", "expected_price"}
                    for item in items
                )
            ):
                raise ValidationError(
                    "Use the batch quote's language/expected_price items."
                )
            amount = sum(_whole(item["expected_price"]) for item in items)
    if Decimal(amount) > Decimal(ceiling):
        raise ValidationError(
            {"code": "charge_limit_exceeded", "required_tuzis": str(amount)}
        )
    return amount


def invoke(
    raw,
    account,
    original,
    operation,
    *,
    write,
    path=None,
    query=None,
    body=None,
    if_match=None,
    if_none_match=None,
    source_language=None,
    idempotency_key=None,
    max_charge_tuzis=None,
):
    if operation == "publication_exports_download":
        if write or query or body or not isinstance(path, dict) or set(path) != {"id"}:
            raise ValidationError(
                "Read publication_exports_download with only path.id."
            )
        from .downloads import prepare_export

        return prepare_export(raw, account, original, path["id"])
    if operation == "mcp_prepare_download":
        if (
            not write
            or path
            or query
            or if_match
            or if_none_match
            or source_language
            or idempotency_key
            or max_charge_tuzis
            or not isinstance(body, dict)
            or set(body) != {"upload_id"}
            or type(body["upload_id"]) is not int
            or body["upload_id"] < 1
        ):
            raise ValidationError(
                "Execute mcp_prepare_download with only body.upload_id, a positive integer."
            )
        from .downloads import prepare

        return prepare(raw, account, original, body["upload_id"])
    row = REGISTRY.get(operation)
    if row is None:
        info = catalog.summary(operation)
        raise PermissionDenied(
            {
                "code": "operation_not_supported",
                "reason": info["reason"],
                "next_step": info["next_step"],
            }
        )
    if (row["method"] != "GET") != write:
        raise ValidationError("Use read for GET operations and execute for mutations.")
    path, query, body = path or {}, query or {}, body or {}
    entry = catalog.operations()[operation]
    if (entry["method"], entry["path"]) != (row["method"], row["path"]):
        raise PermissionDenied(
            "This operation's reviewed route no longer matches the schema."
        )
    placeholders = set(re.findall(r"\{([^}]+)\}", row["path"]))
    if set(path) != placeholders:
        raise ValidationError({"path": "Supply exactly the described path parameters."})
    concrete = row["path"]
    for name, value in path.items():
        value = str(value)
        if (
            not value
            or len(value) > 150
            or any(c in value for c in "/\\%?#\x00")
            or value in {".", ".."}
        ):
            raise ValidationError("Invalid path parameter.")
        concrete = concrete.replace("{" + name + "}", value)
    allowed_query = {
        p["name"] for p in entry.get("parameters", []) if p["in"] == "query"
    }
    if operation == financial.STATUS:
        allowed_query.add("recipient_id")
    if set(query) - allowed_query or len(str(query)) > 8192:
        raise ValidationError("Use only the described query parameters.")
    if any(
        isinstance(v, dict)
        or (isinstance(v, list) and any(isinstance(x, (list, dict)) for x in v))
        for v in query.values()
    ):
        raise ValidationError("Query values must be scalars or lists of scalars.")
    if set(body) - BODY_FIELDS.get(operation, set()):
        raise ValidationError({"body": "Unsupported fields for this hosted operation."})
    if (
        operation in {"emails_notifications_create", "emails_public_create"}
        and type(body.get("value")) is not bool
    ):
        raise ValidationError(
            "Supply an explicit boolean body.value for this preference."
        )
    authority = catalog.policy(operation)
    if authority["paid"]:
        _spending(authority["paid"], body, idempotency_key, max_charge_tuzis)
    elif max_charge_tuzis is not None or idempotency_key is not None:
        raise ValidationError(
            "This operation does not accept spending or retry-key arguments."
        )
    recipient = (
        financial.recipient_id(operation, path, body, query)
        if operation in financial.FINANCIAL
        else None
    )
    if recipient is not None and (
        if_match is not None
        or if_none_match is not None
        or source_language is not None
        or (query and operation != financial.STATUS)
    ):
        raise ValidationError(
            "Financial calls accept only their described recipient and intent arguments."
        )
    create_only = False
    if (
        operation.startswith("zpage_variants_") and write
    ) or operation == "zpage_destroy":
        create_only = (
            row["method"] == "PUT" and if_none_match == "*" and if_match is None
        )
        matched = exact_etag(if_match) and if_none_match is None
        if not (create_only or matched):
            raise ValidationError(
                "Supply one exact current ETag as if_match. Only PUT creation accepts if_none_match='*'."
            )
    if create_only and "tags" in body:
        raise ValidationError(
            "Create-only translations preserve current page tags. Omit tags; edit parent tags separately with its ETag."
        )
    if operation == "dyte_host_session_create" and body.get("action") not in {
        "heartbeat",
        "release",
    }:
        raise ValidationError("Host-session actions are heartbeat or release.")
    headers = {
        name: value
        for name, value in {
            "If-Match": if_match,
            "If-None-Match": if_none_match,
            "X-Free2Z-Source-Language": source_language,
            "Idempotency-Key": idempotency_key,
        }.items()
        if value is not None
    }

    def call(actor):
        match = resolve(concrete)
        view = getattr(match.func, "cls", None)
        actual_view = f"{view.__module__}.{view.__name__}" if view else None
        action = getattr(match.func, "actions", {}).get(row["method"].lower())
        if (actual_view, action, match.url_name) != (
            row["view"],
            row["action"],
            row["url_name"],
        ):
            raise PermissionDenied(
                "The operation's native identity changed; review is required."
            )
        if (
            row.get("function")
            and f"{match.func.__module__}.{match.func.__name__}" != row["function"]
        ):
            raise PermissionDenied("The operation's native callback changed.")
        if operation.startswith("myuploads_") and write:
            from dj.apps.uploads.models import GenericFile

            media = (
                GenericFile.objects.select_for_update()
                .filter(pk=path["id"], owner=actor.user)
                .first()
            )
            if (
                media
                and (media.access == "public" or body.get("access") == "public")
                and "mcp:publish" not in actor.scopes
            ):
                raise PermissionDenied(
                    "Changing or deleting public media requires mcp:publish."
                )
        native_body = body
        native_kwargs = match.kwargs
        if create_only:
            from dj.apps.g12f.models import zPage
            from dj.apps.g12f.identifiers import resolve_zpage_pk

            parent = (
                zPage.objects.select_for_update()
                .filter(pk=resolve_zpage_pk(path["id"]), creator=actor.user)
                .first()
            )
            if parent is None:
                raise PermissionDenied("Page is not owned by the selected account.")
            # Native PUT requires tags and writes them onto the parent. An
            # absent-language precondition cannot authorize a parent overwrite;
            # preserve its current tags under the same lock as the native save.
            native_body = {**body, "tags": list(parent.tags.names())}
            # Pin native dispatch to the immutable identity already authorized;
            # a concurrent vanity rename must not resolve a different parent.
            native_kwargs = {**match.kwargs, "pk": parent.free2zaddr}

        def native_financial(star, data):
            kwargs = {**match.kwargs}
            if "username" in kwargs:
                kwargs["username"] = star.username
            if operation == financial.DONATE:
                kwargs["recipient_id"] = star.pk
            return _native(
                actor,
                original,
                view,
                row["method"],
                concrete,
                action=action,
                kwargs=kwargs,
                body=data if write else None,
                headers=headers,
            )

        if recipient is not None:
            return financial.execute(
                actor,
                operation,
                recipient,
                body,
                idempotency_key,
                max_charge_tuzis,
                native_financial,
                original,
            )
        result = _native(
            actor,
            original,
            view,
            row["method"],
            concrete,
            action=action,
            kwargs=native_kwargs,
            query=query,
            body=native_body if write else None,
            headers=headers,
        )
        return result

    # Lifecycle locks serialize same-account purchases. Native idempotency,
    # debit and jobs commit in this transaction, with enqueue on_commit. A
    # lost response can replay the durable native receipt, never another debit.
    return perform(
        raw,
        account,
        original,
        operation,
        authority["required_scopes"],
        call,
        creator_ids=(() if recipient is None else (recipient,)),
    )
