<script lang="ts">
  /**
   * The original, read-only, beside the translation being reviewed.
   *
   * Shown as SOURCE — Markdown as written — because the composer beside it
   * shows the translation that way: the same words line up the same way
   * ( review). On a phone it folds away above the translation.
   *
   * Re-read on every review step (`revision`), never cached per article: the
   * original can be rewritten and saved between two reviews without leaving
   * the article, and a translation must be judged against the text it was
   * made from (codex adversarial review). A request counter drops an answer
   * a later step has already superseded.
   */
  import { tStore as t } from "$lib/i18n";
  import { apiFetch } from "$lib/api/config";

  interface Props {
    page: string;
    sourceLanguage?: string | null;
    /** Bumped by the editor on every review step: read the original again. */
    revision: number;
    label: (language: string | null | undefined) => string;
  }

  let { page, sourceLanguage = null, revision, label }: Props = $props();

  let source = $state<{
    language: string;
    title: string;
    description: string;
    content: string;
  } | null>(null);
  let open = $state(false);
  let request = 0;

  async function load(identifier: string, language: string | null) {
    const mine = ++request;
    try {
      const response = await apiFetch(
        language
          ? `/api/zpage/${encodeURIComponent(identifier)}/variants/${encodeURIComponent(language)}/?mine=true`
          : `/api/zpage/${encodeURIComponent(identifier)}/`,
        { timeoutMs: 20_000 },
      );
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json();
      if (mine !== request) return;
      source = {
        language: body.actual_language || language || "",
        title: body.title ?? "",
        description: body.description ?? "",
        content: String(body.content ?? ""),
      };
    } catch {
      if (mine === request) source = null;
    }
  }

  $effect(() => {
    // Every step, every article: `revision` is read so a step re-reads.
    void revision;
    void load(page, sourceLanguage);
  });
</script>

<section
  class="w-full border-b border-border bg-muted/20 lg:w-1/2 lg:border-r lg:border-b-0"
  aria-labelledby="translation-review-source-title"
  data-testid="translation-review-source"
>
  <button
    type="button"
    class="flex min-h-11 w-full items-center justify-between px-4 text-left text-sm font-medium lg:pointer-events-none lg:min-h-0 lg:px-8 lg:pt-6"
    aria-expanded={open}
    aria-controls="translation-review-source-body"
    onclick={() => (open = !open)}
  >
    <span id="translation-review-source-title">
      {$t("translationJobs.originalLabel", "Original: {language}", {
        language: label(source?.language || sourceLanguage),
      })}
    </span>
    <span aria-hidden="true" class="text-muted-foreground lg:hidden"
      >{open ? "−" : "+"}</span
    >
  </button>
  <div
    id="translation-review-source-body"
    class="{open ? '' : 'hidden'} px-4 pb-8 lg:block lg:px-8"
  >
    {#if source}
      <article
        lang={source.language || undefined}
        dir="auto"
        class="leading-relaxed text-foreground"
      >
        <h1 class="mt-4 mb-3 text-3xl leading-tight font-bold">
          {source.title}
        </h1>
        {#if source.description}
          <p class="mb-6 text-lg text-muted-foreground">
            {source.description}
          </p>
        {/if}
        <div
          class="font-sans text-[1.125rem] leading-relaxed whitespace-pre-wrap"
          data-testid="translation-review-source-body"
        >
          {source.content}
        </div>
      </article>
    {:else}
      <p class="pt-4 text-sm text-muted-foreground">
        {$t("translationJobs.originalLoading", "Loading the original…")}
      </p>
    {/if}
  </div>
</section>
