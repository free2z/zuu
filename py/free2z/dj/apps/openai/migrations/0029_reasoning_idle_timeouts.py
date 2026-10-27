"""Silent-reasoning OpenAI rows: ``idle_timeout_ms`` and ``ttfb_timeout_ms``
= 300000; the 1M-window gpt-4.1 rows: ``ttfb_timeout_ms`` = 300000; every
OpenAI row: ``safety_factor_bps`` = 11000 (tuzi#2492).

A reasoning model (gpt-5.x, gpt-6.x, the o-series) streams nothing while it
thinks. Two gateway deadlines would cut that think off at their 60 s default:

* ``ttfb_timeout_ms`` -- runs from the request send until the FIRST BODY
  BYTE, even after a 2xx head, and a Chat Completions stream from a
  reasoning model can be silent until reasoning ends
  (``provider_timeout first_byte``);
* ``idle_timeout_ms`` -- the longest silence between body bytes after that.

These rows get 300000 for both: the gateway clamps every deadline to its own
300 s absolute call deadline from admission, so in effect only that deadline
applies. It is safe to let a call run that long now that the gateway settles
an interrupted call on its estimate instead of releasing the hold
(zuu#1164). These rows stay outside ``k8s/f2z-ai/configmap.yaml``'s
``allowed_models`` until zuu#1179 also settles a cut call's unseen reasoning
at the output cap; with the timeouts already signed, admitting them then is a
ConfigMap change only.

Scope, per row and per field:

* ``provider == "openai"`` and ``model`` starting with one of
  ``SILENT_REASONING_PREFIXES`` (a frozen mirror of
  ``seed_ai_models.SILENT_REASONING_PREFIXES``; 20 rows of the v3 LINEUP);
* each field only while it is still at the 60 s default: an operator's
  explicit value is kept (``MAX_IDLE_TIMEOUT_MS`` bounds idle; ttfb has no
  Django upper bound, only ``>= 1``).

Every OpenAI row (any model) still at the 11500 default ``safety_factor_bps``
gets 11000. The gateway now tokenises OpenAI prompts exactly (its input
estimate measured 1.077-1.079x over the billed count on the AHA corpus, never
under), so the margin is +10 %, not the +15 % the byte bound needed. Other
providers keep 11500: their estimate is still the byte bound. The column's
constraint is ``>= 10000``.

The gpt-4.1 family (``LONG_PREFILL_PREFIXES``: gpt-4.1, gpt-4.1-mini,
gpt-4.1-nano) gets ``ttfb_timeout_ms`` = 300000 only, on the same "still at the
default" guard: the 1M-window rows wait up to the hard deadline for their
first byte. A ~900K-token prompt can take most of a minute to prefill, and on
the pinned gateway a first-byte timeout BEFORE the response head ends the call
``accepted=false`` -- the hold is released while OpenAI may bill the processed
input (~$1.80 on gpt-4.1), so a 60 s ttfb would let a caller get such calls
refunded. Their ``idle_timeout_ms`` stays 60000: tokens flow once started.

``updated_at`` is stamped so the signed catalogue's version moves on the next
poll. ``supports_reasoning`` is not touched.

Reverse: for rows these rules match, a field reading the value the forward
sets (300000 / 11000) goes back to its default (60000 / 11500). (A field an
operator had set to that exact value by hand before the forward ran cannot be
told apart and is reset too; that is the only lossy case.)
"""
from django.db import migrations
from django.db.models import Q
from django.utils import timezone

# Frozen copies of dj.apps.openai.models at this commit.
DEFAULT_TTFB_TIMEOUT_MS = 60_000
DEFAULT_IDLE_TIMEOUT_MS = 60_000
MAX_IDLE_TIMEOUT_MS = 300_000
# The gateway's absolute call deadline: "only the hard deadline applies".
REASONING_TIMEOUT_MS = 300_000
DEFAULT_SAFETY_FACTOR_BPS = 11_500
# x1.10 over an exact (tokenizer-backed) OpenAI input estimate.
OPENAI_SAFETY_FACTOR_BPS = 11_000

# Frozen mirror of seed_ai_models.SILENT_REASONING_PREFIXES.
SILENT_REASONING_PREFIXES = ("gpt-5", "gpt-6", "o1", "o3", "o4")
# Frozen mirror of seed_ai_models.LONG_PREFILL_PREFIXES.
LONG_PREFILL_PREFIXES = ("gpt-4.1",)

# (field, default) pairs this migration moves between default and 300000.
FIELDS = (
    ("ttfb_timeout_ms", DEFAULT_TTFB_TIMEOUT_MS),
    ("idle_timeout_ms", DEFAULT_IDLE_TIMEOUT_MS),
)


def _openai_rows(AIModel, prefixes):
    prefix = Q()
    for p in prefixes:
        prefix |= Q(model__startswith=p)
    return AIModel.objects.filter(provider="openai").filter(prefix)


def _reasoning_rows(AIModel):
    return _openai_rows(AIModel, SILENT_REASONING_PREFIXES)


def _long_prefill_rows(AIModel):
    return _openai_rows(AIModel, LONG_PREFILL_PREFIXES)


def tune_openai_rows(apps, schema_editor):
    AIModel = apps.get_model("openai", "AIModel")
    now = timezone.now()
    for field, default in FIELDS:
        _reasoning_rows(AIModel).filter(**{field: default}).update(
            **{field: REASONING_TIMEOUT_MS}, updated_at=now)
    _long_prefill_rows(AIModel).filter(ttfb_timeout_ms=DEFAULT_TTFB_TIMEOUT_MS).update(
        ttfb_timeout_ms=REASONING_TIMEOUT_MS, updated_at=now)
    AIModel.objects.filter(
        provider="openai", safety_factor_bps=DEFAULT_SAFETY_FACTOR_BPS,
    ).update(safety_factor_bps=OPENAI_SAFETY_FACTOR_BPS, updated_at=now)


def untune_openai_rows(apps, schema_editor):
    AIModel = apps.get_model("openai", "AIModel")
    now = timezone.now()
    for field, default in FIELDS:
        _reasoning_rows(AIModel).filter(**{field: REASONING_TIMEOUT_MS}).update(
            **{field: default}, updated_at=now)
    _long_prefill_rows(AIModel).filter(ttfb_timeout_ms=REASONING_TIMEOUT_MS).update(
        ttfb_timeout_ms=DEFAULT_TTFB_TIMEOUT_MS, updated_at=now)
    AIModel.objects.filter(
        provider="openai", safety_factor_bps=OPENAI_SAFETY_FACTOR_BPS,
    ).update(safety_factor_bps=DEFAULT_SAFETY_FACTOR_BPS, updated_at=now)


class Migration(migrations.Migration):

    dependencies = [
        ("openai", "0028_aimodel_reasoning_effort"),
    ]

    operations = [
        migrations.RunPython(tune_openai_rows, untune_openai_rows),
    ]
