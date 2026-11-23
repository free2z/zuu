"""Real HTTP interoperability and request isolation for the WSGI bridge.

May run without the application database: ``python -m dj.apps.mcpserver.test_transport``.
The synthetic principal fixture is deliberately not the production authenticator.
"""
import asyncio
from contextlib import asynccontextmanager
import json
from socketserver import ThreadingMixIn
import threading
import unittest
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

from asgiref.sync import sync_to_async
from django.conf import settings
if not settings.configured:
    settings.configure(
        SECRET_KEY="mcp-transport-test-only", ROOT_URLCONF=__name__,
        ALLOWED_HOSTS=["127.0.0.1", "testserver"], MIDDLEWARE=[],
    )
from django.core.wsgi import get_wsgi_application
from django.http import HttpResponse
from django.test import RequestFactory, SimpleTestCase, override_settings
from django.urls import path
import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.server import MCPServer

from .transport import TransportPolicy, serve_mcp


_request_thread = threading.local()
_policy = TransportPolicy(
    allowed_hosts=("127.0.0.1:*", "testserver"),
    allowed_origins=("http://127.0.0.1:*",),
)


def _server(principal):
    server = MCPServer("transport-test", version="1", subscriptions=False, log_level="ERROR")

    @server.tool()
    async def echo(value: str) -> dict:
        def native_operation():
            # A backend operation must run in the authenticated Django request
            # thread, where transaction/middleware cleanup is registered.
            assert _request_thread.principal == principal
            return {"principal": principal, "value": value}
        return await sync_to_async(native_operation, thread_sensitive=True)()

    return server


def _endpoint(request):
    principal = request.headers.get("Authorization", "")
    if principal not in {"Bearer alice", "Bearer bob"}:
        return HttpResponse(status=401)
    _request_thread.principal = principal
    try:
        return serve_mcp(request, lambda: _server(principal), _policy)
    finally:
        del _request_thread.principal


urlpatterns = [path("api/mcp", _endpoint), path("api/mcp/", _endpoint)]


class _ThreadedServer(ThreadingMixIn, WSGIServer):
    daemon_threads = True


class _QuietHandler(WSGIRequestHandler):
    def log_message(self, *_args):
        pass


@override_settings(ROOT_URLCONF=__name__, ALLOWED_HOSTS=["127.0.0.1", "testserver"], MIDDLEWARE=[])
class TransportTests(SimpleTestCase):
    def test_official_clients_both_protocol_eras_and_concurrent_principals(self):
        httpd = make_server(
            "127.0.0.1", 0, get_wsgi_application(),
            server_class=_ThreadedServer, handler_class=_QuietHandler,
        )
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{httpd.server_port}/api/mcp"

        @asynccontextmanager
        async def transport(principal):
            async with httpx2.AsyncClient(headers={"Authorization": principal}) as http:
                async with streamable_http_client(url, http_client=http) as streams:
                    yield streams

        async def check(principal, mode):
            async with Client(transport(principal), mode=mode, cache=None) as client:
                self.assertEqual(client.protocol_version, "2026-07-28" if mode == "auto" else "2025-11-25")
                listed = await client.list_tools()
                self.assertEqual([tool.name for tool in listed.tools], ["echo"])
                # Multiple requests hit fresh SDK instances and event loops.
                for n in range(3):
                    value = f"{mode}-{n}"
                    result = await client.call_tool("echo", {"value": value})
                    self.assertFalse(result.is_error)
                    self.assertEqual(json.loads(result.content[0].text), {"principal": principal, "value": value})

        async def exercise():
            await asyncio.gather(*(
                check(principal, mode)
                for principal in ("Bearer alice", "Bearer bob")
                for mode in ("auto", "legacy")
            ))
        try:
            asyncio.run(exercise())
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()

    def test_input_limit_rejects_before_factory_or_tool(self):
        request = RequestFactory().post("/api/mcp", data=b"x" * 33, content_type="application/json")
        policy = TransportPolicy(("testserver",), (), max_request_bytes=32)
        def forbidden_factory():
            self.fail("Oversize request reached SDK factory")
        self.assertEqual(serve_mcp(request, forbidden_factory, policy).status_code, 413)

    def test_sdk_rejects_invalid_wire_and_host_without_tool_execution(self):
        factory = RequestFactory()
        for payload, extra, status in [
            (b"not-json", {}, 400),
            (b"{}", {"HTTP_HOST": "127.0.0.1"}, 421),
            (b"{}", {"HTTP_ORIGIN": "https://untrusted.example"}, 403),
        ]:
            request = factory.post("/api/mcp", data=payload, content_type="application/json", HTTP_ACCEPT="application/json, text/event-stream", **extra)
            policy = TransportPolicy(("testserver",), ())
            response = serve_mcp(request, lambda: _server("never-called"), policy)
            self.assertEqual(response.status_code, status)

    def test_response_limit_is_generic_and_does_not_replay(self):
        request = RequestFactory().post(
            "/api/mcp", data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"},
            }}), content_type="application/json", HTTP_ACCEPT="application/json, text/event-stream",
        )
        policy = TransportPolicy(("testserver",), (), max_response_bytes=1)
        count = 0
        def factory():
            nonlocal count
            count += 1
            return _server("never-called")
        response = serve_mcp(request, factory, policy)
        self.assertEqual(response.status_code, 500)
        self.assertEqual(count, 1)
        self.assertIn(b"Inspect the operation", response.content)
        self.assertNotIn(b"never-called", response.content)


if __name__ == "__main__":
    unittest.main()
