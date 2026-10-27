"""Tests for the emails API auth boundary, against real Postgres.

``AddEmailView`` was the one view in the app with neither ``permission_classes``
nor an ``is_authenticated`` guard: anonymous ``POST /api/emails/add`` hit
``Email.objects.get_or_create(user=AnonymousUser)`` → ``ValueError`` → 500.
"""
import pytest


@pytest.mark.django_db
def test_add_email_rejects_anonymous(api_client):
    response = api_client.post(
        "/api/emails/add", {"email": "attacker@example.com"}, format="json"
    )
    assert response.status_code in (401, 403), response.content
