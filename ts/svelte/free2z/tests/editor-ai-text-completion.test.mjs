import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = await readFile(
  new URL("../src/lib/components/mdEditor/EditorAITextCompletion.svelte", import.meta.url),
  "utf8",
);
const composer = await readFile(
  new URL("../src/lib/components/mdEditor/EditorComposer.svelte", import.meta.url),
  "utf8",
);

test("creator text completion quotes an explicit prompt and keeps generation reviewable", () => {
  assert.match(component, /\/api\/ai\/creator-options\//);
  assert.match(component, /\/api\/ai\/prompt\//);
  assert.match(component, /quote_token: submittedQuote\.quote_token/);
  assert.match(component, /max_output_tokens: submittedQuote\.max_output_tokens/);
  assert.match(component, /Idempotency-Key/);
  assert.match(component, /X-Expected-Actor/);
  assert.match(component, /privacy_policy_url/);
  assert.match(component, /Maximum charge/);
  assert.match(component, /actual charge is metered and may be lower/);
  assert.match(component, /onInsert\(preview\.response\)/);
  assert.match(component, /submittedDraft/);
  assert.match(component, /Draft content is never sent automatically/);
  assert.match(composer, /<EditorAITextCompletion draft=\{content\}/);
});
