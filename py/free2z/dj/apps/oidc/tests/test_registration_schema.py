"""Native signup and OAuth client registration have distinct public contracts."""
from django.urls import path
from drf_spectacular.generators import SchemaGenerator

from dj.apps.g12f.views.creator import SignUpView
from dj.apps.oidc.mcp_views import MCPRegisterView


def test_signup_and_mcp_registration_components_do_not_collide():
    schema = SchemaGenerator(patterns=[
        path("api/oauth/register", MCPRegisterView.as_view()),
        path("api/start/", SignUpView.as_view({"post": "create"})),
    ]).get_schema(public=True)
    signup = schema["paths"]["/api/start/"]["post"]
    registration = schema["paths"]["/api/oauth/register"]["post"]

    def request_component(operation):
        reference = operation["requestBody"]["content"]["application/json"]["schema"]["$ref"]
        return reference, schema["components"]["schemas"][reference.rsplit("/", 1)[1]]

    signup_ref, signup_body = request_component(signup)
    registration_ref, registration_body = request_component(registration)
    assert signup_ref != registration_ref
    assert set(signup_body["required"]) == {"username", "password"}
    assert set(signup_body["properties"]) == {"username", "password"}
    assert set(registration_body["required"]) == {"redirect_uris"}
    assert "client_name" in registration_body["properties"]
    assert "password" not in registration_body["properties"]
    assert "username" not in registration_body["properties"]
    # Both are entry points for anonymous callers. Signup also accepts an
    # optional browser/token identity; DCR must not require one to bootstrap.
    assert {} in signup["security"]
    assert registration["security"] == [{}]
