"""A variant body and its write validator must describe the same saved edit."""
import threading

import pytest
from django.db import OperationalError, connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from django.urls import resolve
from rest_framework.test import APIClient, APIRequestFactory, force_authenticate

from dj.apps.g12f.models import ZPageTranslation
from dj.apps.g12f.serializers.zpage import zPageDetailSerializer
from dj.apps.g12f.test_zpage_preconditions import (
    make_page, owner_client, variant_url,
)
from dj.apps.g12f.views import zpage as views


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("variant_reads", [False, True])
@pytest.mark.parametrize("language", ["en", "es"])
@pytest.mark.parametrize("lock_read", [True, False], ids=["protected", "race-control"])
def test_variant_read_never_authorizes_overwriting_an_unseen_edit(
    creator_factory, monkeypatch, variant_reads, language, lock_read,
):
    """Inject a real second-connection save AFTER real serialization.

    The control removes only the reader's lock: it must reproduce old body +
    new ETag and an accepted stale overwrite. With the lock, the writer must
    time out in Postgres, then succeed after GET completes; the old reader's
    subsequent conditional write must fail. No serializer or ETag is faked.
    """
    creator = creator_factory()
    page = make_page(creator)
    if language == "es":
        ZPageTranslation.objects.create(
            zpage=page, language="es", title="Título", content="Old body",
            is_published=False,
        )
    old_body = "English body" if language == "en" else "Old body"
    client = owner_client(creator)
    url = variant_url(page, language)
    read_url = f"{url}?mine=true"
    reader_thread = threading.get_ident()
    real_lock = views._lock_zpage_for_variant_write
    real_representation = zPageDetailSerializer.to_representation
    writer_results = []
    injected = False

    def maybe_lock(instance):
        if not lock_read and threading.get_ident() == reader_thread:
            return instance
        return real_lock(instance)

    def concurrent_save():
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET lock_timeout = '250ms'")
            request = APIRequestFactory().patch(
                url, {"content": "Unseen newer edit"}, format="json",
            )
            force_authenticate(request, creator)
            route = resolve(url)
            # Dispatch the actual route directly: Django test clients listen
            # to one global exception signal, so the expected writer timeout
            # would otherwise also be re-raised by the concurrent GET client.
            result = route.func(request, **route.kwargs)
            writer_results.append(result.status_code)
        except OperationalError as error:
            writer_results.append(getattr(error.__cause__, "sqlstate", None))
        except Exception as error:
            writer_results.append(error)
        finally:
            connection.close()

    def serialize_then_race(serializer, instance):
        nonlocal injected
        result = real_representation(serializer, instance)
        if threading.get_ident() == reader_thread and not injected:
            injected = True
            writer = threading.Thread(target=concurrent_save)
            writer.start()
            writer.join(timeout=10)
            assert not writer.is_alive(), "concurrent save did not finish"
        return result

    monkeypatch.setattr(views, "_lock_zpage_for_variant_write", maybe_lock)
    monkeypatch.setattr(
        zPageDetailSerializer, "to_representation", serialize_then_race,
    )
    with override_settings(ZPAGE_VARIANT_READS=variant_reads):
        response = client.get(read_url)
        assert response.status_code == 200
        assert response.data["content"] == old_body
        if lock_read:
            assert writer_results == ["55P03"], writer_results
            saved = client.patch(
                url, {"content": "Unseen newer edit"}, format="json",
            )
            assert saved.status_code == 200
        else:
            assert writer_results == [200], writer_results
        current = client.get(read_url)
        assert current.data["content"] == "Unseen newer edit"
        assert (response["ETag"] == current["ETag"]) is (not lock_read)
        stale = client.patch(
            url, {"content": old_body}, format="json",
            HTTP_IF_MATCH=response["ETag"],
        )
        assert stale.status_code == (412 if lock_read else 200)
        assert client.get(read_url).data["content"] == (
            "Unseen newer edit" if lock_read else old_body
        )


@pytest.mark.django_db
@pytest.mark.parametrize("variant_reads", [False, True])
def test_variant_read_lock_does_not_write(creator_factory, variant_reads):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=False,
    )
    with override_settings(ZPAGE_VARIANT_READS=variant_reads):
        with CaptureQueriesContext(connection) as queries:
            response = owner_client(creator).get(
                f"{variant_url(page, 'es')}?mine=true"
            )
    assert response.status_code == 200
    assert not [
        query["sql"] for query in queries
        if query["sql"].lstrip().split(None, 1)[0].upper()
        in {"INSERT", "UPDATE", "DELETE"}
    ]


@pytest.mark.django_db
def test_variant_read_rechecks_visibility_after_taking_lock(
    creator_factory, monkeypatch,
):
    creator = creator_factory()
    page = make_page(creator)
    real_lock = views._lock_zpage_for_variant_write

    def unpublish_before_lock(instance):
        # A writer can commit between the initial visible lookup and the lock.
        type(page).objects.filter(pk=page.pk).update(is_published=False)
        return real_lock(instance)

    monkeypatch.setattr(
        views, "_lock_zpage_for_variant_write", unpublish_before_lock,
    )
    assert APIClient().get(variant_url(page, "en")).status_code == 404
