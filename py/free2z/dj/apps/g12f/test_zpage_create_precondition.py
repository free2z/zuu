"""`If-None-Match: *` -- create-only semantics on zPage variant writes.

`If-Match`  protects a write against a version that already exists. It
has nothing to say about a CREATE: two tabs both observe that `fr` has no
variant, both PUT `/variants/fr/`, and the serializer's upsert means the second
one silently replaces the first one's brand-new translation. RFC 9110's answer
is `If-None-Match: *` -- "apply this only if there is no current
representation" -- which turns the losing PUT into a 412.

What has to stay true:

1. **The second create loses loudly**, and the first one's text is what is
   stored -- sequentially and under a real two-connection race.
2. **No header, no change.** Every deployed client and every third-party API
   consumer still gets create-or-replace.
3. **A value we do not implement is a 400, never ignored.** A client that
   believes it is protected and is not is the bug being removed.
4. **The contract is declared** (CLAUDE.md, "A URL never dictates what goes in
   the database"): a header that decides whether a write happens is in
   `f2z.yaml`, on every route that reads it, and a browser can send it.
"""
import threading
import uuid

import pytest
from django.db import connection
from rest_framework.test import APIClient

from dj.apps.g12f.models import zPage, ZPageTranslation, ZPageVariant


def make_page(creator, **overrides):
    values = {
        "creator": creator,
        "free2zaddr": str(uuid.uuid4()),
        "title": "English title",
        "description": "English description",
        "content": "English body",
        "source_language": "en",
        "is_published": True,
    }
    values.update(overrides)
    return zPage.objects.create(**values)


def owner_client(creator):
    client = APIClient()
    client.force_authenticate(creator)
    return client


def body(content, **overrides):
    payload = {"title": "Titre", "content": content, "tags": []}
    payload.update(overrides)
    return payload


def variant_url(page, language):
    return f"/api/zpage/{page.free2zaddr}/variants/{language}/"


def alias_url(page, language):
    return f"/api/zpage/{page.free2zaddr}/translations/{language}/"


def stored_content(page, language):
    return ZPageTranslation.objects.get(zpage=page, language=language).content


# Both write routes run `_save_variant`, and the deployed editor writes to the
# deprecated alias -- so every behavioural test covers both.
ROUTES = pytest.mark.parametrize("route", [variant_url, alias_url])


# --------------------------------------------------------------------------
# Behaviour
# --------------------------------------------------------------------------

@ROUTES
@pytest.mark.django_db
def test_create_only_write_creates_when_nothing_exists(creator_factory, route):
    creator = creator_factory()
    page = make_page(creator)

    response = owner_client(creator).put(
        route(page, "fr"), body("premier"), format="json",
        HTTP_IF_NONE_MATCH="*",
    )

    assert response.status_code == 200, response.content
    assert response["ETag"]
    assert stored_content(page, "fr") == "premier"


@ROUTES
@pytest.mark.django_db
def test_second_create_only_write_loses_loudly(creator_factory, route):
    """The bug: two tabs both start French; the second replaced the first."""
    creator = creator_factory()
    page = make_page(creator)
    tab_a, tab_b = owner_client(creator), owner_client(creator)

    first = tab_a.put(
        route(page, "fr"), body("onglet A"), format="json",
        HTTP_IF_NONE_MATCH="*",
    )
    second = tab_b.put(
        route(page, "fr"), body("onglet B"), format="json",
        HTTP_IF_NONE_MATCH="*",
    )

    assert first.status_code == 200
    assert second.status_code == 412
    assert "already exists" in second.json()["detail"]
    # The loser changed nothing, in either row shape.
    assert stored_content(page, "fr") == "onglet A"
    assert ZPageVariant.objects.get(zpage=page, language="fr").content == (
        "onglet A"
    )


@pytest.mark.django_db
def test_create_only_refuses_a_variant_that_exists_only_as_a_mirror_row(
    creator_factory,
):
    """An AI draft can land straight in the variant table ( P8).

    "Exists" means a row in EITHER shape -- the same definition the `If-Match`
    validator uses -- or a creator's blank new translation would overwrite a
    paid AI draft that has no legacy row yet.
    """
    creator = creator_factory()
    page = make_page(creator)
    ZPageVariant.objects.create(
        zpage=page, language="de", title="KI", description="",
        content="KI-Entwurf", origin=ZPageVariant.AI,
    )

    response = owner_client(creator).put(
        variant_url(page, "de"), body("von Hand"), format="json",
        HTTP_IF_NONE_MATCH="*",
    )

    assert response.status_code == 412
    assert ZPageVariant.objects.get(zpage=page, language="de").content == (
        "KI-Entwurf"
    )


@pytest.mark.django_db
def test_create_only_on_the_source_language_is_refused(creator_factory):
    """The source is a variant like any other ( §3.1) -- and it exists."""
    creator = creator_factory()
    page = make_page(creator)

    response = owner_client(creator).put(
        variant_url(page, "en"), body("replaced"), format="json",
        HTTP_IF_NONE_MATCH="*",
    )

    assert response.status_code == 412
    page.refresh_from_db()
    assert page.content == "English body"


@pytest.mark.django_db
def test_without_the_header_a_write_still_replaces(creator_factory):
    """No header, no change: create-or-replace exactly as before."""
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)

    assert client.put(
        variant_url(page, "fr"), body("v1"), format="json"
    ).status_code == 200
    assert client.put(
        variant_url(page, "fr"), body("v2"), format="json"
    ).status_code == 200
    assert stored_content(page, "fr") == "v2"


@pytest.mark.parametrize(
    "value", ['"some-etag"', 'W/"some-etag"', "", "  ", '*, "x"', "**"]
)
@pytest.mark.django_db
def test_an_unsupported_value_is_a_400_not_a_silent_pass(
    creator_factory, value,
):
    """Presence decides, not truthiness: an empty value must not evaporate."""
    creator = creator_factory()
    page = make_page(creator)

    response = owner_client(creator).put(
        variant_url(page, "fr"), body("x"), format="json",
        HTTP_IF_NONE_MATCH=value,
    )

    assert response.status_code == 400, value
    assert "If-None-Match" in response.json()
    assert not ZPageTranslation.objects.filter(
        zpage=page, language="fr"
    ).exists()


@pytest.mark.django_db
def test_if_match_is_evaluated_before_if_none_match(creator_factory):
    """RFC 9110 §13.2.2 order. Both present on an existing variant: the
    current `If-Match` passes, then `*` fails because it exists -- 412,
    nothing written."""
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)
    created = client.put(variant_url(page, "fr"), body("v1"), format="json")

    response = client.put(
        variant_url(page, "fr"), body("v2"), format="json",
        HTTP_IF_MATCH=created["ETag"], HTTP_IF_NONE_MATCH="*",
    )

    assert response.status_code == 412
    assert stored_content(page, "fr") == "v1"


@pytest.mark.django_db
def test_patch_honours_it_too(creator_factory):
    """PATCH shares `_save_variant`, and declares the header, so it must
    behave: `*` on an existing variant refuses the partial update."""
    creator = creator_factory()
    page = make_page(creator)
    client = owner_client(creator)
    client.put(variant_url(page, "fr"), body("v1"), format="json")

    response = client.patch(
        variant_url(page, "fr"), {"title": "nouveau"}, format="json",
        HTTP_IF_NONE_MATCH="*",
    )

    assert response.status_code == 412
    assert ZPageTranslation.objects.get(
        zpage=page, language="fr"
    ).title == "Titre"


@pytest.mark.django_db(transaction=True)
def test_two_concurrent_create_only_writes_one_wins(creator_factory):
    """The real race, on two connections, released together.

    Without the check running under the parent-row lock, both requests see
    "no French", both pass, and the second upsert replaces the first.
    """
    creator = creator_factory()
    page = make_page(creator)
    barrier = threading.Barrier(2)
    results = [None, None]

    def worker(i):
        try:
            client = owner_client(creator)
            barrier.wait(timeout=10)
            results[i] = client.put(
                variant_url(page, "fr"), body(f"onglet {i}"), format="json",
                HTTP_IF_NONE_MATCH="*",
            ).status_code
        except Exception as exc:  # asserted on below
            results[i] = exc
        finally:
            connection.close()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert not any(thread.is_alive() for thread in threads), "deadlocked"

    assert sorted(results) == [200, 412], results
    winner = results.index(200)
    assert stored_content(page, "fr") == f"onglet {winner}"


# --------------------------------------------------------------------------
# The contract
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_if_none_match_is_declared_where_it_is_read():
    """A header that decides whether a write happens is in `f2z.yaml` on every
    route that reads it -- including the deprecated alias the editor actually
    writes to -- and nowhere it is ignored."""
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)
    paths = schema["paths"]

    def header(path, method):
        for parameter in paths[path][method].get("parameters", []):
            if parameter.get("in") == "header" and (
                parameter["name"] == "If-None-Match"
            ):
                return parameter
        return None

    for path, method in (
        ("/api/zpage/{id}/variants/{language}/", "put"),
        ("/api/zpage/{id}/variants/{language}/", "patch"),
        ("/api/zpage/{id}/translations/{language}/", "put"),
    ):
        parameter = header(path, method)
        assert parameter is not None, (path, method)
        assert parameter["schema"].get("enum") == ["*"], (path, method)
        assert "412" in parameter["description"]
        assert "400" in parameter["description"]
        assert "412" in paths[path][method]["responses"], (path, method)

    # Not read there, so not declared there: a parameter the route ignores is
    # a promise of protection that does not exist.
    for path, method in (
        ("/api/zpage/", "post"),
        ("/api/zpage/{id}/", "put"),
        ("/api/zpage/{id}/", "patch"),
    ):
        assert header(path, method) is None, (path, method)


def test_if_none_match_is_sendable_from_a_cross_origin_browser():
    """corsheaders' default_headers lacks it, so without the settings entry a
    cross-origin preflight fails and the client silently gets
    create-or-replace -- the same trap `If-Match` and `Idempotency-Key` hit."""
    from django.conf import settings

    assert "if-none-match" in [
        h.lower() for h in settings.CORS_ALLOW_HEADERS
    ]
