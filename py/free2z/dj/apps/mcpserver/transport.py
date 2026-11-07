"""Run the official MCP transport inside an ordinary Django request.

The SDK owns protocol parsing, version negotiation, and wire errors. Each HTTP
request gets a fresh server and lifespan: there is no process-local session or
active account, and any WSGI/ASGI replica can answer the next request. Operations
must use ``sync_to_async(thread_sensitive=True)`` so Django work returns to the
request's thread and retains its transaction context.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import logging

import anyio
from asgiref.sync import async_to_sync
from django.http import HttpRequest, HttpResponse, JsonResponse
from mcp.server import MCPServer
from mcp.server.transport_security import TransportSecuritySettings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TransportPolicy:
    allowed_hosts: tuple[str, ...]
    allowed_origins: tuple[str, ...]
    max_request_bytes: int = 4 * 1024 * 1024
    max_response_bytes: int = 8 * 1024 * 1024
    timeout_seconds: float = 120


class TransportLimit(Exception):
    pass


async def _exchange(request, body, server_factory, policy):
    server = server_factory()
    app = server.streamable_http_app(
        streamable_http_path=request.path,
        stateless_http=True,
        json_response=True,
        max_request_body_size=policy.max_request_bytes,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=list(policy.allowed_hosts),
            allowed_origins=list(policy.allowed_origins),
        ),
    )
    # Authentication belongs to Django, before this adapter. Neither cookies
    # nor bearer tokens become part of the SDK's handler/request context.
    headers = [
        (key.lower().encode("ascii"), value.encode("latin1"))
        for key, value in request.headers.items()
        if key.lower() not in {"authorization", "cookie"}
    ]
    if not any(key == b"host" for key, _value in headers):
        headers.append((b"host", request.get_host().encode("ascii")))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1",
        "method": request.method,
        "scheme": request.scheme,
        "path": request.path,
        "raw_path": request.path.encode("utf-8"),
        "query_string": request.META.get("QUERY_STRING", "").encode("ascii"),
        "root_path": "",
        "headers": headers,
        "server": (request.META.get("SERVER_NAME", ""), int(request.get_port())),
        "client": (request.META.get("REMOTE_ADDR", ""), 0),
    }
    supplied_body = False
    finished = anyio.Event()
    chunks = []
    size = 0
    status = None
    response_headers = []

    async def receive():
        nonlocal supplied_body
        if not supplied_body:
            supplied_body = True
            return {"type": "http.request", "body": body, "more_body": False}
        await finished.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        nonlocal status, response_headers, size
        if message["type"] == "http.response.start":
            if status is not None:
                raise TransportLimit("Repeated response start")
            status = message["status"]
            response_headers = message["headers"]
        elif message["type"] == "http.response.body":
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > policy.max_response_bytes:
                raise TransportLimit("Response exceeds limit")
            chunks.append(chunk)
            if not message.get("more_body", False):
                finished.set()
        else:
            raise TransportLimit("Unsupported ASGI message")

    with anyio.fail_after(policy.timeout_seconds):
        # A mounted Starlette app does not receive lifespan automatically.
        # This per-request lifespan is intentional for stateless WSGI hosting.
        async with app.router.lifespan_context(app):
            await app(scope, receive, send)
    if status is None or not finished.is_set():
        raise TransportLimit("Incomplete response")
    response = HttpResponse(b"".join(chunks), status=status)
    for key, value in response_headers:
        name = key.decode("latin1")
        if name.lower() not in {"connection", "transfer-encoding", "set-cookie"}:
            response[name] = value.decode("latin1")
    response["Cache-Control"] = "no-store"
    return response


def serve_mcp(
    request: HttpRequest,
    server_factory: Callable[[], MCPServer],
    policy: TransportPolicy,
) -> HttpResponse:
    """Serve one already-authenticated request, with bounded input/output.

    ``server_factory`` must capture only the caller's verified connection. It
    must disable subscriptions and must not register client callbacks/streaming
    tools: this endpoint supports tools and resources over stateless JSON.
    """
    request.get_host()  # Keep Django's ALLOWED_HOSTS check at the outer boundary.
    content_length = request.META.get("CONTENT_LENGTH", "")
    if content_length:
        if not str(content_length).isdigit():
            return JsonResponse({"error": "Invalid content length."}, status=400)
        if int(content_length) > policy.max_request_bytes:
            return JsonResponse({"error": "MCP request exceeds the size limit."}, status=413)
    body = request.read(policy.max_request_bytes + 1)
    if len(body) > policy.max_request_bytes:
        return JsonResponse({"error": "MCP request exceeds the size limit."}, status=413)
    try:
        return async_to_sync(_exchange)(request, body, server_factory, policy)
    except Exception:
        # SDK exceptions can contain caller data. The public error deliberately
        # avoids exception text, credentials, and internal implementation paths.
        logger.error("MCP transport failed to produce a bounded response")
        response = JsonResponse(
            {"error": "MCP response unavailable. Inspect the operation's state before retrying a write."},
            status=500,
        )
        response["Cache-Control"] = "no-store"
        return response
