<script lang="ts">
  import { apiFetch } from "$lib/api/config";
  import { currentUser } from "$lib/stores/auth";
  import { tStore as t } from "$lib/i18n";
  interface Props { draft: string; onInsert: (text: string) => void; }
  let { draft, onInsert }: Props = $props();

  type Choice = { id: string; provider: string; display_name: string; destination: string; privacy_policy_url: string; availability: string; queue: string };
  let choices = $state<Choice[]>([]);
  let model = $state("");
  let prompt = $state("");
  let quote = $state<any>(null);
  let preview = $state<any>(null);
  let busy = $state(false);
  let error = $state("");
  let generation = 0;
  let actor = $derived(String($currentUser?.id ?? ""));

  async function load() {
    try {
      const response = await apiFetch("/api/ai/creator-options/");
      if (!response.ok) throw new Error("load");
      choices = (await response.json()).completion ?? [];
      if (!choices.some((choice) => choice.id === model)) model = choices[0]?.id ?? "";
    } catch { error = $t("editor.aiTextLoadError", "AI text models are unavailable. Try again later."); }
  }
  async function getQuote() {
    quote = null; preview = null; error = "";
    if (!model || !prompt.trim()) return;
    const response = await apiFetch("/api/ai/creator-options/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, prompt, max_output_tokens: 256 }) });
    if (!response.ok) throw new Error("quote");
    quote = await response.json();
  }
  async function submit() {
    if (!quote || busy) return;
    const requestGeneration = ++generation;
    const submittedActor = actor, submittedPrompt = prompt, submittedModel = model, submittedQuote = quote, submittedDraft = draft;
    busy = true; preview = null; error = "";
    try {
      const response = await apiFetch("/api/ai/prompt/", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), "X-Expected-Actor": submittedActor }, body: JSON.stringify({ model: submittedModel, prompt: submittedPrompt, max_output_tokens: submittedQuote.max_output_tokens, quote_token: submittedQuote.quote_token }) });
      if (!response.ok) throw new Error("generation");
      const result = await response.json();
      if (requestGeneration === generation && actor === submittedActor && model === submittedModel && prompt === submittedPrompt && draft === submittedDraft) preview = result;
    } catch { if (requestGeneration === generation) error = $t("editor.aiTextGenerateError", "Text generation failed. Review your choice and try again."); }
    finally { if (requestGeneration === generation) busy = false; }
  }
  function accept() { if (!preview) return; onInsert(preview.response); preview = null; }
  $effect(() => { model; prompt; draft; quote = null; preview = null; });
  $effect(() => { actor; generation++; preview = null; });
  $effect(() => { void load(); });
</script>

<details class="my-4 rounded-lg border border-border p-4">
  <summary class="cursor-pointer font-medium">{$t("editor.aiTextTitle", "Draft with AI")}</summary>
  <div class="mt-3 grid gap-3">
    <label class="grid gap-1 text-sm">{$t("editor.aiTextPrompt", "Prompt (sent to the selected provider)")}
      <textarea class="min-h-24 rounded-md border border-input bg-background p-2" bind:value={prompt} placeholder={$t("editor.aiTextPromptPlaceholder", "Describe the text you want. Draft content is never sent automatically.")} />
    </label>
    <label class="grid gap-1 text-sm">{$t("editor.aiTextModel", "Model")}
      <select class="rounded-md border border-input bg-background p-2" bind:value={model} onchange={() => void getQuote()}>
        {#each choices as choice}<option value={choice.id}>{choice.display_name} · {choice.provider}</option>{/each}
      </select>
    </label>
    <button class="w-fit rounded-md border px-3 py-2 disabled:opacity-50" disabled={!model || !prompt.trim()} onclick={() => void getQuote()}>{$t("editor.aiTextQuote", "Show price and destination")}</button>
    {#if quote}
      <section aria-live="polite" class="grid gap-1 text-sm">
        <p>{quote.choice.display_name} · {quote.choice.provider}; prompt goes to {quote.choice.destination}.</p>
        <p>Maximum charge: {quote.max_charge_2z} 2Z; actual charge is metered and may be lower.</p>
        <p>{quote.availability} {quote.queue}</p>
        <a class="underline" href={quote.choice.privacy_policy_url} target="_blank" rel="noreferrer">{$t("editor.aiTextRetention", "Provider privacy and retention policy")}</a>
        <button class="w-fit rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={busy} onclick={() => void submit()}>{busy ? $t("editor.aiTextWorking", "Generating…") : $t("editor.aiTextSubmit", "Generate text (up to {price} 2Z)", { price: quote.max_charge_2z })}</button>
      </section>
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
    {#if preview}<section aria-live="polite" class="grid gap-2"><p>{$t("editor.aiTextPreview", "Preview — nothing has been inserted yet")}</p><div class="whitespace-pre-wrap rounded-md border p-3">{preview.response}</div><p>{$t("editor.aiTextCharged", "Charged {price} 2Z", { price: preview.tuzis_charged })}</p><button class="w-fit rounded-md bg-primary px-3 py-2 text-primary-foreground" onclick={accept}>{$t("editor.aiTextAccept", "Insert text")}</button><button class="w-fit rounded-md border px-3 py-2" onclick={() => (preview = null)}>{$t("editor.aiTextDiscard", "Discard")}</button></section>{/if}
  </div>
</details>
