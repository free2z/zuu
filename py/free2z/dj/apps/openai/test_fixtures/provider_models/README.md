# Recorded provider model listings

Shapes of `GET /v1/models` as the SDKs return them, trimmed to what the
discovery tests need (`test_model_discovery.py`). Recorded by hand from the
providers' API references on 2026-10-05 -- no test calls a provider.

* `openai.json`: OpenAI's list object (`object: "list"`, entries with `id`,
  `object`, `created`, `owned_by`). Deliberately includes ids nobody prices
  (embeddings, image, audio, dated snapshots) and deliberately OMITS
  `gpt-6.1-sol`, which the lineup prices, so "priced but not listed" is a
  case the fixtures exercise.
* `xai.json`: the OpenAI-compatible shape xAI serves, with an unpriced
  `grok-4.7` and an image model.
* `anthropic.json`: Anthropic's page (`data`, `has_more`, `first_id`,
  `last_id`; entries with `type`, `id`, `display_name`, `created_at`).
