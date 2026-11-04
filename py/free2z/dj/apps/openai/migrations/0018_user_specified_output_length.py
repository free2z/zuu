"""Let the requester choose how long a reply they want (#1033 §3.1 follow-up).

#1034 closed a real hole -- the provider was called before anyone knew whether
the request could be paid for -- but it closed it with a fixed per-model output
cap. Two consequences the owner rejected:

* a user holding plenty of 2Z got exactly as long a reply as one scraping the
  minimum, and
* for openai / xai / kimi, where nothing had bounded the reply before, the
  longest generations got shorter. gpt-4o's cap was set to 8192 against a
  documented 16 384 maximum output -- a halving.

The length of the reply is now the requester's to name (``max_output_tokens``
in the request body) and to pre-cover: admission prices the length they asked
for, so uncapping is safe precisely because nothing is generated before the 2Z
to pay for it are known to be there.

That needs a second number, and this migration ONLY ADDS IT.

``max_output_tokens`` (existing column) -- UNTOUCHED, name and values
    Holds the RESERVE: the slice of the context window ``build_messages`` keeps
    free when trimming. New code reads it through
    ``AIModel.get_output_token_reserve``.

``max_response_tokens`` (new column)
    The longest single reply the model will produce -- the provider's own
    documented output limit. The ceiling a request's ``max_output_tokens`` is
    clamped to, and the default when a request names none (clamped again by the
    room left in the window, and by what the requester's 2Z cover).

WHY ADD-ONLY, TWICE OVER. The codex adversarial review killed two earlier
drafts of this migration, and both failures were the same shape: Cloud Build
runs ``manage.py migrate`` BEFORE the new pods roll, and ``prod-healthcheck.sh``
rolls back the IMAGE without reversing the DATA.

1. *Renaming* ``max_output_tokens`` would leave every pod on the old image
   selecting a column that no longer exists -- a 500 on any AIModel access, so
   the model picker and the whole chat, for the length of the rollout, and
   forever if the rollout is rolled back.
2. *Raising* ``max_output_tokens`` in place would be read by the old image as
   both the prompt reserve and the mandatory admission ceiling: 100-2Z users
   locked out of five models, up to 112k tokens of conversation memory dropped,
   and old pods sending 128k-token requests with no deadline. A rollback leaves
   that state in place indefinitely.

Adding a column the old image never selects has neither failure mode. An old
pod behaves EXACTLY as it does today, and a rollback is a no-op. Renaming
``max_output_tokens`` to something honest is a contract-phase PR for later.

WHICH CEILINGS. Only where the provider documents the number. gpt-4o 16 384;
the GPT-5 family 128 000; Claude Opus 32 000, Sonnet and Haiku 64 000; Kimi
K2 16 384. xAI publishes a context window but no separate output limit, so
grok stays exactly where #1034 left it -- a too-high ceiling is a provider 400
on every ordinary request for that model, and the default now reaches the
ceiling, so a guess there would break the model rather than shorten one answer.

WHAT THIS DOES NOT CHANGE. Admission still runs before the provider call and
still prices a hard cap that is the same number sent to the provider, so the
ceiling is real and not an estimate. ``ledger.debit`` is untouched. The
concurrent-admission window (authorize-then-capture) is still open and still
#1033's structural work. Reasoning tokens still consume this budget while the
charge counts only visible text (#1033 §3.4) -- a bigger ceiling widens that
gap, though what actually bounds it in practice is the wall clock below, not
the ceiling.

WORST CASE, HONESTLY. The longest reply anyone can buy is 128 000 tokens. What
limits a single reply in production is not that number but the transport:
``/api`` inherits ``proxy_read_timeout 200s`` from nginx's server block, and
gunicorn writes nothing until the generation ends, so
``AI_CHAT_DEADLINE_SECONDS`` stops at 170s and returns/charges the partial
reply rather than letting the client 504 while a worker keeps going. At
observed rates that is roughly 10k-20k tokens. Raising it means raising the
nginx window, which is a decision about how long one of five single-worker pods
may be held (#720); the real fix is the SSE transport in #1033 §3.2.
"""

from django.db import migrations, models


DEFAULT_MAX_RESPONSE_TOKENS = 8192

# (provider, model): max_response_tokens -- each provider's documented maximum
# output for that model. Mirrored in
# ``dj/apps/openai/management/commands/seed_ai_models.py``; the mirror is
# enforced by ``test_spend_ceiling.test_seed_command_and_migration_agree``.
#
# The 2Z a request must cover to ask for the whole of one of these, at
# markup 1.5 and an empty prompt (`limit * output_price * 100 * 1.5`):
#
#   gpt-4o            16 384 x $0.00001   ->  25 2Z
#   claude-opus-4-8   32 000 x $0.000025  -> 120 2Z
#   claude-sonnet-5   64 000 x $0.000015  -> 145 2Z
#   claude-haiku-4-5  64 000 x $0.000005  ->  48 2Z
#   gpt-5.6-sol      128 000 x $0.00003   -> 577 2Z
#   gpt-5.6-terra    128 000 x $0.000015  -> 289 2Z
#   gpt-5.6-luna     128 000 x $0.000006  -> 116 2Z
#   grok-4.x           8 192 x $0.0000025 ->   4 2Z   (unchanged from #1034)
#   kimi-k*           16 384 x $0.0000025 ->   7 2Z
#
# (Sonnet, Sol and Terra are exactly 144 / 576 / 288 on paper; `get_tuzi_price`
# computes in float and ceils, so they land one 2Z higher. Pre-existing, and it
# errs in our favour. The table is pinned in test_spend_ceiling.)
#
# Nobody is locked out by those numbers, because a request that names no length
# gets the longest reply the requester's 2Z already cover instead of being
# refused. They are what it takes to DEMAND the maximum.
RESPONSE_LIMITS = {
    ("openai", "gpt-4o"): 16384,
    ("openai", "gpt-5.6-sol"): 128000,
    ("openai", "gpt-5.6-terra"): 128000,
    ("openai", "gpt-5.6-luna"): 128000,
    ("anthropic", "claude-opus-4-8"): 32000,
    ("anthropic", "claude-sonnet-5"): 64000,
    ("anthropic", "claude-haiku-4-5"): 64000,
    ("xai", "grok-4.5"): 8192,
    ("xai", "grok-4.3"): 8192,
    ("kimi", "kimi-k3"): 16384,
    ("kimi", "kimi-k2.6"): 16384,
}


def set_limits(apps, schema_editor):
    """Fill the new column for the rows we know something about.

    Rows not in the table (operator-added, or the retired gpt-3.5-turbo /
    gpt-4-turbo) keep the column default. There is deliberately no "no limit"
    value: ``AIModel.get_max_response_tokens`` turns 0/NULL into the default
    rather than into ``None``, and ``None`` is what would reach the three
    OpenAI-compatible SDKs as no provider-side ceiling at all.

    Nothing else is written. ``max_output_tokens`` keeps #1034's values, which
    is what makes this migration invisible to a pod on the old image.
    """
    AIModel = apps.get_model("openai", "AIModel")
    for (provider, model), limit in RESPONSE_LIMITS.items():
        AIModel.objects.filter(provider=provider, model=model).update(
            max_response_tokens=limit
        )


def unset_limits(apps, schema_editor):
    """Reverse: back to the column default before the RemoveField drops it.

    Reversing shortens the longest replies again; it does not reintroduce
    uncapped generation (the RemoveField does, and that is a downgrade in every
    sense).
    """
    AIModel = apps.get_model("openai", "AIModel")
    AIModel.objects.update(max_response_tokens=DEFAULT_MAX_RESPONSE_TOKENS)


class Migration(migrations.Migration):

    dependencies = [
        ("openai", "0017_aimodel_max_output_tokens"),
    ]

    operations = [
        migrations.AddField(
            model_name="aimodel",
            name="max_response_tokens",
            field=models.IntegerField(
                default=DEFAULT_MAX_RESPONSE_TOKENS,
                help_text=(
                    "The LONGEST single reply this model will produce -- the "
                    "provider's own documented output limit. It is the "
                    "ceiling on the output length a request may ask for "
                    "(max_output_tokens in the request body) and the default "
                    "when a request asks for nothing in particular, clamped "
                    "to what the context window has left and to what the "
                    "requester's 2Z cover. Count reasoning tokens in here "
                    "too: on models that bill them, they consume the same "
                    "budget. Setting it above what the provider accepts earns "
                    "a 400 on the requests that reach for it."
                ),
            ),
        ),
        # help_text only -- no DDL, no data. The COLUMN and its values are
        # deliberately untouched; see the module docstring.
        migrations.AlterField(
            model_name="aimodel",
            name="max_output_tokens",
            field=models.IntegerField(
                default=4096,
                help_text=(
                    "RESERVE, despite the name (kept so a rolling deploy "
                    "never sees a column change meaning under it): output "
                    "tokens held back from the context window when trimming "
                    "the prompt. This is the SHORTEST reply a maximally "
                    "packed conversation is still guaranteed room for -- NOT "
                    "a cap on the reply. The longest reply is "
                    "max_response_tokens. Raising this gives long "
                    "conversations more room to answer and less room to "
                    "remember."
                ),
            ),
        ),
        migrations.AlterField(
            model_name="aimodel",
            name="max_tokens",
            field=models.IntegerField(
                help_text=(
                    "TOTAL context window: prompt AND reply are charged "
                    "against this one number by every provider, so "
                    "build_messages() trims the prompt to max_tokens - "
                    "max_output_tokens and the reply is clamped to whatever "
                    "the window has left."
                ),
            ),
        ),
        migrations.RunPython(set_limits, unset_limits),
    ]
