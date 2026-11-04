"""What the zPage write path does with a vanity.

Prod, 2026-09-14/19/24: creators writing in Arabic and Korean had
EVERY autosave refused with the 93-byte body

    {"vanity":["Enter a valid \\"slug\\" consisting of letters, numbers,
    underscores or hyphens."]}

The editor derived the vanity from the title keeping non-Latin letters, and
the serializer's auto-generated ``SlugField`` rejected the value with DRF's
generic regex message before ``validate_vanity`` -- which exists to normalize
it -- ever ran. The same regex also refused ``zebra6.4.1``, which the creator
then had to hand-type as ``zebra641``: exactly what ``slugify`` would have
produced.

The contract pinned here: vanities stay ASCII (owner decision; ). What
normalizes losslessly is normalized; a letter or digit that ``slugify`` would
silently DELETE is refused with a message that says why, because the body
field is what the user typed and must not be rewritten into a URL they never
chose.
"""
import uuid

import pytest
from rest_framework.test import APIClient

from dj.apps.g12f.models import zPage
from dj.apps.g12f.serializers.zpage import VANITY_ASCII_ONLY_MESSAGE
from dj.apps.g12f.views.zpage import _fallback_zpage_vanity

# DRF's SlugField message -- the prod 400 body. Asserted ABSENT: its presence
# means the field-level regex is back in front of `validate_vanity`.
DRF_SLUG_MESSAGE = (
    'Enter a valid "slug" consisting of letters, numbers, underscores or '
    'hyphens.'
)


def _client(creator):
    client = APIClient()
    client.force_authenticate(creator)
    return client


def _create(client, **fields):
    return client.post("/api/zpage/", {
        "title": "A page",
        "content": "Page content",
        "is_published": False,
        "tags": [],
        **fields,
    }, format="json")


@pytest.mark.django_db
def test_a_dotted_vanity_is_normalized_not_refused(creator_factory):
    """The prod case: `zebra6.4.1` was a 400; it is `zebra641`."""
    response = _create(_client(creator_factory()), vanity="zebra6.4.1")

    assert response.status_code == 201, response.content
    assert response.data["vanity"] == "zebra641"
    assert zPage.objects.get(
        free2zaddr=response.data["free2zaddr"]
    ).vanity == "zebra641"


@pytest.mark.django_db
def test_spaces_case_and_accents_normalize_as_they_always_meant_to(
    creator_factory,
):
    response = _create(_client(creator_factory()), vanity="Café Déjà Vu")

    assert response.status_code == 201, response.content
    assert response.data["vanity"] == "cafe-deja-vu"


@pytest.mark.django_db
@pytest.mark.parametrize("vanity", [
    "مرحبا بالعالم",          # all Arabic -- the 09-19 / 09-24 creator
    "한국어-요약",             # all Korean -- the 09-14 creator
    "zcash-digest-한국어",     # mixed: slugify would store `zcash-digest`
    "مرحبا-hello",
    "straße",                  # `ß` has no ASCII decomposition: slugify drops it
    "page-٣",                  # Arabic-Indic digit
])
def test_a_typed_vanity_slugify_would_mangle_is_a_clear_400(
    creator_factory, vanity,
):
    """Refused, never silently rewritten -- and with a message that says why."""
    response = _create(_client(creator_factory()), vanity=vanity)

    assert response.status_code == 400
    assert response.json() == {"vanity": [VANITY_ASCII_ONLY_MESSAGE]}
    assert DRF_SLUG_MESSAGE not in response.content.decode()
    assert not zPage.objects.exists()


@pytest.mark.django_db
def test_a_vanity_of_only_punctuation_keeps_its_explicit_message(
    creator_factory,
):
    response = _create(_client(creator_factory()), vanity="...")

    assert response.status_code == 400
    assert response.json() == {
        "vanity": ["Vanity must contain letters or numbers."]
    }


@pytest.mark.django_db
@pytest.mark.parametrize("vanity", ["", None])
def test_an_empty_vanity_is_still_a_choice(creator_factory, vanity):
    """A blank vanity stays blank when the title already has an ASCII slug."""
    response = _create(
        _client(creator_factory()), title="A page", vanity=vanity,
    )

    assert response.status_code == 201, response.content
    assert not response.data["vanity"]
    assert response.data["get_url"].endswith(response.data["free2zaddr"])


@pytest.mark.django_db
@pytest.mark.parametrize("title", [
    "مرحبا بالعالم",
    "한국어 요약",
    "日本語のタイトル",
])
def test_non_latin_title_gets_an_ascii_fallback_vanity_on_create(
    creator_factory, title,
):
    response = _create(
        _client(creator_factory()),
        title=title,
        vanity="",
        is_published=True,
    )

    assert response.status_code == 201, response.content
    assert response.data["is_published"]
    vanity = response.data["vanity"]
    assert vanity.startswith("p-")
    assert vanity[2:] in response.data["free2zaddr"].replace("-", "")
    assert response.data["get_url"].endswith(vanity)

    page = zPage.objects.get(free2zaddr=response.data["free2zaddr"])
    assert page.vanity == vanity


@pytest.mark.django_db
def test_fallback_vanities_are_unique_and_do_not_replace_custom_vanities(
    creator_factory,
):
    first = _create(
        _client(creator_factory()), title="한국어 요약", vanity="",
    )
    second = _create(
        _client(creator_factory()), title="한국어 요약", vanity="",
    )
    custom = _create(
        _client(creator_factory()),
        title="한국어 요약",
        vanity="my-own-url",
    )

    assert first.status_code == second.status_code == custom.status_code == 201
    assert first.data["vanity"] != second.data["vanity"]
    assert custom.data["vanity"] == "my-own-url"


@pytest.mark.django_db
def test_fallback_expands_its_id_prefix_when_a_vanity_is_already_taken(
    creator_factory,
):
    zPage.objects.create(
        creator=creator_factory(),
        free2zaddr=str(uuid.uuid4()),
        vanity="p-aaaaaaaaaaaa",
        title="Existing page",
    )

    vanity = _fallback_zpage_vanity(
        "日本語のタイトル", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    )

    assert vanity == "p-aaaaaaaaaaaaaa"


@pytest.mark.django_db
def test_fallback_is_stable_when_the_page_already_holds_it(creator_factory):
    """An overlapping publish computed from a stale, vanityless instance must
    pick the value the first one committed, not a longer prefix."""
    address = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    zPage.objects.create(
        creator=creator_factory(),
        free2zaddr=address,
        vanity="p-cccccccccccc",
        title="日本語のタイトル",
    )

    assert _fallback_zpage_vanity("日本語のタイトル", address) == "p-cccccccccccc"


@pytest.mark.django_db
def test_fallback_skips_a_prefix_that_is_a_username(creator_factory):
    """`validate_vanity` refuses a username; the fallback bypasses it."""
    creator = creator_factory()
    creator.username = "p-bbbbbbbbbbbb"
    creator.save(update_fields=["username"])

    vanity = _fallback_zpage_vanity(
        "日本語のタイトル", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    )

    assert vanity == "p-bbbbbbbbbbbbbb"


@pytest.mark.django_db
@pytest.mark.parametrize("method", ["patch", "put"])
def test_publishing_through_the_source_variant_route_assigns_fallback(
    creator_factory, method,
):
    """The variant route addressed at the source language is a canonical
    write too, so it must not publish a non-Latin page without a vanity."""
    creator = creator_factory()
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        title="한국어 요약",
        content="Page content",
        source_language="ko",
    )
    body = {"is_published": True}
    if method == "put":
        body.update(title="한국어 요약", content="Page content", tags=[])

    response = getattr(_client(creator), method)(
        f"/api/zpage/{page.free2zaddr}/variants/ko/", body, format="json",
    )

    assert response.status_code == 200, response.content
    page.refresh_from_db()
    assert page.is_published
    assert page.vanity and page.vanity.startswith("p-")
    assert page.vanity[2:] in page.free2zaddr.replace("-", "")


@pytest.mark.django_db
def test_updating_an_existing_vanityless_page_does_not_assign_a_new_vanity(
    creator_factory,
):
    creator = creator_factory()
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        title="Legacy title",
        content="Page content",
        is_published=True,
    )

    response = _client(creator).put(f"/api/zpage/{page.free2zaddr}/", {
        "title": "مرحبا بالعالم",
        "content": "Page content",
        "is_published": True,
        "tags": [],
        "vanity": "",
    }, format="json")

    assert response.status_code == 200, response.content
    assert not response.data["vanity"]
    assert not zPage.objects.get(pk=page.pk).vanity


@pytest.mark.django_db
def test_publishing_a_vanityless_non_latin_draft_assigns_fallback(
    creator_factory,
):
    creator = creator_factory()
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        title="Untitled",
        content="Page content",
    )

    response = _client(creator).put(f"/api/zpage/{page.free2zaddr}/", {
        "title": "한국어 요약",
        "content": "Page content",
        "is_published": True,
        "tags": [],
        "vanity": "",
    }, format="json")

    assert response.status_code == 200, response.content
    vanity = response.data["vanity"]
    assert vanity.startswith("p-")
    assert vanity[2:] in page.free2zaddr.replace("-", "")
    assert zPage.objects.get(pk=page.pk).vanity == vanity


@pytest.mark.django_db
def test_autosave_put_with_a_dotted_vanity_succeeds(creator_factory):
    creator = creator_factory()
    page = zPage.objects.create(
        creator=creator, free2zaddr=str(uuid.uuid4()),
        title="Zebra 6.4.1", content="Release notes",
    )

    response = _client(creator).put(f"/api/zpage/{page.free2zaddr}/", {
        "title": "Zebra 6.4.1",
        "content": "Release notes",
        "is_published": False,
        "tags": [],
        "vanity": "zebra6.4.1",
    }, format="json")

    assert response.status_code == 200, response.content
    page.refresh_from_db()
    assert page.vanity == "zebra641"


@pytest.mark.django_db
def test_an_unchanged_legacy_vanity_is_not_rewritten(creator_factory):
    """ §3 still holds: echoing the stored value back changes nothing,
    even when that stored value would not pass today's rules."""
    creator = creator_factory()
    page = zPage.objects.create(
        creator=creator, free2zaddr=str(uuid.uuid4()), vanity="CoolStuff",
        title="Legacy", content="Legacy content", is_published=True,
    )

    response = _client(creator).put(f"/api/zpage/{page.free2zaddr}/", {
        "title": "Legacy, retitled",
        "content": "Legacy content",
        "is_published": True,
        "tags": [],
        "vanity": "CoolStuff",
    }, format="json")

    assert response.status_code == 200, response.content
    page.refresh_from_db()
    assert page.vanity == "CoolStuff"


@pytest.mark.django_db
def test_uniqueness_is_still_enforced_without_the_model_validator(
    creator_factory,
):
    """Declaring the field drops ModelSerializer's auto UniqueValidator;
    `validate_vanity`'s own case-insensitive check must still refuse."""
    zPage.objects.create(
        creator=creator_factory(), free2zaddr=str(uuid.uuid4()),
        vanity="taken", title="Taken", content="x",
    )

    response = _create(_client(creator_factory()), vanity="Taken")

    assert response.status_code == 400
    assert "not unique" in response.json()["vanity"][0]
