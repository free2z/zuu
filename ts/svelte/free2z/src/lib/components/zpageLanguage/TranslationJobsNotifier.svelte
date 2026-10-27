<script lang="ts">
  /**
   * App-wide half of the translation tray, mounted once in the root
   * layout so it outlives every route.
   *
   * - **Announces outcomes** of jobs the store is watching — once each, with a
   *   Review action, wherever the creator is. Never switches the editor by
   *   itself: a delivery is news, not a navigation.
   * - **Shows "2 translating, 3 ready"** off the editor, where the editor's
   *   own indicator is not on screen. Pressing it opens that article's tray.
   * - **Resumes watching** when the tab comes back to the foreground.
   *
   * Jobs the editor's own purchase watcher has `claim`ed are announced by the
   * editor, which knows more (the open variant, unsaved edits); this skips
   * them so nothing is said twice.
   */
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { toast } from "$lib/toast.js";
  import { reviewTranslation } from "$lib/editor/translation-review.js";
  import { locale, tStore as t } from "$lib/i18n";
  import { translationJobs } from "$lib/stores/translationJobs";
  import {
    allJobs,
    indicatorPage,
    summarizeJobs,
    type TranslationJobEntry,
  } from "$lib/translation-jobs";
  import {
    editorVariantHref,
    languageDisplayName,
  } from "$lib/zpage-language.js";
  import TranslationJobsIndicator from "./TranslationJobsIndicator.svelte";

  const onEditor = $derived(page.route.id === "/edit");
  /**
   * Failures this tab SAW happen, per article, until that article's tray is
   * opened. Off the editor they are what keeps the indicator up, so Retry is
   * one press away ( review); last month's failures are not news.
   */
  let unseenFailures = $state<Record<string, string[]>>({});
  const counts = $derived(summarizeJobs(allJobs($translationJobs)));
  const summary = $derived({
    active: counts.active,
    ready: counts.ready,
    attention: Object.values(unseenFailures).reduce(
      (sum, languages) => sum + languages.length,
      0,
    ),
  });
  $effect(() => {
    const opened = $translationJobs.trayPage;
    if (opened && unseenFailures[opened]) {
      const rest = { ...unseenFailures };
      delete rest[opened];
      unseenFailures = rest;
    }
  });

  function name(language: string) {
    return languageDisplayName(language, $locale) ?? language;
  }

  function announce(entry: TranslationJobEntry) {
    const language = name(entry.language);
    if (entry.status === "delivered") {
      toast.success(
        $t("translationJobs.deliveredToast", "{language} is ready to review.", {
          language,
        }),
        {
          action: {
            label: $t("translationJobs.review", "Review"),
            onClick: () => reviewTranslation(entry.page, entry.language),
          },
        },
      );
    } else if (entry.status === "refunded") {
      toast.error(
        $t(
          "editor.translateAiRefunded",
          "The {language} translation could not be completed, so all {price} 2Z were credited back to your balance.",
          { language, price: entry.price ?? "" },
        ),
      );
    } else if (entry.status === "settled") {
      toast.error(
        $t(
          "editor.translateAiSettled",
          "The {language} translation could not be delivered because the article or its translation changed while it was running. {refunded} of {price} 2Z are back in your balance; {billed} 2Z cover the work already done.",
          {
            language,
            price: entry.price ?? "",
            refunded: entry.refunded ?? "0",
            billed: entry.billed ?? "0",
          },
        ),
      );
    }
  }

  onMount(() => {
    const stop = translationJobs.onTransition((entry) => {
      if (entry.status === "refunded" || entry.status === "settled")
        unseenFailures = {
          ...unseenFailures,
          [entry.page]: [
            ...new Set([...(unseenFailures[entry.page] ?? []), entry.language]),
          ],
        };
      if (!entry.claimed) announce(entry);
    });
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      for (const pageId of Object.keys($translationJobs.pages))
        translationJobs.resume(pageId);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  });

  function openTray() {
    const target =
      indicatorPage($translationJobs) ?? Object.keys(unseenFailures)[0] ?? null;
    if (!target) return;
    translationJobs.openTray(target);
    void goto(editorVariantHref(target, ""));
  }
</script>

{#if !onEditor && (summary.active || summary.ready || summary.attention)}
  <div class="fixed bottom-4 left-4 z-40">
    <TranslationJobsIndicator
      {summary}
      onopen={openTray}
      class="bg-background shadow-lg"
    />
  </div>
{/if}
