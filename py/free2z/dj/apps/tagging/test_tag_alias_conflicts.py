"""The tag-alias conflict audit covers both stored and source keys."""

from io import StringIO

import pytest
from django.core.management import CommandError, call_command
from taggit.models import Tag

from dj.apps.tagging.models import TagAlias


@pytest.mark.django_db
def test_audit_reports_stale_projection_and_can_fail(creator_factory):
    first = Tag.objects.create(name="first")
    second = Tag.objects.create(name="second")
    TagAlias.objects.bulk_create([
        TagAlias(
            name="Conflict Name",
            name_key="stored-conflict",
            canonical=first,
        ),
        TagAlias(name="Other", name_key="stored-conflict", canonical=second),
        TagAlias(
            name="Source Conflict", name_key="stale-a", canonical=first
        ),
        TagAlias(
            name="SOURCE CONFLICT", name_key="stale-b", canonical=second
        ),
    ])

    output = StringIO()
    with pytest.raises(CommandError):
        call_command(
            "audit_tag_alias_conflicts",
            "--fail-on-conflict",
            stdout=output,
        )

    text = output.getvalue()
    assert "Scanned 4 tag aliases; found 2 conflicting keys." in text
    assert "name_key='stored-conflict'" in text
    assert "tag_key='source conflict'" in text
