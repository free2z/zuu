"""Page creation errors do not write submitted content to diagnostics."""

import pytest
from django.db import IntegrityError
from rest_framework.test import APIClient

from dj.apps.g12f.models import zPage
from dj.apps.g12f.views.zpage import zPageUpdateSerializer


@pytest.mark.django_db
def test_create_integrity_error_keeps_draft_content_out_of_diagnostics(
    creator_factory, monkeypatch, capsys, caplog,
):
    creator = creator_factory()
    draft_content = "unpublished-draft-content-098532"
    database_detail = "private-database-value-754023"
    attempted = []

    def fail_save(serializer, **kwargs):
        attempted.append(serializer.validated_data["content"])
        raise IntegrityError(database_detail)

    monkeypatch.setattr(zPageUpdateSerializer, "save", fail_save)
    client = APIClient()
    client.force_authenticate(creator)
    response = client.post("/api/zpage/", {
        "title": "Private draft", "content": draft_content,
        "description": "", "tags": [], "is_published": False,
    }, format="json")

    assert attempted == [draft_content]
    assert response.status_code == 400
    assert response.data == {"vanity": "The vanity URL must be unique!"}
    assert not zPage.objects.filter(creator=creator).exists()
    captured = capsys.readouterr()
    diagnostics = captured.out + captured.err + caplog.text
    assert draft_content not in diagnostics
    assert database_detail not in diagnostics
