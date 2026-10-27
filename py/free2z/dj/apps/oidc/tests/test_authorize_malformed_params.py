"""Malformed authentication requirements must fail closed at authorize."""
from __future__ import annotations

import pytest

from .conftest import query_of


pytestmark = pytest.mark.django_db


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("prompt", "login\x00"),
        ("max_age", "0\x00"),
        ("acr_values", "urn:f2z:acr:mfa\x00"),
        ("response_mode", "query\x00"),
        # Whitespace-only is malformed, not absent: stripped to "" it would
        # be dropped and max_age's freshness check silently skipped.
        ("max_age", "  "),
        ("response_mode", " "),
    ],
)
def test_nul_in_authentication_requirements_cannot_silently_approve(flow, name, value):
    flow.run()  # The malformed requirements must not disappear beside a grant.

    response = flow.evaluate(**{name: value})
    assert response.status_code == 200, response.content
    refused = response.json()
    assert refused["action"] == "redirect"
    assert query_of(refused["redirect_to"])["error"] == "invalid_request"
    assert "request_id" not in refused
