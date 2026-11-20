"""Real PostgreSQL migration executor, historical fixtures, leaf restoration."""
from importlib import import_module
from io import StringIO
import uuid

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, connection
from django.db.migrations.executor import MigrationExecutor
from django.test import override_settings
from rest_framework.test import APIClient

from f2z.languages import normalize

migration = import_module("dj.apps.g12f.migrations.0122_canonicalize_yue_languages")
BEFORE = ("g12f", "0121_creator_deletion_schedule")
AFTER = ("g12f", "0122_canonicalize_yue_languages")


def migrate(target):
    executor = MigrationExecutor(connection)
    executor.migrate([target])
    return executor.loader.project_state([target]).apps


def restore_leaves():
    executor = MigrationExecutor(connection)
    executor.migrate(executor.loader.graph.leaf_nodes())


@pytest.fixture
def historical(transactional_db):
    reached_before = False
    try:
        assert connection.vendor == "postgresql"
        apps = migrate(BEFORE)
        reached_before = True
        yield apps
    finally:
        # Failed-collision fixtures must not block leaf restoration. Relabel
        # only test-created offending rows before the required finally migrate.
        if reached_before:
            apps = MigrationExecutor(connection).loader.project_state([BEFORE]).apps
            for name, field in migration.COLUMNS:
                model = apps.get_model("g12f", name)
                for pk, value in model.objects.values_list("pk", field):
                    if migration.canonical_yue(value) != value:
                        model.objects.filter(pk=pk).update(**{field: f"qaa-x-{pk}"})
        restore_leaves()


def page(apps, language="yue"):
    creator = apps.get_model("g12f", "Creator").objects.create(username=str(uuid.uuid4()))
    return apps.get_model("g12f", "zPage").objects.create(
        creator=creator, source_language=language, detected_language=language,
        free2zaddr=str(uuid.uuid4()), title="Original", content="original body",
        is_published=True, language_source="creator",
    )


def variant(apps, page, language, origin="human"):
    return apps.get_model("g12f", "ZPageVariant").objects.create(
        zpage=page, language=language, origin=origin,
        title="Variant", content=page.content if origin == "source" else "translated body",
        is_published=True,
        source_digest="a" * 64 if origin != "source" else None,
    )


def translation(apps, page, language):
    return apps.get_model("g12f", "ZPageTranslation").objects.create(
        zpage=page, language=language, title="Translation",
        content="translated body", is_published=True,
    )


def snapshot(apps):
    names = ("zPage", "ZPageTranslation", "ZPageVariant", "ZPageMutationActor")
    return {name: list(apps.get_model("g12f", name).objects.order_by("pk").values()) for name in names}


def expected_snapshot(before):
    result = {name: [dict(row) for row in rows] for name, rows in before.items()}
    for name, field in migration.COLUMNS:
        for row in result[name]:
            row[field] = migration.canonical_yue(row[field])
    return result


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("reads", [False, True])
@pytest.mark.parametrize("source", [False, True])
def test_migrate_preserves_identity_and_both_urls(historical, reads, source):
    apps = historical
    article = page(apps, "yue" if source else "en")
    variant(apps, article, article.source_language, "source")
    if not source:
        translation(apps, article, "yue")
        variant(apps, article, "yue", "ai")
    apps.get_model("g12f", "ZPageMutationActor").objects.create(
        zpage_id=article.pk, actor_id=article.creator_id,
        action="source_language", language="yue",
    )
    before = snapshot(apps)
    output = StringIO()
    call_command("plan_yue_language_migration", stdout=output)
    assert "'yue' -> 'yue-Hant'" in output.getvalue()
    assert snapshot(apps) == before  # dry-run never changes a field
    migrate(AFTER)
    assert snapshot(apps) == expected_snapshot(before)  # every other column unchanged
    with connection.schema_editor() as editor:
        migration.forwards(apps, editor)
    assert snapshot(apps) == expected_snapshot(before)
    # The URL views use current runtime models, not the historical apps used
    # above. Restore every leaf before exercising them, including the later
    # creator and ledger migrations; the fixture still restores on failure.
    restore_leaves()
    assert snapshot(apps) == expected_snapshot(before)
    with override_settings(ZPAGE_VARIANT_READS=reads):
        client = APIClient()
        for tag in ("yue", "yue-Hant"):
            response = client.get(f"/api/zpage/{article.free2zaddr}/variants/{tag}/")
            assert response.status_code == 200, response.data
            assert response.data["actual_language"] == "yue-Hant"
            assert response.data["content"] == ("original body" if source else "translated body")


@pytest.mark.django_db(transaction=True)
def test_leaf_restoration_preserves_consent_and_blocks_reverse(historical):
    article = page(historical, "yue")
    migrate(AFTER)
    restore_leaves()
    from dj.apps.g12f.models import Creator
    Creator.objects.filter(pk=article.creator_id).update(
        low_balance_notice_enabled=True, low_balance_notice_generation=1,
    )
    with pytest.raises(DatabaseError, match="low balance preference state exists"):
        migrate(BEFORE)
    # A failed reverse must not remove consent or leave the schema unusable.
    restore_leaves()
    creator = Creator.objects.get(pk=article.creator_id)
    assert creator.low_balance_notice_enabled
    assert creator.low_balance_notice_generation == 1
    executor = MigrationExecutor(connection)
    assert set(executor.loader.graph.leaf_nodes()) <= executor.loader.applied_migrations.keys()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("kind", ["variant", "translation", "source_translation", "alias_alias", "regional"])
def test_collisions_fail_before_any_updates(historical, kind):
    apps = historical
    # Unrelated pending source and detector updates must also stay untouched.
    page(apps)
    article = page(apps, "yue" if kind == "source_translation" else "en")
    if kind == "variant":
        variant(apps, article, "yue")
        variant(apps, article, "yue-Hant")
    elif kind == "translation":
        translation(apps, article, "yue")
        translation(apps, article, "yue-Hant")
    elif kind == "source_translation":
        translation(apps, article, "yue-Hant")
    elif kind == "alias_alias":
        variant(apps, article, "yue")
        variant(apps, article, "YUE-hant")
    else:
        variant(apps, article, "yue-hans-cn")
        variant(apps, article, "yue-Hans-CN")
    before = snapshot(apps)
    with pytest.raises(CommandError, match=f"page={article.pk}"):
        call_command("plan_yue_language_migration", stdout=StringIO())
    assert snapshot(apps) == before
    with pytest.raises(RuntimeError, match="no rows changed"):
        migrate(AFTER)
    assert snapshot(apps) == before
    assert AFTER not in MigrationExecutor(connection).loader.applied_migrations


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("source_language,variant_language", [
    ("yue", "yue-Hant"), ("yue-Hant", "yue"),
])
@pytest.mark.parametrize("origin", ["human", "ai"])
def test_source_non_source_variant_collision_without_mirror(
    historical, source_language, variant_language, origin,
):
    apps = historical
    page(apps)  # unrelated pending source/detector updates must not be applied
    article = page(apps, source_language)
    row = variant(apps, article, variant_language, origin)
    before = snapshot(apps)
    with pytest.raises(CommandError, match=f"ZPageVariant#{row.pk}"):
        call_command("plan_yue_language_migration", stdout=StringIO())
    assert snapshot(apps) == before
    with pytest.raises(RuntimeError, match=f"page={article.pk}"):
        migrate(AFTER)
    assert snapshot(apps) == before
    assert AFTER not in MigrationExecutor(connection).loader.applied_migrations


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("source_language,variant_language", [
    ("yue", "yue-Hant"), ("yue-Hant", "yue"),
])
def test_source_mirror_aliases_are_allowed(historical, source_language, variant_language):
    apps = historical
    article = page(apps, source_language)
    variant(apps, article, variant_language, "source")
    before = snapshot(apps)
    call_command("plan_yue_language_migration", stdout=StringIO())
    assert snapshot(apps) == before
    migrate(AFTER)
    assert snapshot(apps) == expected_snapshot(before)


@pytest.mark.django_db(transaction=True)
def test_noncanonical_forms_and_unchanged_labels(historical):
    apps = historical
    labels = ["YUE", "yue-hant", "yue-hans-cn", "yue-Hant-hk", "yue-hk",
              "yue-Hans", "yue-Hant", "yue-Latn", "yue-Hant-HK", "yue-invalid",
              "yue-x-test", "zh", "sr", "pt", "und", "qaa", "", None]
    for label in labels:
        page(apps, label)
        if label is not None:
            translated_article = page(apps, "en")
            translation(apps, translated_article, label)
            variant(apps, translated_article, label)
    before = snapshot(apps)
    migrate(AFTER)
    assert snapshot(apps) == expected_snapshot(before)
    for label in labels[:5]:
        assert migration.canonical_yue(label) == normalize(label)
    for label in labels[5:]:
        assert migration.canonical_yue(label) == label


@pytest.mark.django_db(transaction=True)
def test_empty_and_canonical_only_noop(historical):
    apps = historical
    migrate(AFTER)
    assert snapshot(apps) == {name: [] for name in snapshot(apps)}
    article = page(apps, "yue-Hant")
    variant(apps, article, "yue-Hant", "source")
    translation(apps, article, "zh")
    before = snapshot(apps)
    with connection.schema_editor() as editor:
        migration.forwards(apps, editor)
    assert snapshot(apps) == before
    output = StringIO()
    call_command("plan_yue_language_migration", stdout=output)
    assert "0 field updates; 0 collisions" in output.getvalue()


@pytest.mark.parametrize("tag", [
    "yue", "YUE", " yue ", "yue-hant", "yue-hans", "yue-hant-hk",
    "yue-hans-cn", "yue-hk", "yue-Latn", "yue-yue", "yue-1901",
    "yue-USA", "yue-XYZ", "yue-x-test", "yue-u-co-pinyin", "yue-bogus",
])
def test_frozen_migration_rules_match_current_registry(tag):
    from f2z.languages import LanguageError
    try:
        expected = normalize(tag, allow_missing=False)
    except LanguageError:
        expected = tag
    assert migration.canonical_yue(tag) == expected
