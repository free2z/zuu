"""Explicit MCP operations using the application's existing view actions.

There is no caller-selected URL, view, authenticator, or arbitrary header. The
selected account is resolved and locked by the OAuth connection before every
operation. Native permissions, serializers, throttles, publication side effects,
idempotency, and ETag checks run unchanged.
"""
from __future__ import annotations

import json
import re
from io import BytesIO
from urllib.parse import urlencode, urlsplit

from django.core.handlers.wsgi import WSGIRequest
from django.core.serializers.json import DjangoJSONEncoder
from django.http import Http404
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError


READ = "mcp:read"
WRITE = "mcp:write"
PUBLISH = "mcp:publish"
UPLOAD = "mcp:uploads"


class NativeRejected(Exception):
    """Leave the authorization transaction before returning a DRF refusal."""
    def __init__(self, response):
        self.response = response


def _request(actor, original, method, path, body=None, query=None, headers=None):
    from dj.apps.oidc.mcp import mcp_resource
    origin = urlsplit(mcp_resource())
    data = b"" if body is None else json.dumps(body, cls=DjangoJSONEncoder).encode()
    env = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "QUERY_STRING": urlencode(query or {}, doseq=True),
        "SERVER_NAME": origin.hostname,
        "SERVER_PORT": str(origin.port or (443 if origin.scheme == "https" else 80)),
        "SERVER_PROTOCOL": "HTTP/1.1",
        "HTTP_HOST": origin.netloc,
        "REMOTE_ADDR": original.META.get("REMOTE_ADDR", ""),
        "wsgi.url_scheme": origin.scheme,
        "wsgi.input": BytesIO(data),
        "CONTENT_LENGTH": str(len(data)),
        "CONTENT_TYPE": "application/json",
        "HTTP_ACCEPT": "application/json",
    }
    # Only server-selected keys can reach this parameter. Public tools expose
    # if_match/idempotency_key arguments, never a free-form header dictionary.
    for key, value in (headers or {}).items():
        if key not in {"If-Match", "If-None-Match", "X-Free2Z-Source-Language", "Idempotency-Key"} or "\r" in value or "\n" in value:
            raise ValidationError("Unsupported request header.")
        env["HTTP_" + key.upper().replace("-", "_")] = value
    request = WSGIRequest(env)
    request.user = actor.user
    request.mcp_actor = actor
    return request


def _native(actor, original, view, method, path, *, action=None, body=None, query=None, headers=None, kwargs=None):
    class SelectedAccountAuthentication(BaseAuthentication):
        def authenticate(self, request):
            # This class exists only inside this invocation. The actor's
            # authorization locks remain held until rendering and auditing end.
            return actor.user, actor.auth

    request = _request(actor, original, method, path, body, query, headers)
    options = {"authentication_classes": (SelectedAccountAuthentication,)}
    callback = view.as_view({method.lower(): action}, **options) if action else view.as_view(**options)
    response = callback(request, **(kwargs or {}))
    if hasattr(response, "render"):
        response.render()
    if getattr(response, "exception", False):
        # The outer HTTP response is a successful MCP envelope even when a tool
        # fails. Preserve AtomicMiddleware's native rollback-on-exception rule.
        raise NativeRejected(response)
    return _result(response)


def _result(response):
    selected = {name.lower(): response[name] for name in (
        "ETag", "Retry-After", "Idempotent-Replayed", "Idempotency-Key-Honored",
    ) if name in response}
    data = json.loads(response.content) if response.content else None
    return {"status": response.status_code, "headers": selected, "data": data}


def _error(exc):
    if isinstance(exc, NativeRejected):
        return _result(exc.response)
    if isinstance(exc, Http404):
        return {"status": 404, "data": {"detail": "Not found."}, "headers": {}}
    if isinstance(exc, APIException):
        return {"status": exc.status_code, "data": exc.detail, "headers": {}}
    raise exc


def perform(raw_token, account, original, operation, scopes, callback, *, creator_ids=()):
    from dj.apps.oidc.mcp import authorized_actor, record_action
    actor = None
    try:
        with authorized_actor(raw_token, account, scopes, creator_ids=creator_ids) as actor:
            result = callback(actor)
            record_action(actor, operation, result["status"])
            result["account"] = actor.user.username
            return result
    except (NativeRejected, APIException, Http404) as exc:
        result = _error(exc)
        if actor is not None:
            record_action(actor, operation, result["status"])
            result["account"] = actor.user.username
        return result


def connection_accounts(raw):
    from dj.apps.g12f.models import Creator
    from dj.apps.oidc.mcp import authenticate_mcp, list_accounts
    principal = authenticate_mcp(raw)
    return {
        "connection_id": str(principal.connection_id),
        "connection_owner": Creator.objects.get(pk=principal.user_id).username,
        "accounts": list_accounts(raw),
    }


def list_pages(raw, account, original, *, search="", mine=False, page=1):
    from dj.apps.g12f.views.zpage import zPageView
    return perform(raw, account, original, "list_pages", (READ,), lambda actor: _native(
        actor, original, zPageView, "GET", "/api/zpage/", action="list",
        query={"search": search, "mine": str(mine).lower(), "page": page},
    ))


def get_page(raw, account, original, page_id):
    from dj.apps.g12f.models import zPage
    from dj.apps.g12f.views.zpage import zPageView
    return perform(raw, account, original, "get_page", (READ,), lambda actor: _native(
        actor, original, zPageView, "GET", f"/api/zpage/{page_id}/", action="retrieve",
        query={"mine": str(zPage.objects.filter(free2zaddr=page_id, creator=actor.user).exists()).lower()},
        kwargs={"pk": str(page_id)},
    ))


def create_draft(raw, account, original, fields, idempotency_key):
    from dj.apps.g12f.views.zpage import zPageView
    def create(actor):
        result = _native(
            actor, original, zPageView, "POST", "/api/zpage/", action="create",
            body={"tags": [], **fields, "is_published": False}, headers={"Idempotency-Key": str(idempotency_key)},
        )
        data = result["data"]
        if result["status"] == 402 and isinstance(data, dict) and data.get("action") == "page_create":
            # This native rule checks eligibility, not a debit. Its shared
            # finance response calls the threshold 'cost' and exposes a private
            # balance; neither belongs in the hosted content permission.
            result["data"] = {
                "code": "minimum_balance_required", "required_balance": data["cost"],
                "detail": data["detail"],
            }
        return result
    return perform(raw, account, original, "create_draft", (WRITE,), create)


def exact_etag(value):
    return isinstance(value, str) and re.fullmatch(r'"[^"\r\n,]+"', value.strip()) is not None


def update_page(raw, account, original, page_id, changes, if_match, *, published=None):
    from dj.apps.g12f.models import zPage
    from dj.apps.g12f.views.zpage import zPageView
    if not exact_etag(if_match):
        raise ValidationError("Read the page and supply its exact ETag as if_match.")
    scopes = (WRITE, PUBLISH) if published is not None else (WRITE,)
    operation = "set_page_published" if published is not None else "update_page"

    def update(actor):
        page = zPage.objects.select_for_update().filter(free2zaddr=page_id, creator_id=actor.user.pk).first()
        if page is None:
            raise Http404
        if page.is_published and PUBLISH not in actor.scopes:
            raise PermissionDenied("Editing a published page requires mcp:publish.")
        body = dict(changes)
        if published is not None:
            body["is_published"] = published
        return _native(
            actor, original, zPageView, "PATCH", f"/api/zpage/{page_id}/", action="partial_update",
            body=body, headers={"If-Match": if_match}, kwargs={"pk": str(page_id)},
        )
    return perform(raw, account, original, operation, scopes, update)


def profile(raw, account, original, changes=None):
    from dj.apps.g12f.views.creator import CustomUserDetailsView
    write = changes is not None
    def public_profile(actor):
        result = _native(actor, original, CustomUserDetailsView, "PATCH" if write else "GET", "/api/auth/user/", body=changes)
        if result["status"] < 400:
            # Native account settings also returns email, balances and private
            # account metadata. MCP's content/profile scopes do not grant them,
            # including when PATCH produces that account representation.
            fields = {"id", "username", "full_name", "description", "avatar_image", "banner_image"}
            result["data"] = {key: value for key, value in result["data"].items() if key in fields}
        return result
    return perform(raw, account, original, "update_profile" if write else "get_profile", (WRITE if write else READ,), public_profile)


def list_uploads(raw, account, original, *, page=1, search=""):
    from dj.apps.uploads.views import MyUploadsViewSet
    return perform(raw, account, original, "list_uploads", (READ,), lambda actor: _native(
        actor, original, MyUploadsViewSet, "GET", "/api/myuploads/", action="list", query={"page": page, "search": search},
    ))


def get_upload(raw, account, original, upload_id):
    from dj.apps.uploads.views import MyUploadsViewSet
    return perform(raw, account, original, "get_upload", (READ,), lambda actor: _native(
        actor, original, MyUploadsViewSet, "GET", f"/api/myuploads/{upload_id}/", action="retrieve", kwargs={"pk": upload_id},
    ))
