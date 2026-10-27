"""Tests for new-UI pretty-URL namespace collisions, against real
Postgres.

Two safe backend guards, both affecting only NEW registrations / changed
vanities (never existing rows). During the UI transition both lists are the
UNION of the new SvelteKit UI's and the classic React UI's routes:

  * FORBIDDEN_USERNAMES keeps usernames from shadowing a real top-level route
    at ``/{username}`` (new UI ts/svelte/free2z/src/routes/ + classic
    ts/react/free2z/src/App.tsx).
  * RESERVED_VANITIES keeps a vanity from shadowing a real sub-route at
    ``/{username}/{vanity}`` (new UI [username]/{dashboard,private,zpage} +
    classic zpage/private and the /:username/:type live-stream types).

The password-registration rule is exercised through its serializer rather than
the HTTP signup flow (which adds reCAPTCHA/content-negotiation noise unrelated
to what we're testing). Other account-creation paths import the same policy.
"""
import uuid
from types import SimpleNamespace

import pytest

from dj.apps.g12f.models import zPage
from dj.apps.g12f.serializers.creator import (
    CreatorProfileUpdateSerializer,
    RegistrationSerializer,
)
from dj.apps.g12f.serializers.zpage import zPageUpdateSerializer

ROUTE_NAMESPACE_NAMES = [
    "trending",
    "oauth",
    "account",
    "developers",
    "zpage",
    "creator",
    "og",
    "sitemap",
    "docs",
    "gcsproxy",
    "uploadsauth",
    "uploadsauth-uploadlimit",
    "uploadsauth-private",
    "uploadsauth-public",
    "uploadsauth-public-hls",
    "feeds",
    "uploads",
    "uploadz",
    "static",
    "djstatic",
    "_app",
    "ws",
    "healthz",
    "csp-report",
    "robots.txt",
    "sitemap.xml",
    "sitemap-v2.xml",
]


# --------------------------------------------------------------------------
# Fix 1 — reserved usernames (top-level routes)
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_reserved_username_is_rejected():
    serializer = RegistrationSerializer(
        data={"username": "search", "password": "Str0ng-Passw0rd!23"}
    )
    assert not serializer.is_valid()
    assert "username" in serializer.errors


@pytest.mark.django_db
def test_normal_username_is_accepted():
    serializer = RegistrationSerializer(
        data={"username": "a-normal-creator", "password": "Str0ng-Passw0rd!23"}
    )
    assert serializer.is_valid(), serializer.errors


# Classic React top-level routes newly folded into the union (App.tsx). These
# were NOT reserved before this change and must be now, or a username could
# shadow the classic page while both UIs are live.
@pytest.mark.django_db
@pytest.mark.parametrize("name", ["storytime", "tools", "events", "micvizz"])
def test_classic_route_username_is_rejected(name):
    serializer = RegistrationSerializer(
        data={"username": name, "password": "Str0ng-Passw0rd!23"}
    )
    assert not serializer.is_valid()
    assert "username" in serializer.errors


# These names are not top-level page routes and remain registerable. In
# particular, ``zpages``/``podcasts`` are only nested under ``/feeds/``.
@pytest.mark.django_db
@pytest.mark.parametrize("name", ["zpages", "podcasts"])
def test_unreserved_username_is_now_accepted(name):
    serializer = RegistrationSerializer(
        data={"username": name, "password": "Str0ng-Passw0rd!23"}
    )
    assert serializer.is_valid(), serializer.errors


@pytest.mark.django_db
@pytest.mark.parametrize("name", ROUTE_NAMESPACE_NAMES)
def test_route_namespace_username_is_rejected(name):
    serializer = RegistrationSerializer(
        data={"username": name, "password": "Str0ng-Passw0rd!23"}
    )
    assert not serializer.is_valid()
    assert "username" in serializer.errors


@pytest.mark.django_db
def test_existing_reserved_username_keeps_classic_login_fallback(
    creator_factory,
):
    creator_factory(username="trending")
    serializer = RegistrationSerializer(
        data={"username": "TrEnDiNg", "password": "Str0ng-Passw0rd!23"}
    )

    assert not serializer.is_valid()
    assert str(serializer.errors["username"][0]).startswith(
        "A user with that username already exists"
    )


@pytest.mark.django_db
@pytest.mark.parametrize("name", ROUTE_NAMESPACE_NAMES)
def test_route_namespace_rename_is_rejected(name, creator_factory):
    creator = creator_factory(username="ordinary-creator")
    serializer = CreatorProfileUpdateSerializer(
        instance=creator,
        data={"username": name},
        partial=True,
    )
    assert not serializer.is_valid()
    assert "username" in serializer.errors


@pytest.mark.django_db
@pytest.mark.parametrize("name", ROUTE_NAMESPACE_NAMES)
def test_grandfathered_route_namespace_can_be_retained(name, creator_factory):
    creator = creator_factory(username=name)
    serializer = CreatorProfileUpdateSerializer(
        instance=creator,
        data={"username": name.upper()},
        partial=True,
        context={"request": SimpleNamespace(user=creator)},
    )
    assert serializer.is_valid(), serializer.errors
    updated = serializer.save()
    assert updated.username == name.upper()
    creator.refresh_from_db()
    assert creator.username == name.upper()


# --------------------------------------------------------------------------
# Fix 2 — reserved vanities ([username] sub-routes)
# --------------------------------------------------------------------------


def _page(creator, vanity):
    return zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=vanity,
        title="A page",
        content="Some content.",
    )


@pytest.mark.django_db
def test_reserved_vanity_is_rejected(creator_factory):
    page = _page(creator_factory(), "my-current-vanity")

    serializer = zPageUpdateSerializer(
        instance=page, data={"vanity": "dashboard"}, partial=True
    )

    assert not serializer.is_valid()
    assert "vanity" in serializer.errors


@pytest.mark.django_db
def test_normal_vanity_is_accepted(creator_factory):
    page = _page(creator_factory(), "my-current-vanity")

    serializer = zPageUpdateSerializer(
        instance=page, data={"vanity": "my-cool-page"}, partial=True
    )

    assert serializer.is_valid(), serializer.errors
    assert serializer.validated_data["vanity"] == "my-cool-page"


#  `null` and `undefined` are not routes, they are what JavaScript
# writes when a missing value is interpolated into a URL. SvelteKit's
# `[username]/[vanity]` refuses them without asking the API, so the write path
# has to refuse them too or the two tiers disagree: the editor slugifies the
# TITLE into a vanity, so an article called "Null" would otherwise be created
# with the one URL the reader tier will never serve. `Undefined` covers the
# case-folding, because slugify lowercases and `isNullishSlug` compares
# lowercased.
@pytest.mark.django_db
@pytest.mark.parametrize("vanity", ["null", "undefined", "Null", "Undefined"])
def test_stringified_nothing_is_not_a_usable_vanity(creator_factory, vanity):
    page = _page(creator_factory(), "my-current-vanity")

    serializer = zPageUpdateSerializer(
        instance=page, data={"vanity": vanity}, partial=True
    )

    assert not serializer.is_valid()
    assert "vanity" in serializer.errors


# Words that merely contain or resemble the sentinel stay usable: shadowing a
# real article would be a worse bug than the 404  fixes.
@pytest.mark.django_db
@pytest.mark.parametrize("vanity", ["nullify", "null-and-void", "none", "nan"])
def test_words_resembling_the_sentinel_stay_usable(creator_factory, vanity):
    page = _page(creator_factory(), "my-current-vanity")

    serializer = zPageUpdateSerializer(
        instance=page, data={"vanity": vanity}, partial=True
    )

    assert serializer.is_valid(), serializer.errors
    assert serializer.validated_data["vanity"] == vanity


# Classic React /:username/:type live-stream sub-routes newly folded into the
# union. A vanity matching one of these would shadow the classic stream page.
@pytest.mark.django_db
@pytest.mark.parametrize("vanity", ["broadcast", "ppv", "subscribers-only"])
def test_classic_subroute_vanity_is_rejected(creator_factory, vanity):
    page = _page(creator_factory(), "my-current-vanity")

    serializer = zPageUpdateSerializer(
        instance=page, data={"vanity": vanity}, partial=True
    )

    assert not serializer.is_valid()
    assert "vanity" in serializer.errors


# Over-reservations removed from RESERVED_VANITIES: these live at
# /{username}/dashboard/* (two segments deep) in the new UI, so a one-segment
# vanity can never shadow them. They must now be usable as vanities.
@pytest.mark.django_db
@pytest.mark.parametrize(
    "vanity",
    ["settings", "billing", "media", "notifications", "pages", "stream", "profile"],
)
def test_unreserved_vanity_is_now_accepted(creator_factory, vanity):
    page = _page(creator_factory(), "my-current-vanity")

    serializer = zPageUpdateSerializer(
        instance=page, data={"vanity": vanity}, partial=True
    )

    assert serializer.is_valid(), serializer.errors
    assert serializer.validated_data["vanity"] == vanity
