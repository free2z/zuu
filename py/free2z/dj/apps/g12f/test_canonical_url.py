"""Canonical URL validation and zPage API serialization."""

import uuid

import pytest
from django.core.exceptions import ValidationError
from django.template.loader import render_to_string
from django.test import RequestFactory

from dj.apps.g12f.models import zPage
from dj.apps.g12f.views import crawler
from dj.apps.g12f.zpage_paths import canonical_zpage_path
from dj.apps.g12f.serializers.zpage import (
    zPageDetailSerializer,
    zPageListSerializer,
    zPageUpdateSerializer,
)


def _page(creator, canonical_url=""):
    return zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=f"article-{uuid.uuid4()}",
        title="Republished article",
        content="Article body",
        canonical_url=canonical_url,
    )


@pytest.mark.parametrize(
    ("username", "vanity", "free2zaddr", "expected"),
    [
        ("owner", "article", "address", "/owner/article"),
        ("owner", "broadcast", "address", "/owner/address"),
        ("owner", "broadcast", "ppv", "/article/ppv"),
        ("api", "launch", "address", "/article/address"),
        ("profile", "kyc", "address", "/article/address"),
        ("profile", "ordinary", "address", "/profile/ordinary"),
        ("sitemap", "static.xml", "address", "/article/address"),
        ("creator", "alice", "address", "/creator/alice"),
    ],
)
def test_python_public_path_matches_the_svelte_collision_contract(
    username, vanity, free2zaddr, expected,
):
    assert canonical_zpage_path(username, vanity, free2zaddr) == expected


@pytest.mark.django_db
@pytest.mark.parametrize(
    "canonical_url",
    [
        "https://example.com/original-article",
        "http://news.example.test/posts/42?source=archive",
    ],
)
def test_update_serializer_accepts_absolute_http_urls(creator_factory, canonical_url):
    page = _page(creator_factory())
    serializer = zPageUpdateSerializer(
        instance=page,
        data={"canonical_url": canonical_url},
        partial=True,
    )

    assert serializer.is_valid(), serializer.errors
    updated = serializer.save()
    assert updated.canonical_url == canonical_url


@pytest.mark.django_db
@pytest.mark.parametrize(
    "canonical_url",
    [
        "example.com/original",
        "/original",
        "ftp://example.com/original",
        "https://user:secret@example.com/original",
        "https://example.com/original#comments",
        "https://example..com/article",
        "https://-example.com/article",
        "https:example.com/article",
        "https://example.com/a b",
    ],
)
def test_update_serializer_rejects_unsafe_or_non_absolute_urls(
    creator_factory, canonical_url
):
    page = _page(creator_factory())
    serializer = zPageUpdateSerializer(
        instance=page,
        data={"canonical_url": canonical_url},
        partial=True,
    )

    assert not serializer.is_valid()
    assert "canonical_url" in serializer.errors


@pytest.mark.django_db
def test_canonical_url_can_be_cleared(creator_factory):
    page = _page(creator_factory(), "https://example.com/original")
    serializer = zPageUpdateSerializer(
        instance=page,
        data={"canonical_url": ""},
        partial=True,
    )

    assert serializer.is_valid(), serializer.errors
    updated = serializer.save()
    assert updated.canonical_url == ""


@pytest.mark.django_db
def test_owner_can_set_and_clear_canonical_url_through_api(
    api_client, creator_factory
):
    creator = creator_factory()
    page = _page(creator)
    api_client.force_authenticate(user=creator)
    url = f"/api/zpage/{page.free2zaddr}/"

    response = api_client.patch(
        url,
        {"canonical_url": "https://example.com/original"},
        format="json",
    )
    assert response.status_code == 200, response.data
    assert response.data["canonical_url"] == "https://example.com/original"

    response = api_client.patch(url, {"canonical_url": ""}, format="json")
    assert response.status_code == 200, response.data
    assert response.data["canonical_url"] == ""
    page.refresh_from_db()
    assert page.canonical_url == ""


@pytest.mark.django_db
def test_model_validation_applies_outside_the_api(creator_factory):
    page = _page(creator_factory())
    page.canonical_url = "https://user@example.com/original"

    with pytest.raises(ValidationError) as exc_info:
        page.full_clean()

    assert "canonical_url" in exc_info.value.message_dict


@pytest.mark.django_db
def test_canonical_url_is_in_detail_and_write_but_not_list_payloads(creator_factory):
    canonical_url = "https://example.com/original"
    page = _page(creator_factory(), canonical_url)

    assert zPageDetailSerializer(page).data["canonical_url"] == canonical_url
    assert zPageUpdateSerializer(page).data["canonical_url"] == canonical_url
    assert "canonical_url" not in zPageListSerializer(page).data


@pytest.mark.django_db
def test_legacy_social_metadata_uses_external_canonical_consistently(creator_factory):
    canonical_url = "https://example.com/original"
    page = _page(creator_factory(), canonical_url)
    request = RequestFactory().get("/social", HTTP_HOST="free2z.test")

    # The real view context, not a hand-built one: Part 8 the
    # canonical is computed in Python (language arithmetic does not belong in a
    # template), so a fabricated context would test nothing.
    html = render_to_string(
        "zpage/social.html", crawler._zpage_card_context(request, page),
    )

    assert f'<link rel="canonical" href="{canonical_url}">' in html
    assert f'<meta property="og:url" content="{canonical_url}">' in html
    assert f'<meta name="twitter:url" content="{canonical_url}">' in html


@pytest.mark.django_db
def test_legacy_social_metadata_falls_back_to_free2z_url(creator_factory):
    """With no external canonical, the card advertises the CANONICAL URL.

    That is `get_public_url()` (`/{username}/{vanity}`) -- what the sitemap
    publishes -- not the legacy `get_url()` (`/{username}/zpage/{vanity}`),
    which stays as-is because it is a serialized API field.
    """
    page = _page(creator_factory())
    request = RequestFactory().get("/social", HTTP_HOST="free2z.test")
    expected_url = f"https://free2z.test{page.get_public_url()}"

    # The real view context, not a hand-built one: Part 8 the
    # canonical is computed in Python (language arithmetic does not belong in a
    # template), so a fabricated context would test nothing.
    html = render_to_string(
        "zpage/social.html", crawler._zpage_card_context(request, page),
    )

    assert f'<link rel="canonical" href="{expected_url}">' in html
    assert f'<meta property="og:url" content="{expected_url}">' in html
    assert f'<meta name="twitter:url" content="{expected_url}">' in html
    assert f"https://free2z.test{page.get_url()}" not in html
