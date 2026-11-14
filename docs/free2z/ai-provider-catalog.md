# Metered text model catalog

Free2Z supports text generation through OpenAI Chat Completions, Anthropic
Messages and xAI Chat Completions. Provider documentation describes a model;
it does not prove that the deployment's API key can use it. The strict catalog
requires a configured provider, an enabled reviewed model, a successful provider
listing containing its exact ID, and an unexpired price. Inference can still
fail if the provider revokes access or has insufficient credit.

`discover_ai_models` refreshes the provider inventory, including IDs that Free2Z
does not support. It never invents prices or grants capabilities. Unknown models
stay unavailable until a reviewed change adds prices, context limits and adapter
support. A failed refresh preserves the last successful listing and reports a
failure; a successful listing marks disappeared IDs unavailable. The inventory
reports reasons for exclusions, including unsupported modalities, unreviewed
snapshots and restricted models.

## Prices reviewed November 7, 2026

All prices below are standard, global, synchronous USD per million tokens,
before Free2Z's markup. Provider batch, fast, regional, hosted-tool and other
premium modes are outside this text interface. Thinking/reasoning counts as
billable output. The request quote exposes the applicable model markup; Django
models default to 50%, while the separate signed gateway card uses 20%.

| Model | Input | Cached input | Output | Free2Z context cap |
|---|---:|---:|---:|---:|
| GPT-6.1 Terra | $1 | $0.05 | $5 | 236,000 |
| Claude Fable 5.1 | $10 | $0.25 | $50 | 200,000 |
| Claude Fable 5 | $10 | $1 | $50 | 200,000 |
| Claude Opus 5.5 | $4 | $0.20 | $20 | 200,000 |
| Claude Opus 5 | $5 | $0.50 | $25 | 200,000 |
| Claude Opus 4.7 / 4.6 / 4.5 | $5 | $0.50 | $25 | 200,000 / 200,000 / 172,000 |
| Claude Sonnet 4.6 | $3 | $0.30 | $15 | 200,000 |
| Claude Sonnet 5.5 | $2 | $0.10 | $10 | 200,000 |
| Claude Haiku 5.5 | $0.10 | $0.01 | $0.50 | 86,000 |
| Grok 4.7 / 4.6 | $2 | $0.50 | $6 | 172,000 |
| Grok 4.20 reasoning / non-reasoning | $1.25 | $0.20 | $2.50 | 172,000 |
| Grok Build 0.1 | $1 | $0.20 | $2 | 172,000 |
| GPT-5.6 Sol promotion | $4 | $0.40 | $20 | 236,000 |

The complete reviewed lineup and exact decimal prices are in
[`seed_ai_models.py`](../../py/free2z/dj/apps/openai/management/commands/seed_ai_models.py).
Historical pricing cards are immutable; each price change creates a new card.
Anthropic five-minute cache writes cost 1.25 times input and one-hour writes
cost twice input. Fable 5.1 cache hits cost 2.5% of input; Opus/Sonnet 5.5 hits
cost 5%. The adapter's default OpenAI cache retention uses the published
30-minute write rate, 1.25 times input. The interface does not request the
12-hour premium retention mode.

GPT-5.6 Sol is **disabled pending guarded activation**. Its reviewed promotional
price is staged in the database, but the migration turns off this alias and
ordinary reseeding preserves that switch. This also disables an operator pin
stored on that same alias; independently named snapshot rows are unaffected.
Other models can be deployed without activating the promotion.

Activate it only through a separately reviewed release after every permitted
rollback image enforces price expiry. Keep that rollback floor in the release
record. If a pre-guard rollback is required, disable the alias before restoring
the older image. The promotional price expires at **2026-11-21 00:00 UTC**;
after that instant the model needs a new price review before activation.
After guarded activation, the signed gateway stops offering the model 72 hours
before its price expires. Every signed catalog retains its full 72-hour validity, so one
model's deadline cannot shorten other models' protection during a catalog
service outage. Django/MCP can offer the activated model until its actual price
expiry. Review promotional rates before these deadlines. A new immutable card and
reviewed validity update are required to extend or change the price.

OpenAI's tiered models charge higher rates above 272,000 input tokens, xAI
from 200,000, and Haiku 5.5 above 100,000. Free2Z caps context conservatively
below those thresholds instead of charging short-context rates for a
long-context request. Haiku 5.5 admission counts UTF-8 bytes plus conservative
message framing allowances, because an OpenAI tokenizer cannot establish its
provider token count. This can reject prompts that Anthropic would accept;
settlement uses Anthropic's reported tokens. These are service limits, not
claims about the providers' maximum windows. Anthropic models may offer 1M
context; this integration conservatively offers 200,000, or 86,000 for Haiku 5.5.

## Supported scope and exclusions

The separate signed gateway excludes the ten Claude models added in this
catalog review until its broader sampling controls are qualified. Django/MCP
supports their text calls without those controls. In particular, Sonnet 5.5
and Haiku 5.5 reject temperature, top-p and top-k. A model's availability on
one interface does not grant every capability on another.

Text requests do not expose image/audio/video generation, realtime sessions,
embeddings, moderation, provider-hosted search, multi-agent execution or provider
computer-use tools. OpenAI Pro/Codex models requiring Responses and search
models requiring separately billed tools are unavailable through this adapter.
Dated snapshots need their own reviewed prices and capabilities; an alias's
price is never assumed to cover every snapshot. Unknown text models are reported as awaiting price and capability review.
Claude Sonnet 4.5 is excluded because it is deprecated; xAI multi-agent mode
needs a separate adapter and billing review.

Claude Mythos models require separate access review. Fable availability must be
verified with the deployment key; neither a public model page nor a seeded row
establishes entitlement. Claude effort controls are not exposed by the existing
Messages adapter; always-on thinking models use provider defaults. Grok 4.6/4.7
use low effort and reserve an additional reasoning allowance because xAI's
visible-output limit does not bound reasoning tokens.

## Review and refresh

Run discovery after installing or rotating a provider key, and regularly through
the discovery job. Review reported unpriced IDs against the official sources.
Add a frozen model migration and a new rate-card seed; preserve kill switches,
operator-narrowed limits and separately priced pinned snapshots. Check cache
classes, reasoning billing, output limits, endpoint compatibility, long-context
tiers and time-limited discounts before enabling a row. Verify real inference
with the deployment key before announcing availability.

Official source evidence, retrieved November 7, 2026:

- [OpenAI pricing](https://developers.openai.com/api/docs/pricing),
  [model directory](https://developers.openai.com/api/docs/models), and
  [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra).
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing),
  [model overview](https://platform.claude.com/docs/en/models/overview),
  [Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/overview),
  [Fable 5](https://platform.claude.com/docs/en/models/fable-5/overview), and
  [Opus 5](https://platform.claude.com/docs/en/models/opus-5/overview).
- [xAI model pricing](https://docs.x.ai/developers/models),
  [Grok 4.7](https://docs.x.ai/developers/models/grok-4.7), and
  [Grok 4.6](https://docs.x.ai/developers/models/grok-4.6).

## Retirement audit — November 10, 2026 (#1323)

This audit compares the current `LINEUP`, recorded discovery payloads, explicit
provider pins and application defaults. The executable, exact-ID inventory is
[`f2z/ai/retirements.py`](../../py/free2z/f2z/ai/retirements.py). Each cohort
records its provider, cutoff and source. This is a bounded application inventory,
not a complete archive of every model ever offered by each provider. Recheck the
sources before extending it; never infer retirement from a missing listing or
from a “not sooner than” date. A dated notice without a time is conservatively
withdrawn at 00:00 UTC on that date.

Primary notices fetched **2026-11-10**:

- [OpenAI API deprecations](https://developers.openai.com/api/docs/deprecations).
- [Anthropic API model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations).
- [xAI May 15 retirement](https://docs.x.ai/developers/migration/may-15-retirement).
- [xAI November 2 image retirement](https://docs.x.ai/developers/migration/imagine-image-quality-nov-2).
- [Kimi model list and migration guidance](https://platform.kimi.ai/docs/models).
  The old Moonshot guide redirected to an inaccessible page through the fetch
  tool; the current Kimi model-list URL above was fetched successfully.

| Inventory / affected use | Official cutoff or status | Application decision |
|---|---|---|
| OpenAI GPT-3.5 Turbo, GPT-4/Turbo, GPT-4.1 nano, May 2024 GPT-4o, o1/pro, o3-mini, o4-mini aliases/snapshots | October 23, 2026; already unavailable | Reject new calls even after admin/bulk enable or rediscovery; retain rows and immutable prices |
| OpenAI GPT-4 0314, GPT-4 0125 preview, GPT-4 Turbo preview / preview-completions | March 26, 2026 | Reject utility overrides, rediscovery and historical operator pins |
| DALL-E 2 / 3 | May 12, 2026 | Reject explicit cover/announcement image overrides and utility dispatch; preserve discovered history |
| GPT Image 1 mini, GPT Image 1.5 / December 2025 snapshot, chatgpt-image-latest | December 1, 2026 | Withdraw configured cover options and reject announcement dispatch at cutoff; no automatic replacement |
| OpenAI GPT-3.5 instruct, babbage-002, davinci-002, GPT-3.5 Turbo 1106 | September 28, 2026 | Reject stale explicit utility overrides |
| OpenAI GPT-5.2/5.3 chat-latest | August 10, 2026 | Reject explicit overrides; no automatic substitution |
| Seeded GPT-5, GPT-5 mini/nano, o3 (also pro variants and snapshots in policy) | December 11, 2026 | Scheduled withdrawal, no replacement activation |
| GPT-4o/mini, GPT-4.1/mini and listed snapshots | January 14, 2027 | Scheduled withdrawal; affects utility/scoring, prompt completion, tagging, language detection, search and the paid gateway fence |
| GPT-5.1, GPT-5.4 nano and snapshots; GPT-5.3 Codex | April 1, 2027 | Scheduled withdrawal; Codex does not gain endpoint support |
| Configured OpenAI image default `gpt-image-2-2026-04-21` / alias | February 10, 2027, announced November 10 | Cover option unavailable at cutoff; announcement image dispatch rejects retired configuration |
| Claude Sonnet 4.5 alias / dated snapshot | November 30, 2026 | Already outside seed; prevent operator resurrection at cutoff |
| Claude Opus 4.1, Opus 4, Sonnet 4 alias / dated snapshots | August 5 / June 15, 2026 | Reject historical operator pins |
| Seeded Claude 4.5/4.6/4.7/4.8, Fable 5/5.1, Opus 5/5.5, Sonnet 5/5.5, Haiku 5.5 | Active; published lower-bound dates are not shutdowns | No speculative retirement |
| xAI May 15 retired slugs and November 2 image-quality slug | Already retired; redirects can continue resolving with different rates | Reject despite discovery; do not inherit replacement billing |
| Seeded Grok 4.20, Build 0.1, 4.3/4.5/4.6/4.7 | Neither fetched retirement notice names them | No retirement inferred; existing capability/price restrictions remain |
| Kimi K2.6 | Restricted to users registered before November 1; deprecation expected late December 2026 | No invented exact cutoff; existing provider policy ban remains |
| Kimi K3 | Listed; no shutdown date on fetched model list | Provider policy ban remains; no credential or policy change |

Seeded OpenAI GPT-5.2, GPT-5.4/mini, GPT-5.5, GPT-5.6 families, GPT-6
Astra/Sol/Luna and GPT-6.1 Sol/Terra have no shutdown notice in the fetched
OpenAI document. This does not establish account access or qualify new flows.
The existing GPT-5.6 Sol price-expiry/activation restriction remains independent.
Discovery-only whisper/TTS IDs remain unsupported; the fetched OpenAI notice
lists February 26, 2027 / January 6, 2027 respectively. No audio adapter is added.

### Callers, recovery and replacement evidence

`DEFAULT_UTILITY_MODEL=gpt-4o`, `PROMPT_COMPLETION_MODEL=gpt-4o-mini`,
`TAGGING_MODEL=gpt-4o-mini`, and language batch preference `gpt-4o` need separate
qualification before January 14. Selection through `AIModel.objects.enabled()`
withdraws retired rows; direct utility overrides encounter the outbound guard.
Translation, creator selections, MCP and signed SDK catalogues inherit that
selector. The gateway currently fences admission to GPT-4.1; switching that
fence needs its own endpoint, behavior, limits and receipt validation.
Announcement copy defaults to `claude-opus-5`; its direct Messages call also
checks retirement policy on configured overrides.
The signed catalogue omits a model when its cutoff enters the full 72-hour
validity horizon and advances its content revision at that transition.

Provider discovery remains an observational record, including retired slugs.
It neither changes reviewed prices nor overrides retirement policy. A live pin
cannot revive a retired public identity, and a new public alias cannot conceal
a retired upstream identity. OpenAI `ft:<base>:...` IDs inherit the published
base cutoff, including in query filters and the frozen migration. Ordinary admin saves force both availability flags
off; query and outbound guards also cover writes that bypass `save()`.
The data migration only changes availability flags and timestamps, has bounded
lock/statement timeouts, and deliberately does not reactivate on rollback.

Pending SDK calls resolve through ledger call-read/claim/complete/settle using
the captured request and hold. Those operations do not consult today's model
availability. Historical conversation reads and receipts remain readable.
Tests exercise real PostgreSQL pending recovery and settlement after a retired
identity disappears from selection, as well as aliases, operator pins, bulk
reactivation, rediscovery and scheduled cutoff boundaries.

No replacement is activated by this change. Official recommendations are
candidates, not metering or behavior evidence. In particular GPT-5.6 replacements
for the October/December cohorts, GPT-6 Luna for the January cohort, Sonnet 5.5
for Sonnet 4.5 and GPT Image 2.6 for image generation each need qualification of
their own endpoint and workload. The current language-eval recording contains
`{"runs": [], "version": 1}` and `ACCURACY_FLOORS` is empty. Offline corpus,
request-bound and mocked accounting tests establish local mechanics only; they
cannot establish replacement accuracy, deployment entitlement or paid receipts.
No paid live inference or credential operations were authorized or performed.
There was no new failed paid replacement attempt to diagnose. Image routes that
omit a model (`storytime` and the unused uploads helper) still lack an explicit
replacement contract; they must not be treated as validated image migrations.

#1291 owns source-verified price-class inputs; #1292 owns broader tier/media
admission and per-capability paid receipts. This audit changes no price, rate
card, admission fence, credential, provider ban or capability declaration.
Repeat it by fetching the sources above, comparing every `LINEUP` identity,
provider pin and default, adding exact cohorts with boundary tests, and separately
recording bounded per-workload integration evidence before replacement activation.

Local validation on November 10, 2026, from base `b4e3d793`: the focused
PostgreSQL retirement, inventory, catalogue, ledger-call, image, announcement and
language-eval modules passed **916 tests**, with the real-provider accuracy test
skipped because the recording is empty. After adding fine-tune inheritance and
strengthening the pending-call fixture to hold the retired ID against its own
published synthetic card, a final retirement/discovery/announcement/recovery run
passed **161 tests**. Ruff, migration-leaf collision checking against
`origin/main`, `makemigrations --check --dry-run`, namespace ownership,
pytest-duration-file validation and diff whitespace checks passed. No serializer,
protocol schema or generated artifact changed. These local results are not a
paid replacement receipt or deployment-access proof.

The follow-up audit re-fetched the OpenAI deprecations page on
November 10 and added the March 26, May 12 and December 1 cohorts above.
Invalid image settings (`None`, numbers, booleans, lists, dictionaries and blank
strings) return no cover option, and explicit dispatch rejects them before
client use. The newly prepared 0037 migration freezes the expanded already-retired
set; existing historical migrations remain unchanged. Fixed-clock catalogue
tests cover before/at the 72-hour withdrawal horizon, monotone revisions,
future `issued_at` skew, and matching dispatch cutoffs for public aliases,
upstream pins and fine-tunes.

The final follow-up PostgreSQL run passed **619 tests** across retirement,
inventory, discovery, signed catalogue, ledger calls, image generation and
announcement request shapes. Ruff, schema drift, migration leaves, namespace
ownership, relative Markdown links, duration-map validation and whitespace checks
also passed. The disposable database was stopped and removed after validation.
