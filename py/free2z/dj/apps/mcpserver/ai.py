"""Account-explicit, bounded asynchronous access to native AI metering."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from types import SimpleNamespace
from uuid import UUID

from django.conf import settings
from django.core import signing
from django.db import connection, transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import PermissionDenied, Throttled, ValidationError

from dj.apps.oidc.mcp import authorized_actor, record_action
from dj.apps.oidc.models import MCPAIRequest
from dj.apps.openai.models import AIModel
from dj.apps.openai import views as native
from .operations import _request

SCOPE = "mcp:ai"
QUANTUM = Decimal("0.001")
SALT = "free2z.mcp.ai.quote.v1"


@contextmanager
def bounded_transaction():
    """Transaction-local limits are safe through transaction-mode poolers."""
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout = '3s'")
            cursor.execute("SET LOCAL statement_timeout = '10s'")
        yield


def _enabled():
    if not settings.MCP_AI_ENABLED:
        raise PermissionDenied("Metered AI is not enabled on this server.")


def _models():
    # A provider must have actually returned this identifier and its reviewed
    # price must still be valid. Legacy catalogue discovery can fail open.
    return AIModel.objects.selectable().discovered(upstream=False, require_snapshot=True).filter(
        input_price__gt=0, output_price__gt=0, price_checked_at__isnull=False,
    )


def _metadata(model):
    from dj.apps.openai.cache_pricing import cache_price_fractions
    expiry = getattr(model, "price_valid_until", None)
    fractions = cache_price_fractions(model.provider, model.model)
    return {
        "id": str(model.pk), "provider": model.provider, "model": model.model,
        "display_name": model.display_name,
        "input_usd_per_token": str(model.input_price),
        "output_usd_per_token": str(model.output_price),
        "cache_input_usd_per_token": {
            name: str(Decimal(str(model.input_price)) * Decimal(num) / Decimal(den))
            for name, (num, den) in zip(("read", "write_5m", "write_1h"), fractions)
        },
        "cache_price_fractions": [list(pair) for pair in fractions],
        "price_checked_at": model.price_checked_at.isoformat(),
        "charge_rounding": "ceiling",
        "maximum_response_tokens": model.get_max_response_tokens(),
        "markup_multiplier": str(model.markup),
        "charge_quantum_tuzis": "0.001", "usd_per_2z": "0.01",
        "price_valid_until": expiry.isoformat() if expiry else None,
        "privacy_policy_url": native.PROVIDER_PRIVACY_URLS.get(model.provider),
    }


def list_models(raw, account):
    from dj.apps.openai.provider_inventory import provider_inventory
    with bounded_transaction(), authorized_actor(raw, account, [SCOPE]) as actor:
        return {"account": actor.user.username, "inventory": provider_inventory(), "models": [_metadata(m) for m in _models()] if settings.MCP_AI_ENABLED else [],
                "enabled": settings.MCP_AI_ENABLED,
                "retention": "Prompt and result content is kept for up to 24 hours plus hourly cleanup; billing and retry records persist. Provider policies also apply."}


def _quote(model, intent):
    system = intent["system_message"]
    messages = ([{"role": "system", "content": system}] if system else [])
    messages.append({"role": "user", "content": intent["prompt"]})
    tokens = native.num_tokens_from_messages(messages, model.model)
    window = native.count_prompt_tokens(messages, model.model)
    if window > model.get_input_token_budget():
        raise ValidationError("Prompt exceeds the model's input budget.")
    cap = model.get_request_output_cap(window, intent["max_output_tokens"])
    amount = model.get_admission_price(tokens, cap, quantum=QUANTUM)
    return {**_metadata(model), "max_charge_tuzis": str(amount),
            "max_output_tokens": cap, "input_tokens_estimate": tokens,
            "reasoning_allowance_tokens": model.get_reasoning_allowance()}


def quote(raw, account, model, prompt, max_output_tokens, system_message=None):
    _enabled()
    serializer = native.MeteredPromptRequestSerializer(data={
        "model": model, "prompt": prompt, "max_output_tokens": max_output_tokens,
        "system_message": system_message,
    })
    serializer.is_valid(raise_exception=True)
    with bounded_transaction(), authorized_actor(raw, account, [SCOPE]) as actor:
        selected = _models().filter(pk=serializer.validated_data["model"]).first()
        if selected is None:
            raise ValidationError("Model is unavailable or has no current reviewed price.")
        intent = {"model": str(selected.pk), "prompt": prompt,
                  "system_message": selected.system_message if system_message is None else system_message,
                  "max_output_tokens": max_output_tokens}
        pricing = _quote(selected, intent)
        expires = timezone.now() + timedelta(minutes=15)
        if getattr(selected, "price_valid_until", None):
            expires = min(expires, selected.price_valid_until)
        row = MCPAIRequest.objects.create(
            connection=actor.connection, account_grant_id=actor.account_id,
            access_token=actor.auth.row,
            grant_generation=actor.connection.account_grants.get(pk=actor.account_id).generation,
            intent=intent, quote=pricing, quote_expires_at=expires,
            content_expires_at=timezone.now() + timedelta(hours=24),
        )
        record_action(actor, "quote_ai", 200)
        return {"account": actor.user.username, **pricing,
                "quote_token": signing.dumps(str(row.pk), salt=SALT),
                "expires_at": expires.isoformat(),
                "notice": "Starting this quote authorizes the quoted maximum charge. Provider usage settles at the selected model's rates and markup, rounded up to 0.001 2Z. No provider subscription is required. Free2Z and provider retention policies apply."}


def _owned(actor, request_id):
    try:
        return MCPAIRequest.objects.select_for_update().get(
            pk=request_id, connection=actor.connection, account_grant_id=actor.account_id,
        )
    except (MCPAIRequest.DoesNotExist, ValueError):
        raise PermissionDenied("No such AI request for this account and connection.")


def _result(row, actor):
    return {"account": actor.user.username, "request_id": str(row.pk),
            "state": row.state, "quote": row.quote, "receipt": row.receipt,
            "content_expires_at": row.content_expires_at.isoformat(),
            "content_purged": row.content_purged}


def start(raw, account, quote_token, max_charge_tuzis, idempotency_key):
    _enabled()
    try:
        request_id = signing.loads(quote_token, salt=SALT)
        key = UUID(str(idempotency_key))
        if key.version != 4:
            raise ValueError()
        ceiling = Decimal(max_charge_tuzis)
        if not ceiling.is_finite() or ceiling < 0 or ceiling != ceiling.quantize(QUANTUM):
            raise ValueError()
    except (signing.BadSignature, ValueError, InvalidOperation):
        raise ValidationError("Use an issued quote, a UUIDv4 retry key and a finite maximum charge with at most three decimal places.")
    with bounded_transaction(), authorized_actor(raw, account, [SCOPE]) as actor:
        row = _owned(actor, request_id)
        prior = MCPAIRequest.objects.filter(
            connection=actor.connection, account_grant_id=actor.account_id, idempotency_key=key,
        ).first()
        if prior:
            if prior.pk != row.pk:
                raise ValidationError("This retry key belongs to a different quote.")
            return _result(prior, actor)
        if row.state != "quoted":
            raise ValidationError("This quote has already been used; poll its request ID.")
        # authorized_actor holds the selected Creator lock, serializing this
        # account-wide limit across applications, connections and linked grants.
        live = Q(state="queued", quote_expires_at__gt=timezone.now()) | Q(
            state="running", started_at__gt=timezone.now() - timedelta(minutes=20),
        )
        if MCPAIRequest.objects.filter(live, account_grant__user=actor.user).count() >= 2:
            raise Throttled(wait=60, detail="This account already has two pending AI requests. Poll or cancel one before starting another.")
        if row.quote_expires_at <= timezone.now() or row.content_purged:
            raise ValidationError("Quote expired; request a fresh quote.")
        if ceiling < Decimal(row.quote["max_charge_tuzis"]):
            raise ValidationError("Maximum charge is below the quoted ceiling.")
        grant = actor.connection.account_grants.get(pk=actor.account_id)
        if row.grant_generation != grant.generation:
            raise PermissionDenied("Account consent changed; request a fresh quote.")
        row.state = "queued"
        row.idempotency_key = key
        row.access_token = actor.auth.row
        row.save(update_fields=["state", "idempotency_key", "access_token"])
        from dj.apps.oidc.tasks import invoke_mcp_ai
        invoke_mcp_ai.defer(request_id=str(row.pk))
        record_action(actor, "start_ai", 202)
        return _result(row, actor)


def get(raw, account, request_id, cancel=False):
    with bounded_transaction(), authorized_actor(raw, account, [SCOPE]) as actor:
        row = _owned(actor, request_id)
        if row.state == "running":
            from dj.apps.tuzis.models import IdempotencyKey
            committed = IdempotencyKey.objects.filter(
                scope="mcp_ai_prompt", key=str(row.native_key), user=actor.user,
                response_status__isnull=False,
            ).first()
            if committed is not None:
                row.receipt = committed.response_body
                row.receipt["http_status"] = committed.response_status
                row.state = "completed" if committed.response_status == 200 else "failed"
                row.finished_at = committed.created_at
                row.content_expires_at = row.finished_at + timedelta(hours=24)
                row.save(update_fields=["receipt", "state", "finished_at", "content_expires_at"])
            elif row.started_at < timezone.now() - timedelta(minutes=20):
                row.state = "unknown"
                row.receipt = {"charge_status": "unknown", "detail": "Provider outcome is uncertain. This request will never be dispatched again. Expired reservations are returned by the ledger's hold expiry process."}
                row.finished_at = timezone.now()
                row.save(update_fields=["state", "receipt", "finished_at"])
        if row.content_expires_at <= timezone.now():
            row.receipt.pop("response", None)
        if cancel and row.state in {"quoted", "queued"}:
            row.state, row.finished_at = "cancelled", timezone.now()
            row.receipt = {"charge_status": "not_charged", "tuzis_charged": "0.000"}
            row.save(update_fields=["state", "finished_at", "receipt"])
            record_action(actor, "cancel_ai", 200)
        result = _result(row, actor)
        if cancel and row.state == "running":
            result["notice"] = "The provider call has started and cannot be cancelled. Reported usage will settle within the quoted maximum; poll this request for its receipt."
        if row.state == "running" and row.started_at < timezone.now() - timedelta(minutes=20):
            result["notice"] = "Provider outcome is uncertain; this request will never be dispatched again. Any expired reservation is returned by the ledger's hold expiry process."
        return result


class MCPMeteredPromptView(native.MeteredPromptView):
    pricing_quantum = QUANTUM
    idempotency_scope = "mcp_ai_prompt"
    invocation_id = None

    def billing_transaction(self):
        return bounded_transaction()

    def claim_context(self):
        return bounded_transaction()

    def release_reservation(self, reservation):
        with bounded_transaction():
            return native.ledger.release_reservation(reservation)

    @contextmanager
    def reservation_context(self, request, ai_model, max_price):
        _enabled()
        initial = MCPAIRequest.objects.select_related("access_token").get(pk=self.invocation_id)
        if initial.access_token is None:
            raise PermissionDenied("Connection token is no longer valid.")
        with bounded_transaction(), authorized_actor(initial.access_token.token, str(initial.account_grant_id), [SCOPE]) as actor:
            row = _owned(actor, initial.pk)
            grant = actor.connection.account_grants.get(pk=actor.account_id)
            if row.state != "running" or row.grant_generation != grant.generation:
                raise PermissionDenied("AI request authority changed before dispatch.")
            current = _models().filter(pk=ai_model.pk).first()
            if current is None or row.quote_expires_at <= timezone.now() or _quote(current, row.intent) != row.quote:
                raise ValidationError("Model availability or price changed; request a new quote.")
            if Decimal(row.quote["max_charge_tuzis"]) != max_price:
                raise ValidationError("Quote no longer matches the reservation.")
            yield


def invoke(request_id):
    """At most one dispatch, even if the queue redelivers after worker death."""
    with bounded_transaction():
        row = MCPAIRequest.objects.select_for_update(of=("self",)).select_related(
            "access_token", "account_grant__user",
        ).get(pk=request_id)
        if row.state != "queued":
            return
        row.state, row.started_at = "running", timezone.now()
        row.save(update_fields=["state", "started_at"])
        intent, native_key, user, token = row.intent, row.native_key, row.account_grant.user, row.access_token
    # The request row and every account lock are released before provider I/O.
    class Authentication(BaseAuthentication):
        def authenticate(self, request):
            return user, token
    actor = SimpleNamespace(user=user)
    request = _request(actor, SimpleNamespace(META={}), "POST", "/api/ai/prompt/", intent,
                       headers={"Idempotency-Key": str(native_key)})
    try:
        response = MCPMeteredPromptView.as_view(
            invocation_id=request_id, authentication_classes=(Authentication,),
        )(request)
        import json
        from django.core.serializers.json import DjangoJSONEncoder
        receipt = json.loads(json.dumps(response.data, cls=DjangoJSONEncoder))
        if not isinstance(receipt, dict):
            receipt = {"detail": receipt}
        if response.status_code < 500 and response.status_code != 200:
            receipt.setdefault("charge_status", "not_charged")
            receipt.setdefault("tuzis_charged", "0.000")
        receipt["http_status"] = response.status_code
        state = "completed" if response.status_code == 200 else "failed"
        # A generic provider failure can mean its acceptance was unobservable.
        if response.status_code >= 500 and receipt.get("charge_status") != "settled":
            state = "unknown"
    except Exception:
        # Never log prompt/provider exception text or automatically re-dispatch.
        receipt = {"charge_status": "unknown", "detail": "Outcome unavailable. This request will not be sent again."}
        state = "unknown"
    with bounded_transaction():
        row = MCPAIRequest.objects.select_for_update().get(pk=request_id)
        row.state, row.receipt, row.finished_at = state, receipt, timezone.now()
        row.content_expires_at = row.finished_at + timedelta(hours=24)
        row.save(update_fields=["state", "receipt", "finished_at", "content_expires_at"])


def purge_content():
    """Bound prompt/result retention without deleting billing/retry identity."""
    from dj.apps.tuzis.models import IdempotencyKey
    from django.db.models.expressions import RawSQL
    due = MCPAIRequest.objects.filter(content_purged=False, content_expires_at__lte=timezone.now())
    for pk in due.values_list("pk", flat=True).iterator(chunk_size=500):
        with bounded_transaction():
            row = MCPAIRequest.objects.select_for_update().get(pk=pk)
            if row.content_purged or row.content_expires_at > timezone.now():
                continue
            row.intent = {}
            row.receipt.pop("response", None)
            row.content_purged = True
            if row.state in {"quoted", "queued"}:
                row.state = "expired"
            elif row.state == "running":
                row.state = "unknown"
            row.save(update_fields=["intent", "receipt", "content_purged", "state"])
            IdempotencyKey.objects.filter(scope="mcp_ai_prompt", key=str(row.native_key)).update(
                response_body=RawSQL("response_body - 'response'", []),
            )

    # Connections/grants can be deleted independently of the billed account.
    # Scrub orphaned native receipts too; their financial metadata survives.
    IdempotencyKey.objects.filter(
        scope="mcp_ai_prompt", created_at__lte=timezone.now() - timedelta(hours=24),
        response_body__has_key="response",
    ).update(response_body=RawSQL("response_body - 'response'", []))
