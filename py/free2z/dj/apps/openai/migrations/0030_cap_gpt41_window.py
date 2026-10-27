"""Cap gpt-4.1's SELLABLE window to 128000 and output ceiling to 16384.

gpt-4o's class, so ``k8s/f2z-ai/configmap.yaml`` can admit gpt-4.1 through
the gateway's ``allowed_models`` fence. The fence exists for the one path
that still releases a whole hold: a request written to the provider that
fails before any response head (a reset, or the 300 s hard limit) refunds
input the provider may already have billed. At the documented 1M window that
is ~$1.80 per gpt-4.1 call; at 128000 it is 128K x $2/M = ~$0.26, the same
order as gpt-4o (~$0.32). The documented 32768 output can outlive the 300 s
deadline; 16384 is gpt-4o's ceiling. The gateway enforces both through the
signed catalogue (``context_window`` = ``max_tokens``, ``max_output_tokens``
= ``max_response_tokens``).

gpt-4.1-mini / -nano keep their 1M windows: their full-window refund is
~$0.36 / ~$0.09, already accepted by tuzi#2492.

Forward only LOWERS (``min`` with the existing value), so an operator who
narrowed the row further keeps it. Reverse restores the documented figures
only on a row still exactly at the cap.

Frozen mirror of ``seed_ai_models.GATEWAY_FENCE_CAPS`` (migrations must not
import live code); ``test_lineup_v3_migration`` keeps the two in sync.
"""
from django.db import migrations
from django.utils import timezone

MODEL = "gpt-4.1"
CAP_WINDOW = 128_000
CAP_RESPONSE = 16_384
# LINEUP's documented figures, what reverse restores.
DOCUMENTED_WINDOW = 1_047_576
DOCUMENTED_RESPONSE = 32_768


def _rows(AIModel):
    return AIModel.objects.filter(provider="openai", model=MODEL)


def cap(apps, schema_editor):
    AIModel = apps.get_model("openai", "AIModel")
    now = timezone.now()
    for row in _rows(AIModel):
        window = min(row.max_tokens or CAP_WINDOW, CAP_WINDOW)
        response = min(row.max_response_tokens or CAP_RESPONSE, CAP_RESPONSE, window)
        reserve = min(row.max_output_tokens, window) if row.max_output_tokens else row.max_output_tokens
        if (window, response, reserve) != (row.max_tokens, row.max_response_tokens, row.max_output_tokens):
            AIModel.objects.filter(pk=row.pk).update(
                max_tokens=window, max_response_tokens=response,
                max_output_tokens=reserve, updated_at=now)


def uncap(apps, schema_editor):
    AIModel = apps.get_model("openai", "AIModel")
    _rows(AIModel).filter(max_tokens=CAP_WINDOW, max_response_tokens=CAP_RESPONSE).update(
        max_tokens=DOCUMENTED_WINDOW, max_response_tokens=DOCUMENTED_RESPONSE,
        updated_at=timezone.now())


class Migration(migrations.Migration):

    dependencies = [
        ("openai", "0029_reasoning_idle_timeouts"),
    ]

    operations = [
        migrations.RunPython(cap, uncap),
    ]
