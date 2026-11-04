<script lang="ts">
  import { apiFetch } from "$lib/api/config";
  import { currentUser } from "$lib/stores/auth";
  import { authStore } from "$lib/stores/auth";
  import { tStore as t } from "$lib/i18n";
  import type {
    CreatorAIOptionsResponse,
    CreatorPromptQuote,
    CreatorPromptQuoteResponse,
    MeteredPromptRequest,
    MeteredPromptResponse,
  } from "$lib/api/f2z.schemas";
  interface Props {
    draft: string;
    onInsert: (text: string) => void;
    isAbandoned?: () => boolean;
  }
  let { draft, onInsert, isAbandoned }: Props = $props();

  type Choice = {
    id: string;
    provider: string;
    display_name: string;
    destination: string;
    privacy_policy_url: string;
    availability: string;
    queue: string;
  };
  let choices = $state<Choice[]>([]);
  let model = $state("");
  let prompt = $state("");
  let quote = $state<CreatorPromptQuoteResponse | null>(null);
  let preview = $state<MeteredPromptResponse | null>(null);
  let busy = $state(false);
  let error = $state("");
  let generation = 0;
  let actor = $derived(String($currentUser?.id ?? ""));
  let quoteSequence = 0;
  let loading = $state(true);
  let pending = $state<{
    actor: string;
    key: string;
    body: MeteredPromptRequest;
  } | null>(null);
  let ownership = authStore.captureRequestOwnership();
  let editorIdentity = crypto.randomUUID();
  const pendingKey = (id: string) =>
    `f2z:editor-ai-text-intent:v1:${encodeURIComponent(id)}`;

  async function load() {
    const loadActor = actor,
      seq = ++quoteSequence;
    loading = true;
    try {
      const response = await apiFetch("/api/ai/creator-options/");
      if (!response.ok) throw new Error("load");
      const data = (await response.json()) as CreatorAIOptionsResponse;
      if (seq !== quoteSequence || actor !== loadActor) return;
      choices = data.completion ?? [];
      if (!choices.some((choice) => choice.id === model))
        model = choices[0]?.id ?? "";
    } catch {
      if (seq === quoteSequence && actor === loadActor)
        error = $t(
          "editor.aiTextLoadError",
          "AI text models are unavailable. Try again later.",
        );
    } finally {
      if (seq === quoteSequence && actor === loadActor) loading = false;
    }
  }
  async function getQuote() {
    const seq = ++quoteSequence,
      capturedActor = actor,
      capturedPrompt = prompt,
      capturedModel = model,
      capturedDraft = draft,
      own = authStore.captureRequestOwnership();
    quote = null;
    preview = null;
    error = "";
    if (!model || !prompt.trim()) return;
    try {
      const body: CreatorPromptQuote = {
        model: capturedModel,
        prompt: capturedPrompt,
        max_output_tokens: 256,
      };
      const response = await apiFetch("/api/ai/creator-options/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("quote");
      const result = (await response.json()) as CreatorPromptQuoteResponse;
      if (
        seq === quoteSequence &&
        actor === capturedActor &&
        prompt === capturedPrompt &&
        model === capturedModel &&
        draft === capturedDraft &&
        own()
      )
        quote = result;
    } catch {
      if (seq === quoteSequence && actor === capturedActor)
        error = $t(
          "editor.aiTextQuoteError",
          "Could not price this prompt. Check the prompt and try again.",
        );
    }
  }
  async function submit() {
    if ((!quote && !pending) || busy) return;
    const requestGeneration = ++generation;
    const submittedActor = actor,
      submittedPrompt = pending?.body.prompt ?? prompt,
      submittedModel = pending?.body.model ?? model,
      submittedQuote = quote,
      submittedDraft = draft,
      own = ownership;
    const body: MeteredPromptRequest = pending?.body ?? {
      model: submittedModel,
      prompt: submittedPrompt,
      max_output_tokens: submittedQuote!.requested_output_tokens,
      quote_token: submittedQuote!.quote_token,
    };
    let intent = pending;
    if (
      intent &&
      (intent.actor !== submittedActor ||
        JSON.stringify(intent.body) !== JSON.stringify(body))
    )
      return;
    if (!intent) {
      intent = { actor: submittedActor, key: crypto.randomUUID(), body };
      pending = intent;
      try {
        localStorage.setItem(
          pendingKey(submittedActor),
          JSON.stringify(intent),
        );
      } catch {
        /* in-memory replay remains available */
      }
    }
    busy = true;
    preview = null;
    error = "";
    try {
      const response = await apiFetch("/api/ai/prompt/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": intent.key,
          "X-Expected-Actor": submittedActor,
        },
        body: JSON.stringify(intent.body),
      });
      if (!response.ok) {
        let refusal: { key_resolved?: boolean } = {};
        try {
          refusal = await response.clone().json();
        } catch {
          /* unresolved */
        }
        if (refusal.key_resolved === true) {
          pending = null;
          localStorage.removeItem(pendingKey(submittedActor));
        }
        throw new Error("generation");
      }
      const result = (await response.json()) as MeteredPromptResponse;
      if (
        requestGeneration === generation &&
        actor === submittedActor &&
        model === submittedModel &&
        prompt === submittedPrompt &&
        draft === submittedDraft &&
        own() &&
        !isAbandoned?.() &&
        editorIdentity
      )
        preview = result;
      pending = null;
      localStorage.removeItem(pendingKey(submittedActor));
    } catch {
      if (requestGeneration === generation) {
        error = $t(
          "editor.aiTextRetryError",
          "The result is uncertain. Retry this exact request to safely recover it, or keep it pending before changing provider.",
        );
      }
    } finally {
      if (requestGeneration === generation) busy = false;
    }
  }
  function accept() {
    if (!preview || isAbandoned?.()) return;
    onInsert(preview.response);
    preview = null;
  }
  $effect(() => {
    model;
    prompt;
    draft;
    quote = null;
    preview = null;
  });
  $effect(() => {
    actor;
    ownership = authStore.captureRequestOwnership();
    generation++;
    preview = null;
    quote = null;
    busy = false;
    void load();
  });
  import { onMount } from "svelte";
  onMount(() => {
    try {
      const saved = localStorage.getItem(pendingKey(actor));
      if (saved) {
        const candidate = JSON.parse(saved);
        if (
          candidate?.actor === actor &&
          typeof candidate.key === "string" &&
          candidate.body?.model &&
          candidate.body?.prompt &&
          candidate.body?.quote_token &&
          Number.isInteger(candidate.body?.max_output_tokens)
        )
          pending = candidate;
        else localStorage.removeItem(pendingKey(actor));
      }
    } catch {
      /* ignore corrupt recovery */
    }
  });
</script>

<details class="my-4 rounded-lg border border-border p-4">
  <summary class="cursor-pointer font-medium"
    >{$t("editor.aiTextTitle", "Draft with AI")}</summary
  >
  <div class="mt-3 grid gap-3">
    <label class="grid gap-1 text-sm"
      >{$t("editor.aiTextPrompt", "Prompt (sent to the selected provider)")}
      <textarea
        class="min-h-24 rounded-md border border-input bg-background p-2"
        bind:value={prompt}
        disabled={Boolean(pending)}
        placeholder={$t(
          "editor.aiTextPromptPlaceholder",
          "Describe the text you want. Draft content is never sent automatically.",
        )}></textarea>
    </label>
    <label class="grid gap-1 text-sm"
      >{$t("editor.aiTextModel", "Model")}
      <select
        class="rounded-md border border-input bg-background p-2"
        bind:value={model}
        disabled={Boolean(pending)}
      >
        {#each choices as choice}<option value={choice.id}
            >{choice.display_name} · {choice.provider}</option
          >{/each}
      </select>
    </label>
    <button
      class="w-fit rounded-md border px-3 py-2 disabled:opacity-50"
      disabled={!model || !prompt.trim()}
      onclick={() => void getQuote()}
      >{$t("editor.aiTextQuote", "Show price and destination")}</button
    >
    {#if pending}
      <p role="status">
        {$t(
          "editor.aiTextPending",
          "A prior request may have completed. Retry the exact same request to recover its result; its provider and price are locked.",
        )}
      </p>
      <button
        class="w-fit rounded-md border px-3 py-2 disabled:opacity-50"
        disabled={busy}
        onclick={() => void submit()}
        >{$t("editor.aiTextRetry", "Retry exact request")}</button
      >
    {/if}
    {#if quote && !pending}
      <section aria-live="polite" class="grid gap-1 text-sm">
        <p>
          {quote.choice.display_name} · {quote.choice.provider}; {$t(
            "editor.aiTextDestination",
            "Your prompt will be sent to {destination}.",
            { destination: quote.choice.destination },
          )}
        </p>
        <p>
          {$t(
            "editor.aiTextMaxCharge",
            "Maximum charge: {price} 2Z. The actual charge is metered from usage and may be lower.",
            { price: quote.max_charge_2z },
          )}
        </p>
        <p>
          {$t(
            "editor.aiTextAvailability",
            "Availability: {availability} Queue: {queue}",
            { availability: quote.availability, queue: quote.queue },
          )}
        </p>
        <a
          class="underline"
          href={quote.choice.privacy_policy_url}
          target="_blank"
          rel="noreferrer"
          >{$t(
            "editor.aiTextRetention",
            "Provider privacy and retention policy",
          )}</a
        >
        <button
          class="w-fit rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50"
          disabled={busy}
          onclick={() => void submit()}
          >{busy
            ? $t("editor.aiTextWorking", "Generating…")
            : $t("editor.aiTextSubmit", "Generate text (up to {price} 2Z)", {
                price: quote.max_charge_2z,
              })}</button
        >
      </section>
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
    {#if preview}<section aria-live="polite" class="grid gap-2">
        <p>
          {$t(
            "editor.aiTextPreview",
            "Preview — nothing has been inserted yet",
          )}
        </p>
        <div class="rounded-md border p-3 whitespace-pre-wrap">
          {preview.response}
        </div>
        <p>
          {$t("editor.aiTextCharged", "Charged {price} 2Z", {
            price: preview.tuzis_charged,
          })}
        </p>
        <button
          class="w-fit rounded-md bg-primary px-3 py-2 text-primary-foreground"
          onclick={accept}>{$t("editor.aiTextAccept", "Insert text")}</button
        ><button
          class="w-fit rounded-md border px-3 py-2"
          onclick={() => (preview = null)}
          >{$t("editor.aiTextDiscard", "Discard")}</button
        >
      </section>{/if}
  </div>
</details>
