import pytest

from dj.apps.storytime.models import Story


@pytest.mark.django_db
def test_deactivated_creator_story_detail_is_not_public(
    api_client, creator_factory,
):
    creator = creator_factory()
    story = Story.objects.create(
        creator=creator,
        title="taken down story",
        slug="taken-down-story",
        is_published=True,
    )

    assert api_client.get(
        f"/api/storytime/{creator.username}/{story.slug}"
    ).status_code == 200

    creator.is_active = False
    creator.save(update_fields=["is_active"])

    response = api_client.get(
        f"/api/storytime/{creator.username}/{story.slug}"
    )
    assert response.status_code == 404
    assert b"taken down story" not in response.content
