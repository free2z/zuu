"""Schema-only HTTP boundaries for raw Django MCP handlers.

These views are never mounted. The endpoint enumerator lets drf-spectacular
document protocol headers without inserting DRF into binary/JSON-RPC dispatch.
The MCP SDK, not OpenAPI, defines JSON-RPC messages and individual tool schemas.
"""
from django.urls.resolvers import URLResolver
from drf_spectacular.extensions import OpenApiAuthenticationExtension
from drf_spectacular.generators import EndpointEnumerator, SchemaGenerator
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema, extend_schema_view
from rest_framework.authentication import BaseAuthentication
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView


def header(name, description, *, required=False):
    return OpenApiParameter(name, OpenApiTypes.STR, OpenApiParameter.HEADER,
                            required=required, description=description)


class MCPBearerAuthentication(BaseAuthentication):
    def authenticate(self, request):
        raise RuntimeError("Schema-only authentication must not be mounted.")


class MCPBearerScheme(OpenApiAuthenticationExtension):
    target_class = MCPBearerAuthentication
    name = "mcpBearer"

    def get_security_definition(self, auto_schema):
        return {"type": "http", "scheme": "bearer", "bearerFormat": "JWT",
                "description": "OAuth access token bound to this MCP resource. Missing, expired, "
                "wrong-audience or revoked tokens return 401 with a WWW-Authenticate resource_metadata challenge. "
                "Browser cookies do not authenticate MCP."}


class MCPUploadAuthentication(BaseAuthentication):
    def authenticate(self, request):
        raise RuntimeError("Schema-only authentication must not be mounted.")


class MCPUploadScheme(OpenApiAuthenticationExtension):
    target_class = MCPUploadAuthentication
    name = "mcpUploadCapability"

    def get_security_definition(self, auto_schema):
        return {"type": "apiKey", "in": "header", "name": "X-Free2Z-Upload-Capability",
                "description": "Short-lived prepared-upload capability, restricted to its account and "
                "exact file. Missing, expired or revoked authority returns 403; it cannot change media metadata."}


class MCPHTTPBoundary(APIView):
    authentication_classes = [MCPBearerAuthentication]
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="mcp_post", tags=["mcp"],
        description="Stateless JSON Streamable HTTP MCP. The official MCP SDK owns "
        "protocol negotiation, JSON-RPC messages and tool schemas; discover tools "
        "through MCP rather than treating this endpoint as a REST operation catalog. "
        "Cookies do not authenticate this endpoint. Model inputs are explicit tool "
        "arguments in the JSON body, including the selected authorized account. "
        "The trailing-slash alias has the same behavior. A failed or lost response "
        "does not prove rollback: reconcile mutation state before retrying. "
        "Send Content-Type application/json and Accept application/json, text/event-stream; "
        "the SDK refuses unacceptable representations with 406 and unsupported content types with 415.",
        parameters=[
            header("Origin", "Browser origin admission only. Unregistered origins return 403; "
                   "the header supplies no persisted account or content fields."),
            header("Host", "Canonical deployment host. Django rejects disallowed hosts with "
                   "400; the MCP transport rejects a noncanonical host with 421.", required=True),
            header("Content-Length", "Optional HTTP framing length. Malformed values return "
                   "400; bodies exceeding 4 MiB return 413 even when this header is absent."),
            header("MCP-Protocol-Version", "Negotiated MCP protocol version on subsequent requests. "
                   "Unsupported protocol metadata is refused by the SDK with 400."),
            header("Mcp-Method", "Optional MCP routing hint validated by the SDK against the "
                   "JSON-RPC body. It does not supply tool arguments."),
            header("Mcp-Name", "Optional MCP tool/resource routing hint validated by the SDK; "
                   "the selected account and mutable fields come from the body."),
            OpenApiParameter("WWW-Authenticate", OpenApiTypes.STR, OpenApiParameter.HEADER,
                             response=[401], description="Bearer challenge with resource_metadata URL."),
            OpenApiParameter("Retry-After", OpenApiTypes.STR, OpenApiParameter.HEADER,
                             response=[429], description="Minimum seconds before another request."),
        ],
        request={"application/json": OpenApiTypes.OBJECT},
        responses={
            200: OpenApiResponse(OpenApiTypes.OBJECT, "SDK JSON-RPC result or error; at most 8 MiB."),
            202: OpenApiResponse(description="Accepted SDK notification; no response body."),
            400: OpenApiResponse(description="Malformed framing, host, protocol or JSON-RPC request."),
            401: OpenApiResponse(description="Bearer authorization required; metadata challenge returned."),
            403: OpenApiResponse(description="Browser origin is not admitted."),
            405: OpenApiResponse(description="Only POST is supported; no persistent SSE session."),
            406: OpenApiResponse(description="Accept header does not support the MCP HTTP representations."),
            413: OpenApiResponse(description="JSON request exceeds the bounded input limit."),
            415: OpenApiResponse(description="Request content type must be application/json."),
            421: OpenApiResponse(description="Host does not match this MCP deployment."),
            429: OpenApiResponse(description="Connection-owner request limit exceeded; Retry-After returned."),
            500: OpenApiResponse(description="Bounded response unavailable; reconcile state before retrying."),
        },
    )
    def post(self, request):
        raise RuntimeError("Schema-only view must not be mounted.")


class MCPUploadBoundary(APIView):
    authentication_classes = [MCPUploadAuthentication]
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="mcp_upload_put", tags=["mcp"],
        description="Stream the exact prepared file bytes. Filename, media access, title, "
        "description and account were fixed by free2z_prepare_upload tool arguments. "
        "Headers authenticate the prepared intent and validate framing; they cannot "
        "replace its metadata. Authorization is checked before and after transfer. "
        "Replaying identical bytes returns the existing receipt; changed bytes fail.",
        parameters=[
            OpenApiParameter("upload_id", OpenApiTypes.UUID, OpenApiParameter.PATH, required=True),
            header("Content-Length", "Required exact prepared byte length within the account's "
                   "ordinary upload limit. Missing, malformed or mismatched values return 400.", required=True),
        ],
        request={"*/*": OpenApiTypes.BINARY},
        responses={
            200: OpenApiResponse(OpenApiTypes.OBJECT, "Existing upload receipt and media ID for identical bytes."),
            201: OpenApiResponse(OpenApiTypes.OBJECT, "Created upload receipt and media ID."),
            400: OpenApiResponse(description="Length, Content-Type or SHA-256 differs from the prepared file, "
                                 "or native file validation refuses the content. Send the prepared MIME type."),
            403: OpenApiResponse(description="Capability, token, account grant or publication permission refused."),
            405: OpenApiResponse(description="Only PUT is supported."),
            413: OpenApiResponse(description="Edge body limit exceeded."),
        },
    )
    def put(self, request, upload_id):
        raise RuntimeError("Schema-only view must not be mounted.")


class MCPUploadAdmissionBoundary(APIView):
    authentication_classes = [MCPUploadAuthentication]
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="mcp_upload_authorize", tags=["mcp"],
        description="Internal read-only edge auth_request admission before binary-body buffering. "
        "Consumes no bytes and creates no upload. The PUT endpoint independently "
        "rechecks authorization, size and digest even without this preflight.",
        parameters=[
            header("X-Original-URI", "Edge-supplied exact /api/mcp/uploads/<UUID> resource path. "
                   "Malformed or unrelated paths return 403; never supplies media metadata.", required=True),
            header("X-Original-Content-Length", "Edge-supplied declared binary-body length. "
                   "Missing, malformed or mismatched lengths return 403 before buffering.", required=True),
        ],
        responses={
            204: OpenApiResponse(description="Prepared upload is currently authorized."),
            401: OpenApiResponse(description="Authorization challenge from the underlying verifier."),
            403: OpenApiResponse(description="Invalid path, size, capability or revoked/expired authorization."),
            405: OpenApiResponse(description="Only GET is supported."),
        },
    )
    def get(self, request):
        raise RuntimeError("Schema-only view must not be mounted.")


@extend_schema_view(post=extend_schema(operation_id="mcp_post_alias"))
class MCPHTTPAliasBoundary(MCPHTTPBoundary):
    pass


class MCPBoundaryEnumerator(EndpointEnumerator):
    def get_api_endpoints(self, patterns=None, prefix=''):
        """Describe only exact raw callbacks present in this generator's URL subset."""
        from . import uploads, views
        endpoints = super().get_api_endpoints(patterns, prefix)
        expected = {
            'api/mcp': (views.mcp_endpoint, '/api/mcp', 'POST', MCPHTTPBoundary),
            'api/mcp/': (views.mcp_endpoint, '/api/mcp/', 'POST', MCPHTTPAliasBoundary),
            'api/mcp/uploads/<uuid:upload_id>': (uploads.upload_binary, '/api/mcp/uploads/{upload_id}', 'PUT', MCPUploadBoundary),
            'api/mcp/uploads/authorize': (uploads.authorize_upload, '/api/mcp/uploads/authorize', 'GET', MCPUploadAdmissionBoundary),
        }

        def walk(entries, parent):
            for entry in entries:
                route = parent + str(entry.pattern)
                if isinstance(entry, URLResolver):
                    yield from walk(entry.url_patterns, route)
                elif route in expected:
                    callback, path, method, descriptor = expected[route]
                    if entry.callback is callback:
                        yield path, route, method, descriptor.as_view()

        seen = {(path, method) for path, _, method, _ in endpoints}
        return [*endpoints, *(endpoint for endpoint in walk(self.patterns if patterns is None else patterns, prefix)
                             if (endpoint[0], endpoint[2]) not in seen)]


class MCPSchemaGenerator(SchemaGenerator):
    endpoint_inspector_cls = MCPBoundaryEnumerator
