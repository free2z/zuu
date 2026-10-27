"""Contract guards for the paid-response remediation in issue."""

from pathlib import Path

import yaml


SPEC = yaml.safe_load((Path(__file__).parents[4] / "py/free2z/dj/free2z/openapi/f2z.yaml").read_text())


def _response_schema(path, method, status):
    response = SPEC["paths"][path][method]["responses"][str(status)]
    return response["content"]["application/json"]["schema"]


def test_stream_402_is_a_discriminated_union():
    schema = _response_schema("/api/dyte/{username}/{type}", "post", 402)
    assert schema == {"$ref": "#/components/schemas/StreamPaymentRequiredError"}

    union = SPEC["components"]["schemas"]["StreamPaymentRequiredError"]
    assert union["discriminator"] == {
        "propertyName": "code",
        "mapping": {
            "insufficient_funds": "#/components/schemas/InsufficientFundsError",
            "subscription_required": "#/components/schemas/StreamEntitlementError",
        },
    }
    assert {
        item["$ref"] for item in union["oneOf"]
    } == {
        "#/components/schemas/InsufficientFundsError",
        "#/components/schemas/StreamEntitlementError",
    }


def test_paid_comment_and_reply_posts_declare_insufficient_funds_402():
    for path in (
        "/api/comments/{type}/{uuid}/",
        "/api/comments/{uuid}/replies/",
    ):
        schema = _response_schema(path, "post", 402)
        assert schema == {"$ref": "#/components/schemas/InsufficientFundsError"}


def test_paid_comment_operations_publish_the_retry_header():
    for path, method in (
        ("/api/comments/", "post"),
        ("/api/comments/{type}/{uuid}/", "post"),
        ("/api/comments/{uuid}/replies/", "post"),
        ("/api/comments/{uuid}/vote/", "post"),
    ):
        parameters = SPEC["paths"][path][method]["parameters"]
        assert any(
            parameter["in"] == "header"
            and parameter["name"] == "Idempotency-Key"
            for parameter in parameters
        ), path
