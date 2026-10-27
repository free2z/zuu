"""Per-model availability kill switch, and Kimi flagged off (#1041).

WHY A SECOND FLAG. ``is_ga`` already existed, but it answers a *product*
question — "is this row in the chat picker?" — and the codebase treats it that
way: ``select_translation_model`` deliberately ignores it, on the documented
grounds that translation is not the picker and an operator may want to serve
translations from a row they never exposed to chat. That is a reasonable rule
for a lineup flag and a dangerous one for a policy flag. ``is_enabled`` answers
the other question — "may free2z send any content to this provider at all?" —
and therefore gates *every* path, including the ones that bypass ``is_ga``.

WHY KIMI IS OFF. Moonshot's binding OpenPlatform ToS (updated 2026-07-30)
states that Customer Content may be used to improve the Services, publishes no
retention period, and offers no zero-data-retention option. Free2Z is
positioning its AI product on per-provider privacy disclosure, so the two Kimi
rows cannot stay silently in the catalogue. There is no Moonshot account
provisioned, so nothing is in flight and no user loses a model they were
already using.

DISABLED, NOT DELETED, on purpose. The rows keep their prices, caps and order;
every stored conversation that references them still resolves its FK and still
reads back in full. If the owner negotiates written terms, re-enabling is one
boolean in the Django admin and the model returns exactly as it was — which is
why this is a flag flip and not a ``DELETE``.

Defaults ``True`` so every other row (and any operator-added one) is unaffected
by the column landing.

DEPLOY-ORDER LIMIT, stated plainly. ``manage.py migrate`` runs BEFORE the new
image is serving, and ``prod-healthcheck.sh`` rolls the image back without
reversing data. Flipping ``is_ga`` as well (below) is what covers the paths old
code *does* gate on it -- the public catalogue and the chat picker -- but old
code has paths it does not gate at all: continuing an existing Kimi
conversation, and ``select_translation_model``, which ignores ``is_ga`` by
design. No data change can make a binary enforce a flag it has never heard of.

That window is only a *content* exposure if a Moonshot key exists, and the
premise of this change is that no Moonshot account is provisioned. The
operator action that closes it independently of deploy order, and the one to
take if that premise is ever wrong, is to **unset ``MOONSHOT_API_KEY``**:
``get_client`` then raises before any request is built, on every pod, old or
new. Raised by the codex adversarial review; accepted with that mitigation
rather than papered over.
"""

from django.db import migrations, models


IS_ENABLED_HELP_TEXT = (
    "AVAILABILITY KILL SWITCH: may free2z route any content to this model? "
    "This is a policy decision about the provider's terms, not a product one, "
    "so unlike is_ga it gates EVERY path -- the public catalogue, starting a "
    "conversation, forking one, generating a reply, zPage translation, and "
    "language detection. Turning it off deletes nothing: conversations "
    "already on the model stay readable, and turning it back on restores the "
    "model exactly as it was. EXCEPTION: rows whose provider is listed in "
    "f2z.ai.providers.POLICY_DISABLED_PROVIDERS are forced off on every save "
    "and cannot be re-enabled here -- lifting a vendor-terms decision is a "
    "reviewed code change, not a checkbox."
)

IS_GA_HELP_TEXT = (
    "Lineup / product decision: does this row appear in the chat picker? A "
    "retired or preview model is is_ga=False. Paths that are not the picker "
    "deliberately ignore it -- zPage translation resolves its model from "
    "settings, not from GA. For 'we must not send content here at all', use "
    "is_enabled."
)

# Providers free2z is not currently permitted to send content to, and why.
# A FROZEN COPY of ``f2z.ai.providers.POLICY_DISABLED_PROVIDERS`` -- migrations
# must not import live application code, or a future edit silently rewrites
# what this historical migration did. Keep the two in sync when the policy
# changes; the live list is the one that is enforced at runtime.
DISABLED_PROVIDERS = {
    "kimi": (
        "Moonshot OpenPlatform ToS (2026-07-30) permits use of Customer "
        "Content to improve the Services; no published retention period and "
        "no ZDR option (#1041)."
    ),
}


def disable_flagged_providers(apps, schema_editor):
    """Flip every row of a flagged-off provider off, on BOTH flags.

    Matched on ``provider``, not on the two model ids, deliberately: the
    objection is to the vendor's terms, so a ``kimi-k4`` added later by an
    operator must land disabled too rather than sneaking past a hardcoded list.
    (``AIModel.save`` enforces the same list on every write, so such a row
    cannot be created enabled in the first place — this covers rows that
    already exist when the migration runs.)

    ``is_ga`` goes off TOO, and that is a deploy-safety property rather than a
    product statement. Migrations run before the new image is serving, and
    ``is_enabled`` is only honoured by code that ships with it: during the roll
    — and indefinitely if ``bin/prod-healthcheck.sh`` rolls the image back
    without rolling the migration back — the live pods filter on ``is_ga``
    alone. Flipping only the new flag would leave Kimi in the picker exactly
    when nothing is watching. Found by the codex adversarial review.
    """
    AIModel = apps.get_model("openai", "AIModel")
    for provider in DISABLED_PROVIDERS:
        AIModel.objects.filter(provider=provider).update(
            is_enabled=False, is_ga=False
        )


def enable_all(apps, schema_editor):
    """Reverse: put the flagged providers back on the column default.

    ``is_ga`` is deliberately NOT restored — this migration cannot know which
    rows were in the lineup before it ran, and guessing "all of them" would
    publish a model that some other decision had retired.

    Only meaningful if this migration is ever split; as written the
    ``RemoveField`` below drops the column anyway.
    """
    AIModel = apps.get_model("openai", "AIModel")
    for provider in DISABLED_PROVIDERS:
        AIModel.objects.filter(provider=provider).update(is_enabled=True)


class Migration(migrations.Migration):

    dependencies = [
        ("openai", "0018_user_specified_output_length"),
    ]

    operations = [
        migrations.AddField(
            model_name="aimodel",
            name="is_enabled",
            field=models.BooleanField(
                default=True, help_text=IS_ENABLED_HELP_TEXT
            ),
        ),
        migrations.AlterField(
            model_name="aimodel",
            name="is_ga",
            field=models.BooleanField(default=False, help_text=IS_GA_HELP_TEXT),
        ),
        migrations.RunPython(disable_flagged_providers, enable_all),
    ]
