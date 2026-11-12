"""Wire-method and schema controls independent of database or tool execution."""
from uuid import uuid4
from pathlib import Path

import pytest
import yaml
from django.test import RequestFactory

from .uploads import authorize_upload, upload_binary


@pytest.mark.parametrize('method', ['get', 'head', 'post', 'delete'])
def test_binary_upload_rejects_non_put_before_authorization_or_database(method):
    # pytest-django forbids database access here. A mistaken GET reaching any
    # intent lookup/write fails before it could return a misleading refusal.
    response = upload_binary(getattr(RequestFactory(), method)('/api/mcp/uploads/' + str(uuid4())), uuid4())
    assert response.status_code == 405
    assert response['Allow'] == 'PUT'


def test_edge_admission_is_declared_read_only():
    response = authorize_upload(RequestFactory().post('/api/mcp/uploads/authorize'))
    assert response.status_code == 405
    assert response['Allow'] == 'GET'


def test_http_contract_declares_protocol_auth_and_framing_failures():
    contract = yaml.safe_load((Path(__file__).resolve().parents[2] / 'free2z/openapi/f2z.yaml').read_text())
    paths = contract['paths']
    for path in ('/api/mcp', '/api/mcp/'):
        operation = paths[path]['post']
        assert operation['requestBody']['content']['application/json']['schema']['type'] == 'object'
        assert {'400', '401', '403', '405', '406', '413', '415', '421', '429', '500'} <= operation['responses'].keys()
        assert 'WWW-Authenticate' in operation['responses']['401']['headers']
        assert 'Retry-After' in operation['responses']['429']['headers']
        assert operation['security'] == [{'mcpBearer': []}]
        assert not {'Accept', 'Authorization', 'Content-Type'} & {p['name'] for p in operation['parameters']}
    assert contract['components']['securitySchemes']['mcpBearer']['scheme'] == 'bearer'
    binary = paths['/api/mcp/uploads/{upload_id}']['put']
    assert binary['requestBody']['content']['*/*']['schema']['format'] == 'binary'
    assert {'200', '201', '400', '403', '405', '413'} <= binary['responses'].keys()
    assert binary['security'] == [{'mcpUploadCapability': []}]
    admission = paths['/api/mcp/uploads/authorize']['get']
    assert {'204', '401', '403', '405'} == admission['responses'].keys()
    assert admission['security'] == [{'mcpUploadCapability': []}]


def test_schema_subsets_do_not_invent_mcp_endpoints_or_replace_runtime_callbacks():
    from django.http import HttpResponse
    from django.urls import path
    from .schema import MCPSchemaGenerator
    from .views import mcp_endpoint
    wrong = MCPSchemaGenerator(patterns=[path('api/mcp', lambda request: HttpResponse())])
    assert not wrong.get_schema(public=True)['paths']
    subset = MCPSchemaGenerator(patterns=[path('api/mcp', mcp_endpoint)])
    schema = subset.get_schema(public=True)
    assert set(schema['paths']) == {'/api/mcp'}
    assert schema['paths']['/api/mcp']['post']['security'] == [{'mcpBearer': []}]
    assert subset.patterns[0].callback is mcp_endpoint


def test_download_boundaries_have_private_header_security_and_binary_types():
    contract = yaml.safe_load((Path(__file__).resolve().parents[2] / 'free2z/openapi/f2z.yaml').read_text())
    for path, media in [('/api/mcp/downloads/{upload_id}', 'application/octet-stream'), ('/api/mcp/exports/{export_id}', 'application/zip')]:
        operation = contract['paths'][path]['get']
        assert operation['security'] == [{'mcpDownloadCapability': []}]
        assert operation['responses']['200']['content'][media]['schema']['format'] == 'binary'
    assert contract['components']['securitySchemes']['mcpDownloadCapability']['name'] == 'X-Free2Z-Download-Capability'


def test_manifest_matches_reviewed_registry():
    import json
    from .catalog import operations, summary
    root = Path(__file__).resolve().parents[5]
    manifest = json.loads((root / 'docs/free2z/mcp/capabilities.json').read_text())
    assert manifest['operations'] == [summary(op) for op in sorted(operations())]
    assert manifest['supported_count'] == sum(row['supported'] for row in manifest['operations'])


def test_apple_unlink_remains_outside_delegated_mcp_authority():
    from .catalog import summary
    from .registry import REGISTRY

    operation = 'auth_social_apple_unlink'
    assert operation not in REGISTRY
    row = summary(operation)
    assert row['supported'] is False
    assert row['reason'] == (
        'Identity, credential or account security operation requires its native authentication context.'
    )
