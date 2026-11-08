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

GPT-5.6 Sol's promotional price expires in Free2Z at **2026-11-21 00:00 UTC**.
After that instant, requests are unavailable until the price is reviewed again.
Signed catalogs expire no later than the promotion. A new immutable card and
reviewed validity update are required to extend or change the price.

OpenAI's tiered models charge higher rates above 272,000 input tokens, xAI
from 200,000, and Haiku 5.5 above 100,000. Free2Z caps context conservatively
below those thresholds, allowing for tokenizer estimation, instead of charging
short-context rates for a long-context request. These are service limits, not
claims about the providers' maximum windows. Anthropic models may offer 1M
context; this integration conservatively offers 200,000, or 86,000 for Haiku 5.5.

## Supported scope and exclusions

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
