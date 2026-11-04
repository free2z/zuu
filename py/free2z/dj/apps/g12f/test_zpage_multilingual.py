import importlib
import uuid
import re
from datetime import timedelta

import pytest
import psycopg2
from django.conf import settings
from django.db import connection
from django.db import DatabaseError, IntegrityError, OperationalError, transaction
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.recorder import MigrationRecorder
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.g12f.models import PageOrder, Series, zPage, ZPageTranslation


def _defer_through_fake(monkeypatch):
    """Route ``defer_in_transaction`` to a faked ``configure(...)``'s ``defer``.

    The signals enqueue through ``dj.apps.jobs.transactional``, which
    re-binds a real procrastinate ``JobDeferrer`` to Django's connection. A
    fake returned by a patched ``configure`` is not one, so the helper is
    replaced by the same contract it implements: defer, and treat
    ``AlreadyEnqueued`` as "a pending job already covers this".
    """
    from procrastinate.exceptions import AlreadyEnqueued

    def shim(deferrer, **kwargs):
        try:
            return deferrer.defer(**kwargs)
        except AlreadyEnqueued:
            return None

    monkeypatch.setattr("dj.apps.g12f.signals.defer_in_transaction", shim)


def test_concurrent_index_timeout_is_restored_after_ddl_error():
    """0102's non-atomic concurrent DDL must not poison its connection."""
    migration = importlib.import_module(
        "dj.apps.g12f.migrations.0102_backfill_zpage_published_at",
    )
    statement = "CREATE INDEX CONCURRENTLY deliberately_broken"
    queries = []

    class Cursor:
        def __init__(self):
            self.last_sql = None

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_value, traceback):
            return False

        def execute(self, sql, params=None):
            queries.append((sql, params))
            self.last_sql = sql
            if sql == statement:
                raise RuntimeError("simulated concurrent-index failure")

        def fetchone(self):
            if self.last_sql == "SHOW lock_timeout":
                return ("11s",)
            assert self.last_sql == "SHOW statement_timeout"
            return ("17s",)

    class Connection:
        def cursor(self):
            return Cursor()

    with pytest.raises(RuntimeError, match="simulated concurrent-index"):
        migration._run_concurrent_index_sql(Connection(), statement)

    assert queries == [
        ("SHOW lock_timeout", None),
        ("SHOW statement_timeout", None),
        ("SELECT set_config('lock_timeout', %s, false)", ["0"]),
        (
            "SELECT set_config('statement_timeout', %s, false)",
            [migration.CONCURRENT_INDEX_STATEMENT_TIMEOUT],
        ),
        (statement, None),
        ("SELECT set_config('statement_timeout', %s, false)", ["17s"]),
        ("SELECT set_config('lock_timeout', %s, false)", ["11s"]),
    ]


def test_translation_source_language_header_is_allowed_by_cors():
    assert "x-free2z-source-language" in settings.CORS_ALLOW_HEADERS


def test_source_language_is_editable_in_admin():
    """ §3.2: the language label is mutable, in the admin too.

    This test used to assert the exact opposite — that ``source_language``
    became read-only once a page existed — mirroring the serializer's
    write-once rule. That rule is the root of the §1.1 editor trap and is gone,
    so staff editing a mislabelled page now go through the ordinary save path,
    which dual-writes the source variant.
    """
    from django.contrib import admin

    page_admin = admin.site._registry[zPage]

    assert "source_language" not in page_admin.get_readonly_fields(None)
    assert "source_language" not in page_admin.get_readonly_fields(
        None, object()
    )


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


def endpoint(page):
    return f"/api/zpage/{page.free2zaddr}/"


def translation_endpoint(page, language):
    return f"{endpoint(page)}translations/{language}/"


def g12f_leaf():
    """The newest g12f migration, read from the graph rather than hardcoded.

    Asserting a single leaf here is deliberate: a forked graph is exactly the
    failure that aborts the production deploy, and it must fail loudly in the
    test that migrates back and forth rather than silently restoring whichever
    leaf happens to sort first.
    """
    leaves = MigrationLoader(connection).graph.leaf_nodes("g12f")
    assert len(leaves) == 1, f"g12f migration graph has forked: {leaves}"
    return leaves[0]


def all_leaves():
    """Restore every app leaf after the g12f-only migration dance."""
    return MigrationLoader(connection).graph.leaf_nodes()


@pytest.mark.django_db(transaction=True)
def test_multilingual_migrations_retry_and_preserve_rolling_writes():
    """Exercise the deploy failure modes that ordinary latest-schema tests miss."""
    before = ("g12f", "0087_zpage_canonical_url")
    add_column = ("g12f", "0088_add_zpage_source_language")
    check_added = ("g12f", "0091_add_zpage_source_language_check")
    check_validated = ("g12f", "0092_validate_zpage_source_language")
    constrained = ("g12f", "0093_require_zpage_source_language")
    language_index = ("g12f", "0094_index_zpage_source_language")
    # This test deliberately rolls back to 0095 to exercise its concurrent
    # index retry. Restore whichever g12f leaf the checked-out code declares,
    # though: pinning the cleanup to 0095 silently removed later columns for
    # the TransactionTestCase-style tests that followed it.
    retry_target = ("g12f", "0095_zpage_pub_latest_idx")
    publication_column = ("g12f", "0101_zpage_published_at")
    publication_indexes = ("g12f", "0102_backfill_zpage_published_at")
    language_index_name = "g12f_zpage_source_language_3551cc99"
    latest_index_name = "g12f_zpage_pub_latest_idx"
    publication_index_name = "g12f_zpage_pub_published_idx"
    chronological_index_name = "g12f_zpage_chrono_idx"
    creator_chronological_index_name = "g12f_zpage_creator_chrono_idx"
    blocker = None
    previous_lock_timeout = None
    previous_statement_timeout = None

    try:
        executor = MigrationExecutor(connection)
        executor.migrate([before])
        old_apps = executor.loader.project_state(before).apps
        Creator = old_apps.get_model("g12f", "Creator")
        ZPage = old_apps.get_model("g12f", "zPage")
        creator = Creator.objects.create(username="migration-retry-owner")
        ZPage.objects.create(
            creator=creator,
            free2zaddr="legacy-before-language-column",
            title="Legacy",
            content="Legacy body",
        )

        # Hold a conflicting lock long enough for 0087's bounded DDL to fail.
        # Since 0087 is atomic, neither its column nor migration record may be
        # left behind, and the exact same migration must then retry cleanly.
        db = connection.settings_dict
        blocker = psycopg2.connect(
            dbname=db["NAME"],
            user=db["USER"],
            password=db["PASSWORD"],
            host=db["HOST"],
            port=db["PORT"],
        )
        with blocker.cursor() as cursor:
            cursor.execute("LOCK TABLE g12f_zpage IN ACCESS SHARE MODE")

        executor = MigrationExecutor(connection)
        with pytest.raises(OperationalError):
            executor.migrate([add_column])
        assert not MigrationRecorder(connection).migration_qs.filter(
            app="g12f", name=add_column[1]
        ).exists()
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_name = 'g12f_zpage' "
                "AND column_name = 'source_language'"
            )
            assert cursor.fetchone() is None

        blocker.rollback()
        blocker.close()
        blocker = None
        executor = MigrationExecutor(connection)
        executor.migrate([add_column])

        # An old pod still running the 0086 model omits the new column. The DB
        # default must preserve its unknown language rather than silently
        # labelling arbitrary classic-editor content as English.
        ZPage.objects.create(
            creator=creator,
            free2zaddr="old-pod-after-language-column",
            title="Rolling",
            content="Rolling body",
        )
        executor = MigrationExecutor(connection)
        executor.migrate([check_added])
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT convalidated FROM pg_constraint "
                "WHERE conname = 'g12f_zpage_source_language_not_null'"
            )
            assert cursor.fetchone() == (False,)

        executor = MigrationExecutor(connection)
        executor.migrate([check_validated])
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT convalidated FROM pg_constraint "
                "WHERE conname = 'g12f_zpage_source_language_not_null'"
            )
            assert cursor.fetchone() == (True,)

        executor = MigrationExecutor(connection)
        executor.migrate([constrained])
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT free2zaddr, source_language FROM g12f_zpage "
                "WHERE free2zaddr IN (%s, %s) ORDER BY free2zaddr",
                [
                    "legacy-before-language-column",
                    "old-pod-after-language-column",
                ],
            )
            assert cursor.fetchall() == [
                ("legacy-before-language-column", "und"),
                ("old-pod-after-language-column", "und"),
            ]

            # Simulate a process dying after concurrent index DDL committed but
            # before Django recorded 0094. Its retry must replace the leftover.
            cursor.execute(
                f"CREATE INDEX {language_index_name} "
                "ON g12f_zpage (source_language)"
            )
        executor = MigrationExecutor(connection)
        executor.migrate([language_index])
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT i.indisvalid FROM pg_index i "
                "JOIN pg_class c ON c.oid = i.indexrelid "
                "WHERE c.relname = %s",
                [language_index_name],
            )
            assert cursor.fetchall() == [(True,)]

            # Exercise the same retry window for 0095. The migration must
            # replace a committed leftover without blocking table writes, and
            # retain both the deterministic descending order and predicate.
            cursor.execute(
                f"CREATE INDEX {latest_index_name} "
                "ON g12f_zpage (created_at DESC, id DESC) "
                "WHERE is_published"
            )
        executor = MigrationExecutor(connection)
        executor.migrate([retry_target])
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT i.indisvalid, pg_get_indexdef(i.indexrelid), "
                "pg_get_expr(i.indpred, i.indrelid) "
                "FROM pg_index i "
                "JOIN pg_class c ON c.oid = i.indexrelid "
                "WHERE c.relname = %s",
                [latest_index_name],
            )
            valid, definition, predicate = cursor.fetchone()
            assert valid is True
            assert "created_at DESC, id DESC" in definition
            assert "is_published" in predicate

        # A deploy can die after 0098's concurrent DDL commits but before the
        # migration record is written. A valid completed public index must be
        # retained on retry; a same-name but wrong index must be rebuilt; and
        # the temporary DDL timeouts must restore a connection's pre-existing
        # session settings afterwards.
        executor = MigrationExecutor(connection)
        executor.migrate([publication_column])
        with connection.cursor() as cursor:
            cursor.execute(
                f"CREATE INDEX {publication_index_name} ON g12f_zpage "
                "((COALESCE(published_at, created_at)) DESC, id DESC) "
                "WHERE is_published"
            )
            cursor.execute(
                "SELECT oid FROM pg_class WHERE relname = %s",
                [publication_index_name],
            )
            retained_index_oid = cursor.fetchone()[0]

            # Deliberately create a valid but wrong definition. The migration
            # must not mistake a same-name index for its ordering support.
            cursor.execute(
                f"CREATE INDEX {chronological_index_name} ON g12f_zpage "
                "(created_at DESC, id DESC)"
            )
            cursor.execute(
                "SELECT oid FROM pg_class WHERE relname = %s",
                [chronological_index_name],
            )
            wrong_index_oid = cursor.fetchone()[0]
            cursor.execute("SHOW lock_timeout")
            previous_lock_timeout = cursor.fetchone()[0]
            cursor.execute("SHOW statement_timeout")
            previous_statement_timeout = cursor.fetchone()[0]
            cursor.execute(
                "SELECT set_config('lock_timeout', %s, false)", ["11s"],
            )
            cursor.execute(
                "SELECT set_config('statement_timeout', %s, false)",
                ["17s"],
            )

        executor = MigrationExecutor(connection)
        executor.migrate([publication_indexes])

        with connection.cursor() as cursor:
            cursor.execute("SHOW lock_timeout")
            assert cursor.fetchone()[0] == "11s"
            cursor.execute("SHOW statement_timeout")
            assert cursor.fetchone()[0] == "17s"
            cursor.execute(
                """
                SELECT c.relname, c.oid, i.indisvalid, i.indisready,
                       pg_get_indexdef(i.indexrelid),
                       pg_get_expr(i.indpred, i.indrelid)
                FROM pg_index i
                JOIN pg_class c ON c.oid = i.indexrelid
                WHERE c.relname IN (%s, %s, %s)
                ORDER BY c.relname
                """,
                [
                    publication_index_name,
                    chronological_index_name,
                    creator_chronological_index_name,
                ],
            )
            index_rows = {
                name: (oid, valid, ready, definition, predicate)
                for name, oid, valid, ready, definition, predicate
                in cursor.fetchall()
            }

        assert set(index_rows) == {
            publication_index_name,
            chronological_index_name,
            creator_chronological_index_name,
        }
        retained = index_rows[publication_index_name]
        assert retained[0] == retained_index_oid
        assert retained[1:3] == (True, True)
        assert "COALESCE(published_at, created_at)" in retained[3]
        assert "is_published" in retained[4]

        rebuilt = index_rows[chronological_index_name]
        assert rebuilt[0] != wrong_index_oid
        assert rebuilt[1:3] == (True, True)
        assert "COALESCE(published_at, created_at)" in rebuilt[3]
        assert rebuilt[4] is None

        creator_index = index_rows[creator_chronological_index_name]
        assert creator_index[1:3] == (True, True)
        assert "creator_id" in creator_index[3]
        assert "COALESCE(published_at, created_at)" in creator_index[3]
        assert creator_index[4] is None
    finally:
        if blocker is not None:
            blocker.rollback()
            blocker.close()
        # This test sets both GUCs on the shared connection to provoke the
        # concurrent-DDL paths. Restore them before anything else, or every
        # later test on this pooled connection inherits them.
        if previous_lock_timeout is not None:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT set_config('lock_timeout', %s, false)",
                    [previous_lock_timeout],
                )
        if previous_statement_timeout is not None:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT set_config('statement_timeout', %s, false)",
                    [previous_statement_timeout],
                )
        # Restore the CURRENT leaf, not `latest` (0095). Migrating back to
        # 0095 used to leave the shared test database several migrations
        # behind for every `transaction=True` test that runs after this one --
        # pytest-django runs those last, as a block, so the damage lands on
        # whichever transactional test happens to be next in file order and
        # looks like a bug in that test. Reading the leaf from the graph keeps
        # this correct without needing a bump every time a migration lands.
        MigrationExecutor(connection).migrate(all_leaves())


@pytest.mark.django_db
def test_legacy_create_preserves_undetermined_source_language(creator_factory):
    creator = creator_factory(tuzis=1)
    client = APIClient()
    client.force_authenticate(creator)

    response = client.post("/api/zpage/", {
        "title": "Legacy",
        "content": "Legacy content",
        "tags": [],
    }, format="json")

    assert response.status_code == 201
    assert response.data["source_language"] == "und"
    assert zPage.objects.get(
        free2zaddr=response.data["free2zaddr"]
    ).source_language == "und"


@pytest.mark.django_db
def test_create_accepts_explicit_supported_source_language(creator_factory):
    creator = creator_factory(tuzis=1)
    client = APIClient()
    client.force_authenticate(creator)

    response = client.post("/api/zpage/", {
        "title": "Título",
        "content": "Contenido",
        "source_language": "es",
        "tags": [],
    }, format="json")

    assert response.status_code == 201
    assert response.data["actual_language"] == "es"


@pytest.mark.django_db
def test_create_ignores_lang_query_parameter_for_persistence(creator_factory):
    """: a URL never dictates what goes in the database.

    `?lang=` is the reader's representation selector everywhere else, so on a
    create it must not override — nor conflict with — the body's declared
    source language. It used to 400 the whole create.
    """
    creator = creator_factory(tuzis=1)
    client = APIClient()
    client.force_authenticate(creator)

    response = client.post("/api/zpage/?lang=es", {
        "title": "English",
        "content": "English body",
        "source_language": "en",
        "tags": [],
    }, format="json")

    assert response.status_code == 201
    assert response.data["source_language"] == "en"
    assert zPage.objects.get(
        free2zaddr=response.data["free2zaddr"]
    ).source_language == "en"


@pytest.mark.django_db
def test_create_without_body_language_is_not_branded_by_the_query_string(
    creator_factory,
):
    creator = creator_factory(tuzis=1)
    client = APIClient()
    client.force_authenticate(creator)

    response = client.post("/api/zpage/?lang=fr", {
        "title": "Untagged",
        "content": "Untagged body",
        "tags": [],
    }, format="json")

    assert response.status_code == 201
    assert response.data["source_language"] == "und"
    assert zPage.objects.get(
        free2zaddr=response.data["free2zaddr"]
    ).source_language == "und"


@pytest.mark.django_db
def test_unsupported_ui_locale_query_cannot_fail_a_create(creator_factory):
    """A German-locale client used to be unable to create a zPage at all."""
    creator = creator_factory(tuzis=1)
    client = APIClient()
    client.force_authenticate(creator)

    response = client.post("/api/zpage/?lang=de", {
        "title": "Still created",
        "content": "Body",
        "source_language": "en",
        "tags": [],
    }, format="json")

    assert response.status_code == 201
    page = zPage.objects.get(free2zaddr=response.data["free2zaddr"])
    assert page.source_language == "en"
    assert page.title == "Still created"


@pytest.mark.django_db
def test_unsupported_ui_locale_query_cannot_fail_a_canonical_update(
    creator_factory,
):
    creator = creator_factory()
    page = make_page(creator)
    client = APIClient()
    client.force_authenticate(creator)

    response = client.put(f"{endpoint(page)}?lang=de", {
        "title": "Updated anyway",
        "content": "Updated body",
        "tags": [],
    }, format="json")

    assert response.status_code == 200
    page.refresh_from_db()
    assert page.title == "Updated anyway"
    assert page.source_language == "en"


@pytest.mark.django_db
def test_lang_query_still_selects_the_response_representation_on_write(
    creator_factory,
):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )
    client = APIClient()
    client.force_authenticate(creator)

    response = client.put(f"{endpoint(page)}?lang=es", {
        "title": "Updated canonical",
        "content": "Updated canonical body",
        "tags": [],
    }, format="json")

    assert response.status_code == 200
    assert response.data["actual_language"] == "es"
    assert response.data["title"] == "Título"
    page.refresh_from_db()
    assert page.title == "Updated canonical"


@pytest.mark.django_db
def test_lang_query_cannot_suppress_the_canonical_publish_side_effect(
    creator_factory, monkeypatch
):
    """ F2: a representation selector must not decide a side effect."""
    from dj.apps.g12f.views.zpage import zPageView

    creator = creator_factory()
    page = make_page(creator, vanity="published-canonical")
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="Brouillon", content="Contenu privé",
        is_published=False,
    )
    client = APIClient()
    client.force_authenticate(creator)
    notifications = []
    monkeypatch.setattr(
        zPageView,
        "publish_page",
        lambda self, instance: notifications.append(instance.pk),
    )

    body = {
        "title": "Updated canonical title",
        "content": "Updated canonical body",
        "is_published": True,
        "tags": [],
    }
    plain = client.put(endpoint(page), body, format="json")
    with_lang = client.put(f"{endpoint(page)}?lang=fr", body, format="json")

    assert plain.status_code == 200
    assert with_lang.status_code == 200
    # Identical writes must fire the side effect an identical number of times.
    assert notifications == [page.pk, page.pk]


@pytest.mark.django_db
def test_multilingual_vanity_remains_a_retrievable_page(creator_factory):
    page = make_page(creator_factory(), vanity="multilingual")

    response = APIClient().get("/api/zpage/multilingual/")

    assert response.status_code == 200
    assert response.data["free2zaddr"] == page.free2zaddr


@pytest.mark.django_db
def test_reader_resolution_and_deterministic_fallback(creator_factory):
    page = make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", description="Resumen",
        content="Contenido", is_published=True,
    )
    client = APIClient()

    exact = client.get(endpoint(page), {"lang": "es"})
    fallback = client.get(endpoint(page), {"lang": "fr"})
    legacy = client.get(endpoint(page))

    assert exact.status_code == 200
    assert exact.data["title"] == "Título"
    assert exact.data["fallback_used"] is False
    assert exact.data["available_languages"] == ["en", "es"]
    assert fallback.data["title"] == "English title"
    assert fallback.data["actual_language"] == "en"
    assert fallback.data["fallback_used"] is True
    assert legacy.data["title"] == "English title"
    assert legacy.data["fallback_used"] is False


@pytest.mark.django_db
def test_legacy_unknown_language_is_not_mislabelled_english(creator_factory):
    page = make_page(creator_factory(), source_language="und")

    response = APIClient().get(endpoint(page), {"lang": "es"})

    assert response.status_code == 200
    assert response.data["actual_language"] == "und"
    assert response.data["fallback_used"] is False
    assert response.data["available_languages"] == ["und"]


@pytest.mark.parametrize("pagination", [None, "cursor"])
@pytest.mark.django_db
def test_legacy_language_resolution_applies_after_list_pagination(
    creator_factory,
    pagination,
):
    page = make_page(
        creator_factory(),
        source_language="und",
        vanity=f"legacy-{pagination or 'offset'}",
    )
    params = {"lang": "es"}
    if pagination is not None:
        params["pagination"] = pagination

    response = APIClient().get("/api/zpage/", params)

    assert response.status_code == 200
    listed_page = next(
        item for item in response.data["results"]
        if item["free2zaddr"] == page.free2zaddr
    )
    assert listed_page["actual_language"] == "und"
    assert listed_page["fallback_used"] is False


@pytest.mark.django_db
def test_stale_editor_cannot_create_unknown_source_translation(creator_factory):
    creator = creator_factory()
    page = make_page(creator, source_language="und")
    client = APIClient()
    client.force_authenticate(creator)

    response = client.put(translation_endpoint(page, "es"), {
        "title": "Canonical content mistaken for Spanish",
        "content": page.content,
        "is_published": True,
        "tags": [],
    }, format="json")

    assert response.status_code == 409
    assert not page.translations.exists()
    page.refresh_from_db()
    assert page.title == "English title"
    assert page.content == "English body"


@pytest.mark.django_db
def test_wrong_source_header_cannot_overwrite_unknown_source_translation(
    creator_factory,
):
    creator = creator_factory()
    page = make_page(creator, source_language="und")
    translation = ZPageTranslation.objects.create(
        zpage=page,
        language="es",
        title="Traducción existente",
        content="Contenido existente",
        is_published=True,
    )
    client = APIClient()
    client.force_authenticate(creator)

    response = client.put(
        translation_endpoint(page, "es"),
        {
            "title": "Canonical content mistaken for Spanish",
            "content": page.content,
            "is_published": True,
            "tags": [],
        },
        format="json",
        HTTP_X_FREE2Z_SOURCE_LANGUAGE="en",
    )

    assert response.status_code == 409
    translation.refresh_from_db()
    assert translation.title == "Traducción existente"
    assert translation.content == "Contenido existente"
    page.refresh_from_db()
    assert page.title == "English title"
    assert page.content == "English body"


@pytest.mark.django_db
def test_unknown_source_canonical_update_needs_no_translation_header(
    creator_factory,
):
    creator = creator_factory()
    page = make_page(creator, source_language="und")
    client = APIClient()
    client.force_authenticate(creator)

    response = client.put(
        endpoint(page),
        {
            "title": "Updated canonical title",
            "content": "Updated canonical body",
            "tags": [],
        },
        format="json",
    )

    assert response.status_code == 200
    page.refresh_from_db()
    assert page.source_language == "und"
    assert page.title == "Updated canonical title"
    assert page.content == "Updated canonical body"
    assert not page.translations.exists()


@pytest.mark.django_db
def test_owner_first_language_edit_preserves_legacy_canonical(creator_factory):
    creator = creator_factory()
    page = make_page(creator, source_language="und")
    client = APIClient()
    client.force_authenticate(creator)

    response = client.put(
        translation_endpoint(page, "es"),
        {
            "title": "Título existente",
            "content": "Contenido existente",
            "is_published": True,
            "tags": [],
        },
        format="json",
        HTTP_X_FREE2Z_SOURCE_LANGUAGE="und",
    )

    assert response.status_code == 200
    page.refresh_from_db()
    assert page.source_language == "und"
    assert page.title == "English title"
    assert page.content == "English body"
    translation = page.translations.get(language="es")
    assert translation.title == "Título existente"
    assert translation.content == "Contenido existente"
    assert response.data["actual_language"] == "es"
    assert response.data["fallback_used"] is False


@pytest.mark.django_db
def test_draft_translation_is_private_and_owner_can_edit_it(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="Brouillon", content="Secret",
        is_published=False,
    )
    anonymous = APIClient().get(endpoint(page), {"lang": "fr"})

    owner_client = APIClient()
    owner_client.force_authenticate(creator)
    owner = owner_client.get(
        endpoint(page), {"lang": "fr", "mine": "true"}
    )

    assert anonymous.data["content"] == "English body"
    assert "fr" not in anonymous.data["available_languages"]
    assert owner.data["content"] == "Secret"
    assert owner.data["variant_is_published"] is False
    assert "fr" in owner.data["available_languages"]


@pytest.mark.django_db
def test_owner_creates_and_updates_translation_without_changing_canonical(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    client = APIClient()
    client.force_authenticate(creator)

    response = client.put(translation_endpoint(page, "pt"), {
        "title": "Título brasileiro",
        "content": "Conteúdo",
        "description": "Resumo",
        "is_published": True,
        "is_subscriber_only": False,
        "category": "",
        "tags": [],
        "vanity": "",
        "p2paddr": "",
        "publish_at": None,
    }, format="json")

    assert response.status_code == 200
    assert response.data["actual_language"] == "pt-BR"
    translation = page.translations.get(language="pt-BR")
    assert translation.title == "Título brasileiro"
    page.refresh_from_db()
    assert page.title == "English title"
    assert page.is_published is True


@pytest.mark.django_db
def test_non_owner_cannot_update_translation(creator_factory):
    owner = creator_factory()
    non_owner = creator_factory()
    page = make_page(owner, vanity="owner-canonical")
    ZPageTranslation.objects.create(
        zpage=page,
        language="fr",
        title="Titre du propriétaire",
        description="Résumé du propriétaire",
        content="Contenu du propriétaire",
        is_published=True,
    )
    page_before = zPage.objects.filter(pk=page.pk).values().get()
    translations_before = list(
        ZPageTranslation.objects.filter(zpage=page).values()
    )

    client = APIClient()
    client.force_authenticate(non_owner)
    response = client.put(translation_endpoint(page, "fr"), {
        "title": "Attacker title",
        "description": "Attacker description",
        "content": "Attacker content",
        "is_published": False,
        "is_subscriber_only": True,
        "vanity": "attacker-canonical",
        "tags": [],
    }, format="json")

    assert response.status_code == 404
    assert zPage.objects.filter(pk=page.pk).values().get() == page_before
    assert list(
        ZPageTranslation.objects.filter(zpage=page).values()
    ) == translations_before


@pytest.mark.django_db
def test_translation_save_cannot_mutate_canonical_schedule(creator_factory):
    creator = creator_factory()
    original_schedule = timezone.now() + timedelta(days=2)
    page = make_page(creator, publish_at=original_schedule)
    client = APIClient()
    client.force_authenticate(creator)

    response = client.put(translation_endpoint(page, "es"), {
        "title": "Título",
        "content": "Contenido",
        "is_published": False,
        "publish_at": (timezone.now() + timedelta(days=7)).isoformat(),
        "tags": [],
    }, format="json")

    assert response.status_code == 200
    page.refresh_from_db()
    assert page.publish_at == original_schedule
    assert page.translations.get(language="es").is_published is False


@pytest.mark.django_db
def test_translation_save_enqueues_one_search_reindex(
    creator_factory, monkeypatch, django_capture_on_commit_callbacks
):
    creator = creator_factory()
    page = make_page(creator)
    client = APIClient()
    client.force_authenticate(creator)
    enqueued = []
    scheduled = []

    class ConfiguredIndex:
        def defer(self, **kwargs):
            enqueued.append(kwargs)

    monkeypatch.setattr(
        "dj.apps.g12f.signals.index_multilingual_zpage.configure",
        lambda **kwargs: scheduled.append(kwargs) or ConfiguredIndex(),
    )
    _defer_through_fake(monkeypatch)

    with django_capture_on_commit_callbacks(execute=True):
        response = client.put(translation_endpoint(page, "fr"), {
            "title": "Titre",
            "content": "Contenu",
            "is_published": True,
            "tags": [],
        }, format="json")

    assert response.status_code == 200
    assert enqueued == [{"zpage_id": page.pk}]
    assert scheduled[0]["schedule_at"] > timezone.now()
    assert scheduled[0]["queueing_lock"] == f"multilingual-zpage-{page.pk}"


@pytest.mark.django_db
def test_translation_save_is_atomic_if_variant_write_fails(
    creator_factory, monkeypatch
):
    creator = creator_factory()
    page = make_page(creator, is_subscriber_only=True, vanity="stable-url")
    client = APIClient()
    client.force_authenticate(creator)

    def fail_variant_write(**kwargs):
        raise DatabaseError("injected translation write failure")

    monkeypatch.setattr(
        ZPageTranslation.objects, "update_or_create", fail_variant_write
    )

    with pytest.raises(DatabaseError):
        client.put(translation_endpoint(page, "es"), {
            "title": "Título",
            "content": "Contenido",
            "is_published": True,
            "is_subscriber_only": False,
            "vanity": "changed-url",
            "tags": [],
        }, format="json")

    page.refresh_from_db()
    assert page.is_subscriber_only is True
    assert page.vanity == "stable-url"
    assert not page.translations.exists()


@pytest.mark.django_db
def test_translation_autosaves_coalesce_pending_search_work(
    creator_factory, monkeypatch, django_capture_on_commit_callbacks
):
    from procrastinate.exceptions import AlreadyEnqueued

    creator = creator_factory()
    page = make_page(creator)
    client = APIClient()
    client.force_authenticate(creator)
    deferred = []

    class ConfiguredIndex:
        def defer(self, **kwargs):
            if deferred:
                raise AlreadyEnqueued()
            deferred.append(kwargs)

    monkeypatch.setattr(
        "dj.apps.g12f.signals.index_multilingual_zpage.configure",
        lambda **kwargs: ConfiguredIndex(),
    )
    _defer_through_fake(monkeypatch)

    for title in ("Primero", "Último"):
        with django_capture_on_commit_callbacks(execute=True):
            response = client.put(translation_endpoint(page, "es"), {
                "title": title,
                "content": "Contenido",
                "is_published": True,
                "tags": [],
            }, format="json")
        assert response.status_code == 200

    assert deferred == [{"zpage_id": page.pk}]
    assert page.translations.get(language="es").title == "Último"


@pytest.mark.django_db
def test_draft_translation_save_does_not_notify_fans(
    creator_factory, monkeypatch
):
    from dj.apps.g12f.views.zpage import zPageView

    creator = creator_factory()
    page = make_page(creator, vanity="published-source")
    client = APIClient()
    client.force_authenticate(creator)
    notifications = []
    monkeypatch.setattr(
        zPageView,
        "publish_page",
        lambda self, instance: notifications.append(instance.pk),
    )

    response = client.put(translation_endpoint(page, "fr"), {
        "title": "Brouillon",
        "content": "Contenu privé",
        "is_published": False,
        "tags": [],
    }, format="json")

    assert response.status_code == 200
    assert response.data["variant_is_published"] is False
    assert notifications == []


@pytest.mark.django_db
def test_draft_translation_autosave_does_not_reindex_or_bump_canonical(
    creator_factory, monkeypatch, django_capture_on_commit_callbacks
):
    creator = creator_factory()
    page = make_page(creator, vanity="stable-canonical")
    original_updated_at = page.updated_at
    client = APIClient()
    client.force_authenticate(creator)
    enqueued = []
    monkeypatch.setattr(
        "dj.apps.g12f.signals.index_multilingual_zpage.configure",
        lambda **kwargs: pytest.fail("draft translation scheduled indexing"),
    )

    with django_capture_on_commit_callbacks(execute=True):
        response = client.put(translation_endpoint(page, "fr"), {
            "title": "Brouillon",
            "content": "Contenu privé",
            "is_published": False,
            "tags": [],
        }, format="json")

    assert response.status_code == 200
    page.refresh_from_db()
    assert page.updated_at == original_updated_at
    assert enqueued == []


@pytest.mark.django_db
def test_translation_searchable_changes_refresh_parent_freshness(creator_factory):
    """Published translation blocks participate in the page's search age."""
    page = make_page(creator_factory())

    def age_parent_search_content():
        old = timezone.now() - timedelta(days=365)
        zPage.objects.filter(pk=page.pk).update(
            searchable_content_updated_at=old,
        )
        page.refresh_from_db()
        return old

    # Draft work is not in the semantic document, including a draft metadata
    # save and a draft title/body edit.
    old = age_parent_search_content()
    translation = ZPageTranslation.objects.create(
        zpage=page,
        language="fr",
        title="Brouillon",
        content="Contenu privé",
        is_published=False,
    )
    page.refresh_from_db()
    assert page.searchable_content_updated_at == old

    translation.description = "Résumé privé"
    translation.save(update_fields=["description"])
    translation.title = "Brouillon révisé"
    translation.content = "Contenu privé révisé"
    translation.save(update_fields=["title", "content"])
    page.refresh_from_db()
    assert page.searchable_content_updated_at == old

    # Publishing the existing text adds it to the embedding even when the
    # publish request does not change its title or body.
    translation.is_published = True
    translation.save(update_fields=["is_published"])
    page.refresh_from_db()
    assert page.searchable_content_updated_at > old

    # Once published, only searchable fields refresh the parent; metadata does
    # not get to manufacture a freshness boost.
    old = age_parent_search_content()
    translation.description = "Résumé public"
    translation.save(update_fields=["description"])
    page.refresh_from_db()
    assert page.searchable_content_updated_at == old

    translation.title = "Titre public révisé"
    translation.save(update_fields=["title"])
    page.refresh_from_db()
    assert page.searchable_content_updated_at > old

    old = age_parent_search_content()
    translation.content = "Contenu public révisé"
    translation.save(update_fields=["content"])
    page.refresh_from_db()
    assert page.searchable_content_updated_at > old

    old = age_parent_search_content()
    translation.is_published = False
    translation.save(update_fields=["is_published"])
    page.refresh_from_db()
    assert page.searchable_content_updated_at > old

    # A published create and a published delete are also content entering and
    # leaving the semantic embedding, respectively.
    old = age_parent_search_content()
    published = ZPageTranslation.objects.create(
        zpage=page,
        language="es",
        title="Título publicado",
        content="Contenido publicado",
        is_published=True,
    )
    page.refresh_from_db()
    assert page.searchable_content_updated_at > old

    old = age_parent_search_content()
    published.delete()
    page.refresh_from_db()
    assert page.searchable_content_updated_at > old


@pytest.mark.django_db
def test_translation_freshness_uses_persisted_publication_state(
    creator_factory,
):
    page = make_page(creator_factory())
    published = ZPageTranslation.objects.create(
        zpage=page,
        language="fr",
        title="Publié",
        content="Contenu public",
        is_published=True,
    )

    old = timezone.now() - timedelta(days=365)
    zPage.objects.filter(pk=page.pk).update(
        searchable_content_updated_at=old,
    )
    # Simulate a stale editor instance: publication remains persisted, but it
    # is omitted from this targeted title UPDATE and must not hide the fact
    # that the new title is searchable.
    published.is_published = False
    published.title = "Titre public révisé"
    published.save(update_fields=["title"])
    page.refresh_from_db()
    assert page.searchable_content_updated_at > old

    draft = ZPageTranslation.objects.create(
        zpage=page,
        language="es",
        title="Borrador",
        content="Contenido privado",
        is_published=False,
    )
    old = timezone.now() - timedelta(days=365)
    zPage.objects.filter(pk=page.pk).update(
        searchable_content_updated_at=old,
    )
    # The inverse stale value must not make a draft edit look searchable.
    draft.is_published = True
    draft.title = "Borrador revisado"
    draft.save(update_fields=["title"])
    page.refresh_from_db()
    assert page.searchable_content_updated_at == old


@pytest.mark.django_db
def test_deleting_stale_draft_translation_refreshes_parent_freshness(
    creator_factory,
):
    page = make_page(creator_factory())
    stale_draft = ZPageTranslation.objects.create(
        zpage=page,
        language="fr",
        title="Borrador",
        content="Contenido privado",
        is_published=False,
    )

    # The instance remains a draft while another writer publishes its row.
    ZPageTranslation.objects.filter(pk=stale_draft.pk).update(
        is_published=True,
    )
    old = timezone.now() - timedelta(days=365)
    zPage.objects.filter(pk=page.pk).update(
        searchable_content_updated_at=old,
    )

    stale_draft.delete()

    page.refresh_from_db()
    assert page.searchable_content_updated_at > old


@pytest.mark.django_db
def test_unpublishing_translation_schedules_search_cleanup(
    creator_factory, monkeypatch, django_capture_on_commit_callbacks
):
    creator = creator_factory()
    page = make_page(creator)
    translation = ZPageTranslation.objects.create(
        zpage=page,
        language="fr",
        title="Publié",
        content="Contenu public",
        is_published=True,
    )
    client = APIClient()
    client.force_authenticate(creator)
    enqueued = []

    class ConfiguredIndex:
        def defer(self, **kwargs):
            enqueued.append(kwargs)

    monkeypatch.setattr(
        "dj.apps.g12f.signals.index_multilingual_zpage.configure",
        lambda **kwargs: ConfiguredIndex(),
    )
    _defer_through_fake(monkeypatch)

    with django_capture_on_commit_callbacks(execute=True):
        response = client.put(translation_endpoint(page, "fr"), {
            "title": translation.title,
            "content": translation.content,
            "is_published": False,
            "tags": [],
        }, format="json")

    assert response.status_code == 200
    assert enqueued == [{"zpage_id": page.pk}]


@pytest.mark.django_db
def test_series_uses_translation_excerpts_without_loading_bodies(creator_factory):
    creator = creator_factory()
    series = Series.objects.create(name="Long series", creator=creator)
    for number in range(4):
        page = make_page(
            creator,
            vanity=f"series-story-{number}",
            content="source " + ("x" * 10_000),
        )
        PageOrder.objects.create(series=series, page=page, order=number)
        ZPageTranslation.objects.create(
            zpage=page,
            language="es",
            title=f"Título {number}",
            content="translated " + ("y" * 10_000),
            is_published=True,
        )

    with CaptureQueriesContext(connection) as captured:
        response = APIClient().get(
            f"/api/g12f/zpage/{page.free2zaddr}/series/",
            {"lang": "es"},
        )

    assert response.status_code == 200
    assert len(response.data["pageorder_set"]) == 4
    sql = "\n".join(query["sql"] for query in captured.captured_queries)
    assert not re.search(
        r'SELECT\s+"g12f_zpagetranslation"\."content"\s+FROM',
        sql,
        re.IGNORECASE,
    )


@pytest.mark.django_db
def test_undetermined_is_response_only_source_language(creator_factory):
    creator = creator_factory(tuzis=1)
    page = make_page(creator, source_language="und")
    response = APIClient().get(endpoint(page))

    assert response.status_code == 200
    assert response.data["source_language"] == "und"

    client = APIClient()
    client.force_authenticate(creator)
    rejected = client.post("/api/zpage/", {
        "title": "Invalid source",
        "content": "Body",
        "source_language": "und",
        "tags": [],
    }, format="json")
    assert rejected.status_code == 400
    assert "source_language" in rejected.data


@pytest.mark.django_db
def test_regional_portuguese_is_a_real_language_now(creator_factory):
    """`pt-PT` used to 400. The registry (wired in  M1) accepts it.

    This test asserted the rejection, which was a symptom of the four-item
    enum: `pt-PT` is a language, we simply had no UI string for it. A read for
    a language this page does not have now resolves to the source with
    `fallback_used`, exactly like any other missing translation — the same
    outcome a Spanish reader gets on an English-only article.
    """
    page = make_page(creator_factory())
    response = APIClient().get(endpoint(page), {"lang": "pt-PT"})

    assert response.status_code == 200
    assert response.data["requested_language"] == "pt-PT"
    assert response.data["actual_language"] == "en"
    assert response.data["fallback_used"] is True


@pytest.mark.django_db
def test_a_tag_that_names_no_language_is_still_rejected(creator_factory):
    """Widening the accepted set is not the same as accepting anything.

    `zz` is well-formed BCP-47 and names nothing; `en-USA` is the shape
    `langcodes` is lenient about (it silently drops the unplaceable subtag and
    would otherwise store `en-usa` as a *separate* content language from `en`).
    Both must stay a client error on a read.
    """
    page = make_page(creator_factory())
    for bogus in ("zz", "en-USA", "English", "und"):
        response = APIClient().get(endpoint(page), {"lang": bogus})
        assert response.status_code == 400, bogus


@pytest.mark.django_db
def test_owner_can_delete_a_translation(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )
    client = APIClient()
    client.force_authenticate(creator)

    response = client.delete(translation_endpoint(page, "es"))

    assert response.status_code == 204
    assert not page.translations.filter(language="es").exists()
    page.refresh_from_db()
    assert page.title == "English title"
    assert page.content == "English body"


@pytest.mark.django_db
def test_delete_translation_normalizes_bare_portuguese(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="pt-BR", title="Título", content="Conteúdo",
        is_published=True,
    )
    client = APIClient()
    client.force_authenticate(creator)

    response = client.delete(translation_endpoint(page, "pt"))

    assert response.status_code == 204
    assert not page.translations.exists()


@pytest.mark.django_db
def test_non_owner_cannot_delete_a_translation(creator_factory):
    owner = creator_factory()
    non_owner = creator_factory()
    page = make_page(owner, vanity="owner-delete-canonical")
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="Titre", content="Contenu",
        is_published=True,
    )
    client = APIClient()
    client.force_authenticate(non_owner)

    response = client.delete(translation_endpoint(page, "fr"))

    assert response.status_code == 404
    assert page.translations.filter(language="fr").exists()


@pytest.mark.django_db
def test_anonymous_cannot_delete_a_translation(creator_factory):
    page = make_page(creator_factory(), vanity="anon-delete-canonical")
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="Titre", content="Contenu",
        is_published=True,
    )

    response = APIClient().delete(translation_endpoint(page, "fr"))

    assert response.status_code in (401, 403)
    assert page.translations.filter(language="fr").exists()


@pytest.mark.django_db
def test_source_language_is_not_deletable_as_a_translation(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    client = APIClient()
    client.force_authenticate(creator)

    response = client.delete(translation_endpoint(page, "en"))

    assert response.status_code == 400
    assert "language" in response.data
    page.refresh_from_db()
    assert page.title == "English title"
    assert page.content == "English body"


@pytest.mark.django_db
def test_deleting_a_missing_translation_is_404(creator_factory):
    creator = creator_factory()
    page = make_page(creator)
    client = APIClient()
    client.force_authenticate(creator)

    response = client.delete(translation_endpoint(page, "fr"))

    assert response.status_code == 404


@pytest.mark.django_db
def test_deleting_a_language_that_names_nothing_is_rejected(creator_factory):
    """`de` is a language now, so a `de` delete is a 404, not a 400.

    The rejection this test guards is still real, it just moved: an unparseable
    or non-language tag in the URL path is a client error before we ever look
    for a row.
    """
    creator = creator_factory()
    page = make_page(creator)
    client = APIClient()
    client.force_authenticate(creator)

    assert client.delete(translation_endpoint(page, "de")).status_code == 404
    for bogus in ("zz", "und", "en-USA"):
        response = client.delete(translation_endpoint(page, bogus))
        assert response.status_code == 400, bogus


@pytest.mark.django_db
def test_stale_editor_cannot_delete_a_legacy_translation(creator_factory):
    """The DELETE keeps the PUT's precondition: destructive, so fail closed."""
    creator = creator_factory()
    page = make_page(creator, source_language="und")
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )
    client = APIClient()
    client.force_authenticate(creator)

    stale = client.delete(translation_endpoint(page, "es"))

    assert stale.status_code == 409
    assert page.translations.filter(language="es").exists()

    fresh = client.delete(
        translation_endpoint(page, "es"),
        HTTP_X_FREE2Z_SOURCE_LANGUAGE="und",
    )

    assert fresh.status_code == 204
    assert not page.translations.exists()


@pytest.mark.django_db
def test_deleting_a_translation_schedules_search_cleanup(
    creator_factory, monkeypatch, django_capture_on_commit_callbacks
):
    creator = creator_factory()
    page = make_page(creator)
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="Publié", content="Contenu public",
        is_published=True,
    )
    client = APIClient()
    client.force_authenticate(creator)
    enqueued = []

    class ConfiguredIndex:
        def defer(self, **kwargs):
            enqueued.append(kwargs)

    monkeypatch.setattr(
        "dj.apps.g12f.signals.index_multilingual_zpage.configure",
        lambda **kwargs: ConfiguredIndex(),
    )
    _defer_through_fake(monkeypatch)

    with django_capture_on_commit_callbacks(execute=True):
        response = client.delete(translation_endpoint(page, "fr"))

    assert response.status_code == 204
    assert enqueued == [{"zpage_id": page.pk}]


@pytest.mark.django_db
def test_translation_language_is_unique_per_page(creator_factory):
    page = make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Uno", content="Uno"
    )
    with pytest.raises(IntegrityError), transaction.atomic():
        ZPageTranslation.objects.create(
            zpage=page, language="es", title="Dos", content="Dos"
        )


@pytest.mark.django_db
def test_paywall_redacts_requested_translation_content(creator_factory):
    page = make_page(
        creator_factory(), is_subscriber_only=True, vanity="premium-story"
    )
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título premium",
        description="Resumen", content="Secreto traducido", is_published=True,
    )

    response = APIClient().get(endpoint(page), {"lang": "es"})

    assert response.status_code == 200
    assert response.data["show_modal"] is True
    assert response.data["page"]["content"] == "Subscribe for exclusive content"
    assert "Secreto traducido" not in str(response.data)

    listing = APIClient().get("/api/zpage/", {"lang": "es"})
    listed_page = next(
        item for item in listing.data["results"]
        if item["free2zaddr"] == page.free2zaddr
    )
    assert listed_page["content"] == "Subscribe for exclusive content"
    assert "Secreto traducido" not in str(listed_page)


@pytest.mark.django_db
def test_search_context_includes_only_published_translations(creator_factory):
    from dj.apps.search.helpers import get_zpage_context

    page = make_page(creator_factory())
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título indexado",
        content="Contenido indexado", is_published=True,
    )
    ZPageTranslation.objects.create(
        zpage=page, language="fr", title="Brouillon secret",
        content="Contenu secret", is_published=False,
    )

    context = get_zpage_context(page)

    assert "Título indexado" in context.content
    assert "Contenido indexado" in context.content
    assert "Brouillon secret" not in context.content


@pytest.mark.django_db
def test_localized_list_uses_excerpts_without_deferred_body_queries(creator_factory):
    creator = creator_factory()
    for number in range(4):
        page = make_page(
            creator,
            vanity=f"story-{number}",
            content="source " + ("x" * 10_000),
        )
        ZPageTranslation.objects.create(
            zpage=page,
            language="es",
            title=f"Título {number}",
            content="translated " + ("y" * 10_000),
            is_published=True,
        )

    with CaptureQueriesContext(connection) as captured:
        response = APIClient().get(
            "/api/zpage/",
            {"lang": "es", "page_size": 4, "ordering": "-created_at"},
        )

    assert response.status_code == 200
    assert [item["title"] for item in response.data["results"]] == [
        f"Título {number}" for number in reversed(range(4))
    ]
    sql = "\n".join(query["sql"] for query in captured.captured_queries)
    assert not re.search(
        r'SELECT\s+"g12f_zpage"\."content"\s+FROM', sql, re.IGNORECASE
    )
    assert not re.search(
        r'SELECT\s+"g12f_zpagetranslation"\."content"\s+FROM',
        sql,
        re.IGNORECASE,
    )


# --------------------------------------------------------------------------- #
# Registry wiring ( M1) — the enum is gone, the behaviour is not
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_available_languages_keeps_its_order_beyond_the_old_four(
    creator_factory,
):
    """The order is the same for en/es/fr/pt-BR, and total for anything else.

    `available_languages` used to be ordered by position in a four-item tuple,
    which cannot order a language that was not in it. It is sorted by tag now
    — which happens to be byte-for-byte the old order for those four, so no
    client sees a reshuffle — with a legacy `und` source still pinned first.
    """
    creator = creator_factory()
    page = make_page(creator)
    for language in ("pt-BR", "fr", "es", "ja", "de"):
        ZPageTranslation.objects.create(
            zpage=page, language=language, title=language,
            content="body", is_published=True,
        )

    data = APIClient().get(endpoint(page)).data
    assert data["available_languages"] == [
        "de", "en", "es", "fr", "ja", "pt-BR",
    ]


@pytest.mark.django_db
def test_a_legacy_page_still_pins_und_first(creator_factory):
    """The `und` carve-out survives untouched: M7 removes it, not this wave."""
    creator = creator_factory()
    page = make_page(creator, source_language="und")
    ZPageTranslation.objects.create(
        zpage=page, language="es", title="Título", content="Contenido",
        is_published=True,
    )

    data = APIClient().get(endpoint(page)).data
    assert data["available_languages"] == ["und", "es"]
    assert data["source_language"] == "und"
    # A legacy source is not a "fallback": 's carve-out is preserved.
    assert data["fallback_used"] is False


@pytest.mark.django_db
def test_a_creator_can_write_and_translate_in_any_real_language(
    creator_factory,
):
    """German was not a content language before. It is one now."""
    creator = creator_factory(tuzis=5)
    client = APIClient()
    client.force_authenticate(creator)

    created = client.post("/api/zpage/", {
        "title": "Ein Titel",
        "content": "Ein deutscher Artikel.",
        "source_language": "de",
        "is_published": True,
        "tags": [],
    }, format="json")
    assert created.status_code == 201
    assert created.data["source_language"] == "de"

    page = zPage.objects.get(free2zaddr=created.data["free2zaddr"])
    translated = client.put(translation_endpoint(page, "ja"), {
        "title": "日本語のタイトル",
        "content": "日本語の本文",
        "is_published": True,
        "tags": [],
    }, format="json")
    assert translated.status_code == 200

    read = APIClient().get(endpoint(page), {"lang": "ja"})
    assert read.status_code == 200
    assert read.data["actual_language"] == "ja"
    assert read.data["fallback_used"] is False


@pytest.mark.django_db
def test_bare_portuguese_still_normalizes_to_brazilian(creator_factory):
    """The one product override the registry keeps (localization.py:41-42)."""
    creator = creator_factory(tuzis=5)
    client = APIClient()
    client.force_authenticate(creator)

    created = client.post("/api/zpage/", {
        "title": "Um título",
        "content": "Um artigo.",
        "source_language": "pt",
        "tags": [],
    }, format="json")

    assert created.status_code == 201
    assert created.data["source_language"] == "pt-BR"
