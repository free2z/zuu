import pytest


@pytest.mark.parametrize("origin", ["https://free2z.cash", "http://localhost:1423"])
def test_preflight_allows_generation_model_receipt_header(client, origin):
    response = client.options(
        "/api/ai/conversations/",
        HTTP_ORIGIN=origin,
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
        HTTP_ACCESS_CONTROL_REQUEST_HEADERS=(
            "content-type,idempotency-key,x-ai-generation-model"
        ),
    )

    allowed = response.headers.get("access-control-allow-headers", "")
    assert "x-ai-generation-model" in allowed.lower(), (
        f"preflight from {origin} -> {response.status_code}, "
        f"allow-headers={allowed!r}"
    )
