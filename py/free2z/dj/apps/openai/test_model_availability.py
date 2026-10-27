"""Per-model availability flag — ``AIModel.is_enabled``.

The owner flagged the Kimi / Moonshot models off: their binding OpenPlatform
ToS (2026-07-30) permits using Customer Content to improve the Services, with
no published retention period and no zero-data-retention option. This module
pins the three properties that decision has to have, plus the one it must not:

1. a disabled model is absent from every list of selectable models;
2. naming one explicitly is rejected **server-side** — a client-side filter is
   not a control;
3. a conversation that already references one still reads back in full;
4. and none of the above is a Kimi special case — the mechanism is a flag, and
   these tests exercise it on synthetic rows.

Real Postgres — the DB is never mocked (project rule).
"""
from unittest import mock

import pytest

from f2z.ai import providers

from dj.apps.openai.models import AIModel, Conversation, PromptResponse


MODELS_URL = "/api/ai/models/"
CONVERSATIONS_URL = "/api/ai/conversations/"
FORK_URL = "/api/ai/conversations/fork/"


def _make_model(*, model, enabled=True, is_ga=True, **kwargs):
    return AIModel.objects.create(
        provider=kwargs.pop("provider", "openai"),
        model=model,
        display_name=kwargs.pop("display_name", model.upper()),
        system_message="be helpful",
        max_tokens=4096,
        max_output_tokens=1024,
        is_ga=is_ga,
        is_enabled=enabled,
        # Above every seeded row (gpt-4o is 200): the public list is paginated
        # (PAGE_SIZE 12) and ordered by -order, and these rows must be on the
        # first page the tests read.
        order=kwargs.pop("order", 1000),
        **kwargs,
    )


@pytest.fixture
def live_model(db, settings):
    # "Live" includes callable: the catalogue only lists rows
    # whose provider has a key, and the test environment sets none.
    settings.OPENAI_API_KEY = "sk-test-live-model"
    return _make_model(model="live-test-model")


@pytest.fixture
def disabled_model(db):
    """A GA row that policy has switched off.

    ``is_ga=True`` on purpose: the point is that ``is_enabled`` overrides the
    lineup flag rather than duplicating it. A row that is off for BOTH reasons
    would not tell us which one did the work.
    """
    return _make_model(model="flagged-off-model", enabled=False)


@pytest.fixture
def user(creator_factory):
    return creator_factory(username="availability-user")


def _conversation(user, ai_model, n=2):
    conversation = Conversation.objects.create(
        ai_model=ai_model,
        user=user,
        display_name="chat on a model that later went away",
    )
    for i in range(n):
        pr = PromptResponse.objects.create(
            ai_model=ai_model,
            user=user,
            user_input=f"question {i}",
            response=f"answer {i}",
        )
        conversation.prompt_response_set.add(pr)
    return conversation


# --------------------------------------------------------------------------
# 1. Absent from the catalogue
# --------------------------------------------------------------------------
@pytest.mark.django_db
def test_a_disabled_model_is_not_in_the_public_catalogue(
    api_client, live_model, disabled_model
):
    resp = api_client.get(MODELS_URL)

    assert resp.status_code == 200
    ids = {row["id"] for row in resp.data["results"]}
    assert str(live_model.id) in ids
    assert str(disabled_model.id) not in ids


@pytest.mark.django_db
def test_a_disabled_model_cannot_be_retrieved_by_id(api_client, disabled_model):
    """Not just filtered out of the list — its price card is not published."""
    resp = api_client.get(f"{MODELS_URL}{disabled_model.id}/")

    assert resp.status_code == 404


@pytest.mark.django_db
def test_the_seeded_kimi_rows_are_flagged_off(db):
    """The concrete decision, not just the mechanism.

    Migration ``0018`` matches on the PROVIDER, so this asserts on the
    provider rather than on the two model ids — a ``kimi-k4`` added later must
    also be off.
    """
    kimi = AIModel.objects.filter(provider="kimi")

    assert kimi.exists(), "the seeded lineup should still contain the Kimi rows"
    assert not kimi.filter(is_enabled=True).exists()
    # `is_ga` off too, so code that predates `is_enabled` -- old pods mid-roll,
    # or a health-check rollback that reverts the image but not the migration
    # -- also keeps them out of the picker.
    assert not kimi.filter(is_ga=True).exists()
    # Disabled, NOT deleted: the rows keep their prices and caps, so
    # re-enabling is two booleans and the model returns exactly as it was.
    assert kimi.filter(
        model="kimi-k3", max_output_tokens=8192, input_price="0.000003"
    ).exists()  # Moonshot's list price since rate card v3


def test_the_migration_is_survivable_by_a_pod_on_the_old_image():
    """0019 must be safe for a pod that has never heard of ``is_enabled``.

    Cloud Build runs ``manage.py migrate`` BEFORE the new pods roll, and
    ``prod-healthcheck.sh`` rolls the image back without reversing the data.
    So 0019 may only ADD a column the old image never selects, and its data
    function may only write columns whose new value the old image handles
    correctly:

    * ``is_enabled`` -- the old image does not select it at all.
    * ``is_ga`` -- the old image DOES select it, and ``False`` is precisely
      what makes the change work there: it is what keeps Kimi out of the
      picker during the roll and after a rollback. That is why the data
      function writes both.

    Mirrors ``test_the_migration_is_add_only_so_a_rolling_deploy_is_safe`` in
    test_spend_ceiling.py, which pins the same property for 0018.
    """
    import importlib

    from django.db import migrations as dj_migrations

    m19 = importlib.import_module(
        "dj.apps.openai.migrations.0019_aimodel_is_enabled")

    for op in m19.Migration.operations:
        assert not isinstance(
            op, (dj_migrations.RenameField, dj_migrations.RemoveField)
        ), f"{type(op).__name__} is not survivable by a pod on the old image"
        if isinstance(op, dj_migrations.AddField):
            assert op.name == "is_enabled"
        if isinstance(op, dj_migrations.AlterField):
            # help_text only -- no DDL that changes a column's meaning.
            assert op.name in ("is_ga",)

    writes = []

    class _Manager:
        def filter(self, **kwargs):
            return self

        def update(self, **kwargs):
            writes.append(set(kwargs))
            return 0

    class _Model:
        objects = _Manager()

    class _Apps:
        def get_model(self, *args, **kwargs):
            return _Model

    m19.disable_flagged_providers(_Apps(), None)

    assert writes, "the data migration wrote nothing at all"
    for written in writes:
        assert written == {"is_enabled", "is_ga"}, written


@pytest.mark.django_db
def test_an_operator_cannot_create_an_enabled_row_for_a_banned_provider(
    api_client,
):
    """The admin/manual-create path, which no migration can reach.

    A data migration is one-shot: a `kimi-k4` added in the Django admin next
    month would take the column default (`True`) and publish a model of a
    vendor whose terms we refused. `AIModel.save` enforces the policy list on
    every write instead. Found by the codex adversarial review.
    """
    row = AIModel.objects.create(
        provider="kimi",
        model="kimi-k4",
        display_name="Kimi K4",
        system_message="",
        max_tokens=4096,
        is_ga=True,
        is_enabled=True,
    )

    row.refresh_from_db()
    assert row.is_enabled is False

    catalogue = api_client.get(MODELS_URL)
    assert str(row.id) not in {m["id"] for m in catalogue.data["results"]}


@pytest.mark.django_db
def test_re_enabling_a_banned_provider_row_does_not_stick():
    """Not overridable from the admin -- lifting a ToS call is a code change."""
    row = AIModel.objects.filter(provider="kimi").first()
    assert row is not None

    row.is_enabled = True
    row.save(update_fields=["is_enabled"])

    row.refresh_from_db()
    assert row.is_enabled is False


@pytest.mark.django_db
def test_every_other_seeded_provider_is_still_enabled(db):
    """The flag is a scalpel: nothing else moved."""
    others = AIModel.objects.exclude(provider="kimi").filter(is_ga=True)

    assert others.exists()
    assert not others.filter(is_enabled=False).exists()


@pytest.mark.django_db
def test_reseeding_does_not_re_enable_an_operator_disabled_model():
    """A kill switch a routine reseed flips back on is not a kill switch.

    ``seed_ai_models`` is catalogue maintenance and gets run to reprice or add
    models. If it also reset ``is_enabled``, an operator who pulled a model
    during a vendor incident would find it back in the public picker at the
    next run, silently. Found by the codex adversarial review.
    """
    from django.core.management import call_command

    row = AIModel.objects.filter(provider="openai", model="gpt-4o").first()
    assert row is not None, "the seeded lineup should contain gpt-4o"
    row.is_enabled = False
    row.save(update_fields=["is_enabled"])

    call_command("seed_ai_models", verbosity=0)

    row.refresh_from_db()
    assert row.is_enabled is False


@pytest.mark.django_db
def test_reseeding_keeps_a_flagged_off_provider_off():
    """The other direction IS enforced every run -- it only removes access."""
    from django.core.management import call_command

    AIModel.objects.filter(provider="kimi").update(is_enabled=True)

    call_command("seed_ai_models", verbosity=0)

    assert not AIModel.objects.filter(provider="kimi", is_enabled=True).exists()


@pytest.mark.django_db
def test_lifting_the_ban_restores_the_lineup_and_unblocks_re_enabling():
    """Pin the WHOLE restoration path, including the part that is manual.

    Lifting a ToS ban is two steps, and this test exists because the first
    looks like the whole thing:

    1. Remove the entry from `POLICY_DISABLED_PROVIDERS` and deploy. A reseed
       then restores `is_ga`, because it is DERIVED from the policy list
       rather than hardcoded in LINEUP. (Hardcoding `is_ga=False` would have
       restored translation -- which keys off `is_enabled` -- while leaving
       chat silently missing, and any manual admin fix would be undone by the
       next seed run. Found by the codex adversarial review.)
    2. Turn `is_enabled` back on, per row. The seeder deliberately does NOT do
       this: it writes `is_enabled` on CREATE only, so that a routine reseed
       can never clear an operator's own kill switch. The price of that rule
       is that it cannot clear a *policy* one either. Step 1 is what unblocks
       it -- while the provider is banned, `AIModel.save` forces the flag
       straight back off.

    Two steps is the right shape: bringing a refused vendor back should be a
    deliberate act, not a side effect of running catalogue maintenance.
    """
    from django.core.management import call_command

    from dj.apps.openai.management.commands import seed_ai_models

    assert not AIModel.objects.filter(provider="kimi", is_ga=True).exists()

    # Lift the ban exactly as a future PR would: remove the entry.
    lifted = {
        k: v for k, v in providers.POLICY_DISABLED_PROVIDERS.items()
        if k != "kimi"
    }
    with mock.patch.dict(
        providers.POLICY_DISABLED_PROVIDERS, lifted, clear=True
    ), mock.patch.object(seed_ai_models, "DISABLED_PROVIDERS", lifted):
        call_command("seed_ai_models", verbosity=0)

        kimi = AIModel.objects.filter(provider="kimi")
        # Step 1 restored the lineup...
        assert kimi.filter(is_ga=True).count() == 2
        #...and left the kill switch alone, which is the rule working.
        assert kimi.filter(is_enabled=True).count() == 0

        # Step 2 now sticks, because save() no longer forces it off.
        for row in kimi:
            row.is_enabled = True
            row.save(update_fields=["is_enabled"])
        assert AIModel.objects.filter(
            provider="kimi", is_enabled=True).count() == 2

    # And with the ban back in place, the same edit does NOT stick.
    row = AIModel.objects.filter(provider="kimi").first()
    row.is_enabled = True
    row.save(update_fields=["is_enabled"])
    row.refresh_from_db()
    assert row.is_enabled is False


@pytest.mark.django_db
def test_seeding_a_flagged_off_provider_from_scratch_creates_it_disabled():
    """The CREATE path, which the update-path tests above never reach.

    `create_defaults` replaces `defaults` rather than merging into it, so a
    fresh database is the case where getting that wrong would ship Kimi
    enabled — and it is the case CI's own database always starts from.
    """
    from django.core.management import call_command

    AIModel.objects.filter(provider="kimi").delete()

    call_command("seed_ai_models", verbosity=0)

    kimi = AIModel.objects.filter(provider="kimi")
    assert kimi.count() == 2
    assert not kimi.filter(is_enabled=True).exists()
    #...and the rest of the row still came through, i.e. the merge happened.
    assert kimi.filter(display_name="Kimi K3", max_output_tokens=8192).exists()


# --------------------------------------------------------------------------
# 2. Rejected server-side when named explicitly
# --------------------------------------------------------------------------
@pytest.mark.django_db
def test_starting_a_conversation_on_a_disabled_model_is_rejected(
    api_client, user, disabled_model
):
    api_client.force_authenticate(user=user)

    resp = api_client.post(
        CONVERSATIONS_URL,
        {"display_name": "sneaking one in", "ai_model": str(disabled_model.id)},
        format="json",
    )

    assert resp.status_code == 409, resp.status_code
    assert disabled_model.display_name in resp.data["detail"]
    assert not Conversation.objects.filter(ai_model=disabled_model).exists()


@pytest.mark.django_db
def test_starting_a_conversation_on_a_live_model_still_works(
    api_client, user, live_model
):
    """The guard rejects the disabled row and nothing else."""
    api_client.force_authenticate(user=user)

    resp = api_client.post(
        CONVERSATIONS_URL,
        {"display_name": "normal chat", "ai_model": str(live_model.id)},
        format="json",
    )

    assert resp.status_code == 200, resp.data
    assert Conversation.objects.filter(ai_model=live_model).count() == 1


@pytest.mark.django_db
def test_a_malformed_ai_model_id_is_a_400_not_a_500(api_client, user):
    """``id`` is a UUIDField; ``.get()`` on junk used to raise out of the ORM."""
    api_client.force_authenticate(user=user)

    resp = api_client.post(
        CONVERSATIONS_URL,
        {"display_name": "junk", "ai_model": "not-a-uuid"},
        format="json",
    )

    assert resp.status_code == 400, resp.status_code


@pytest.mark.django_db
def test_patching_a_conversation_onto_a_disabled_model_is_rejected(
    api_client, user, live_model, disabled_model
):
    """The other write path — it goes through the serializer, not `create`."""
    conversation = _conversation(user, live_model, n=0)
    api_client.force_authenticate(user=user)

    resp = api_client.patch(
        f"{CONVERSATIONS_URL}{conversation.id}/",
        {"ai_model": str(disabled_model.id)},
        format="json",
    )

    assert resp.status_code == 400, resp.status_code
    conversation.refresh_from_db()
    assert conversation.ai_model_id == live_model.id


@pytest.mark.django_db
def test_continuing_a_conversation_on_a_disabled_model_fails_cleanly(
    api_client, user, disabled_model, monkeypatch
):
    """A model flagged off UNDER a live conversation.

    The FK still points at it, so this is the request that would otherwise
    have shipped the whole transcript to the refused vendor. It must answer
    cleanly, charge nothing, write nothing, and never reach the provider.
    """
    conversation = _conversation(user, disabled_model)
    before = user.tuzis

    def _boom(*args, **kwargs):
        raise AssertionError("the provider must not be called for a disabled model")

    monkeypatch.setattr(providers, "stream_chat", _boom)

    api_client.force_authenticate(user=user)
    resp = api_client.post(
        f"{CONVERSATIONS_URL}{conversation.id}/promptresponses/",
        {"user_input": "still there?"},
        format="json",
    )

    assert resp.status_code == 409, resp.status_code
    assert disabled_model.display_name in resp.data["detail"]
    user.refresh_from_db()
    assert user.tuzis == before
    assert conversation.prompt_response_set.count() == 2


@pytest.mark.django_db
def test_forking_a_conversation_on_a_disabled_model_is_rejected(
    api_client, user, disabled_model
):
    """A fork copies the model, so it would mint an unusable conversation."""
    conversation = _conversation(user, disabled_model)
    pr = conversation.prompt_response_set.first()
    api_client.force_authenticate(user=user)

    resp = api_client.post(
        FORK_URL,
        {"conversation": str(conversation.id), "prompt_response": pr.id},
        format="json",
    )

    assert resp.status_code == 409, resp.status_code
    assert Conversation.objects.filter(user=user).count() == 1


@pytest.mark.django_db
def test_stream_chat_refuses_a_banned_provider_even_on_an_enabled_row():
    """The outbound boundary does not trust the row it was handed.

    `AIModel.save` forces a banned provider off, but `QuerySet.update()` and
    `bulk_create()` skip `save()` entirely -- a data migration or a psql
    session could re-open Kimi with no reviewed code change anywhere. The
    provider check reads the policy list, not the row, so it holds anyway (and
    is immune to a row loaded before an admin flip). Found by the codex
    adversarial review.
    """
    AIModel.objects.create(
        provider="kimi", model="kimi-sneaky", display_name="Sneaky",
        system_message="", max_tokens=4096, is_ga=True,
    )
    # Straight past save() -- exactly what the guard must survive.
    AIModel.objects.filter(model="kimi-sneaky").update(
        is_enabled=True, is_ga=True)
    row = AIModel.objects.get(model="kimi-sneaky")
    assert row.is_enabled is True, "the setup must really re-enable the row"

    with pytest.raises(providers.ModelDisabled):
        list(providers.stream_chat(row, [{"role": "user", "content": "hi"}]))


@pytest.mark.django_db
def test_a_bypassed_row_never_reaches_the_catalogue_or_admission(
    api_client, user
):
    """The same bypass, one layer earlier.

    `stream_chat` refusing is the content guarantee, but on its own it would
    leave a user holding a conversation that 503s on every prompt.
    `AIModelQuerySet.enabled()` excludes the provider as well as the column,
    so a row written past `save()` is never offered and never accepted. Found
    by the codex adversarial review.
    """
    AIModel.objects.create(
        provider="kimi", model="kimi-bypass", display_name="Bypass",
        system_message="", max_tokens=4096, is_ga=True,
    )
    AIModel.objects.filter(model="kimi-bypass").update(
        is_enabled=True, is_ga=True)
    row = AIModel.objects.get(model="kimi-bypass")

    catalogue = api_client.get(MODELS_URL)
    assert str(row.id) not in {m["id"] for m in catalogue.data["results"]}
    assert api_client.get(f"{MODELS_URL}{row.id}/").status_code == 404

    api_client.force_authenticate(user=user)
    created = api_client.post(
        CONVERSATIONS_URL,
        {"display_name": "nope", "ai_model": str(row.id)},
        format="json",
    )
    assert created.status_code == 409, created.status_code
    assert not Conversation.objects.filter(ai_model=row).exists()


@pytest.mark.django_db
def test_stream_chat_refuses_a_disabled_model(disabled_model):
    """The backstop: the one function that turns a row into an outbound call.

    Every caller filters already. This is what makes "we do not send content
    there" true for a path someone adds later and forgets to filter.
    """
    with pytest.raises(providers.ModelDisabled):
        list(providers.stream_chat(disabled_model, [{"role": "user", "content": "hi"}]))


# --------------------------------------------------------------------------
# 3. Existing conversations survive
# --------------------------------------------------------------------------
@pytest.mark.django_db
def test_an_existing_conversation_on_a_disabled_model_still_loads(
    api_client, user, disabled_model
):
    conversation = _conversation(user, disabled_model)
    api_client.force_authenticate(user=user)

    detail = api_client.get(f"{CONVERSATIONS_URL}{conversation.id}/")

    assert detail.status_code == 200
    assert len(detail.data["prompt_response_set"]) == 2
    assert detail.data["prompt_response_set"][0]["response"] == "answer 0"


@pytest.mark.django_db
def test_an_existing_conversation_on_a_disabled_model_is_still_listed(
    api_client, user, disabled_model
):
    conversation = _conversation(user, disabled_model)
    api_client.force_authenticate(user=user)

    listing = api_client.get(CONVERSATIONS_URL)

    assert listing.status_code == 200
    assert str(conversation.id) in {row["id"] for row in listing.data["results"]}


@pytest.mark.django_db
def test_a_public_conversation_on_a_disabled_model_is_still_readable(
    api_client, user, disabled_model
):
    """Published content stays published. Flagging a vendor off is not a
    retroactive unpublish of everything ever written with it."""
    conversation = _conversation(user, disabled_model)
    conversation.is_public = True
    conversation.save(update_fields=["is_public"])

    resp = api_client.get(f"/api/ai/public-conversations/{conversation.id}/")

    assert resp.status_code == 200
    assert len(resp.data["prompt_response_set"]) == 2


@pytest.mark.django_db
def test_the_transcript_endpoint_still_serves_a_disabled_model(
    api_client, user, disabled_model
):
    conversation = _conversation(user, disabled_model)
    api_client.force_authenticate(user=user)

    resp = api_client.get(
        f"{CONVERSATIONS_URL}{conversation.id}/promptresponses/"
    )

    assert resp.status_code == 200
    assert len(resp.data["results"]) == 2


# --------------------------------------------------------------------------
# 4. The silent, automatic paths — the ones a picker filter never covers
# --------------------------------------------------------------------------
@pytest.mark.django_db
def test_language_detection_never_picks_a_disabled_model(
    live_model, disabled_model, monkeypatch
):
    """Detection is automatic and always picks the CHEAPEST row.

    So a disabled row that is also the cheapest is the exact shape of the
    accident this guards: nobody chose it, and it would have been used on
    every zPage.
    """
    from f2z.ai import language

    disabled_model.input_price = "0.0000000001"
    disabled_model.output_price = "0.0000000001"
    disabled_model.save(update_fields=["input_price", "output_price"])
    # The live row must be among the cheapest callable rows to be chosen at
    # all (the seeded lineup now has sub-$0.10/M OpenAI models); price it
    # just above the disabled one so only the flag decides.
    live_model.input_price = "0.0000000002"
    live_model.output_price = "0.0000000002"
    live_model.save(update_fields=["input_price", "output_price"])

    monkeypatch.setattr(language, "get_client", lambda provider: object())

    chosen = language.callable_detection_models()

    assert disabled_model not in chosen
    assert live_model in chosen


@pytest.mark.django_db
def test_translation_falls_through_a_disabled_preference_entry(
    settings, live_model, disabled_model, monkeypatch
):
    """`select_translation_model` deliberately ignores `is_ga` — but not this.

    A settings list selects among models we are permitted to use; it cannot
    grant permission.
    """
    from dj.apps.g12f.translation import service

    monkeypatch.setattr(service, "get_client", lambda provider: object())
    settings.ZPAGE_TRANSLATION_MODELS = [
        f"{disabled_model.provider}:{disabled_model.model}",
        f"{live_model.provider}:{live_model.model}",
    ]

    assert service.select_translation_model().pk == live_model.pk
