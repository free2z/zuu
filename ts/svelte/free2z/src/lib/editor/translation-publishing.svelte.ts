/**
 * Publishing translations from the editor's tray and review loop ( D),
 * out of `routes/edit/+page.svelte` ( review).
 *
 * The rules this module holds:
 *
 * - **Warnings belong to the draft.** Whether a translation is flagged is
 *   decided by the job that WROTE the draft on screen (`draftWarnings`), not
 *   by the latest job — a refunded retry leaves the flagged draft in place.
 * - **Read at click time.** Every publish of a TRANSLATION re-reads the jobs
 *   list first (bounded): another tab or device may have replaced the draft,
 *   with new warnings, since this tab last looked. Publishing the original
 *   never waits on, or fails with, the jobs list.
 * - **A flagged draft is asked about by name, once, and never published in
 *   bulk.**
 * - **The article is fixed when the creator says "publish".** Navigating to
 *   another article mid-way must not publish ITS drafts.
 * - **Approval carries its validator.** A later list refresh never replaces
 *   the revision captured before confirmation; every write uses that value.
 */
import { get } from "svelte/store";
import { captureAccountToast } from "$lib/toast.js";
import { publishTranslationVariant } from "$lib/api/zpage-translations";
import { translationJobs } from "$lib/stores/translationJobs";
import { describeWarnings, draftWarnings } from "$lib/translation-jobs";
import { isPreconditionFailure } from "$lib/zpage-preconditions.js";
import {
  translationErrorCode,
  translationPurchaseError,
} from "$lib/zpage-translation-purchase.js";

export type Reread = "ok" | "unsupported" | "failed";
export type DraftApproval = Readonly<{ revision: string }>;

type Translate = (
  key: string,
  fallback: string,
  vars?: Record<string, string | number>,
) => string;

export interface PublishPrompt {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel: string;
  danger?: boolean;
}

export interface TranslationPublishingContext {
  /** The article open in the editor. */
  page: () => string | null | undefined;
  /** The language version open in the editor. */
  openLanguage: () => string | null | undefined;
  isDirty: () => boolean;
  /** `false` when this deployment has no jobs list (nothing to re-read). */
  listSupported: () => boolean | null | undefined;
  /** Delivered, unpublished languages: what "Publish all ready" may take. */
  readyLanguages: () => readonly string[];
  label: (language: string) => string;
  list: (languages: readonly string[]) => string;
  t: () => Translate;
  /** The editor's own confirmation prompt; resolves to the choice made. */
  ask: (prompt: PublishPrompt) => Promise<string>;
  /** A prompt suspended autosave; restart it if there are edits. */
  resumeAutosave: () => void;
  /** Publish the open version through the editor's own save. */
  publishOpen: (approvedRevision?: string) => Promise<boolean>;
  /** Reflect a publish in the editor's variants index. */
  markLocallyPublished: (page: string, language: string) => void;
  refreshVariants: (page: string) => void;
}

export function createTranslationPublishing(ctx: TranslationPublishingContext) {
  let publishing = $state<Set<string>>(new Set());

  function setPublishing(language: string, on: boolean) {
    const next = new Set(publishing);
    if (on) next.add(language);
    else next.delete(language);
    publishing = next;
  }

  /** The warnings of the draft in `language` (see the module doc). */
  function warningsOf(language: string) {
    return draftWarnings(get(translationJobs), ctx.page(), language);
  }

  function priorWarningsOf(language: string) {
    return draftSnapshot(language)?.priorWarnings ?? [];
  }

  /**
   * Ask the server what this article's jobs are now, but never wait on it
   * for long: a publish or a save must not hang on a slow list.
   *
   * `failed` (an error, or no answer in time) is NOT "nothing changed": the
   * caller must not publish, and must not save the original, on stale
   * knowledge without saying so (codex adversarial review).
   */
  async function rereadJobs(page: string, waitMs = 8000): Promise<Reread> {
    if (ctx.listSupported() === false) return "unsupported";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race<Reread>([
      translationJobs.refresh(page).then(
        (supported): Reread =>
          get(translationJobs).pages[page]?.error
            ? "failed"
            : supported
              ? "ok"
              : "unsupported",
        (): Reread => "failed",
      ),
      new Promise<Reread>(
        (resolve) => (timer = setTimeout(() => resolve("failed"), waitMs)),
      ),
    ]);
    clearTimeout(timer);
    return outcome;
  }

  /** Which delivery wrote the draft in `language`, as far as we know. */
  function draftIdentity(language: string) {
    const page = ctx.page();
    if (!page) return null;
    const draft = get(translationJobs).pages[page]?.drafts?.[language];
    return draft ? `${draft.jobId ?? ""}\u0000${draft.revision ?? ""}` : null;
  }

  function draftSnapshot(language: string) {
    const page = ctx.page();
    if (!page) return null;
    return get(translationJobs).pages[page]?.drafts?.[language] ?? null;
  }

  function draftRevision(language: string) {
    const page = ctx.page();
    if (!page) return null;
    return (
      get(translationJobs).pages[page]?.drafts?.[language]?.revision ?? null
    );
  }

  /**
   * A draft is still there, but it cannot be matched to a delivery with
   * trusted check results — for example because a creator replaced the text.
   * It is asked about rather than assumed clean.
   */
  function draftUnverified(language: string) {
    const page = ctx.page();
    if (!page) return false;
    const jobs = get(translationJobs).pages[page];
    if (jobs?.drafts?.[language]) return jobs.drafts[language].jobId === null;
    // A saved variant with no snapshot is unknown provenance. That includes
    // manual drafts and old AI jobs whose records have aged out.
    return ctx.readyLanguages().includes(language);
  }

  function cannotCheck(language?: string, notice = captureAccountToast()) {
    const t = ctx.t();
    notice.error(
      language
        ? t(
            "translationJobs.cannotCheckOne",
            "Could not check the {language} translation just now, so it was not published. Try again.",
            { language: ctx.label(language) },
          )
        : t(
            "translationJobs.cannotCheck",
            "Could not check this article's translations just now, so nothing was published. Try again.",
          ),
    );
  }

  /** Reflect a publish at once in both the store and the variants index. */
  function markPublished(page: string, language: string) {
    translationJobs.markPublished(page, language);
    ctx.markLocallyPublished(page, language);
  }

  /**
   * One explicit confirmation, naming every warning, before a translation
   * the check flagged goes live. Returns the immutable revision approved.
   */
  async function confirmDespiteWarnings(
    language: string,
    { onPhase }: { onPhase?: (phase: "checking" | "asking") => void } = {},
  ): Promise<DraftApproval | null> {
    const operationNotice = captureAccountToast();
    const page = ctx.page();
    // Only a saved article has translations; the editor never asks this
    // about the original or a not-yet-created article ( verification).
    if (!page) return null;
    onPhase?.("checking");
    if ((await rereadJobs(page)) !== "ok") {
      cannotCheck(language, operationNotice);
      return null;
    }
    const warnings = warningsOf(language);
    const priorWarnings = priorWarningsOf(language);
    const unverified = !warnings.length && draftUnverified(language);
    const snapshot = draftSnapshot(language);
    if (!snapshot?.revision) {
      cannotCheck(language, operationNotice);
      return null;
    }
    if (!warnings.length && !unverified) return { revision: snapshot.revision };
    const judged = draftIdentity(language);
    const t = ctx.t();
    onPhase?.("asking");
    const choice = await ctx.ask(
      warnings.length
        ? {
            title: t(
              "translationJobs.publishWarnedTitle",
              "Publish {language} with {count} warnings?",
              { language: ctx.label(language), count: warnings.length },
            ),
            body: t(
              "translationJobs.publishWarnedBody",
              "The translation check flagged: {warnings}. Publish only if you have checked each one.",
              { warnings: describeWarnings(warnings, t).join("; ") },
            ),
            confirmLabel: t(
              "translationJobs.publishWarnedConfirm",
              "I checked them, publish",
            ),
            cancelLabel: t("translationJobs.publishWarnedCancel", "Not yet"),
            danger: true,
          }
        : {
            title: t(
              "translationJobs.publishUnverifiedTitle",
              "Publish {language} without a translation check?",
              { language: ctx.label(language) },
            ),
            body: t(
              priorWarnings.length
                ? "translationJobs.publishUnverifiedPriorBody"
                : "translationJobs.publishUnverifiedBody",
              priorWarnings.length
                ? "The previous delivery check flagged: {warnings}. This draft has since changed and has not been checked. Review it against the original before publishing."
                : "This draft has not been checked against the original by a translation job. Read it first: amounts, code and links may differ from the original.",
              priorWarnings.length
                ? { warnings: describeWarnings(priorWarnings, t).join("; ") }
                : undefined,
            ),
            confirmLabel: t(
              "translationJobs.publishWarnedConfirm",
              "I checked them, publish",
            ),
            cancelLabel: t("translationJobs.publishWarnedCancel", "Not yet"),
            danger: true,
          },
    );
    if (choice !== "confirm") {
      ctx.resumeAutosave();
      return null;
    }
    // The approval is for THE DRAFT that was judged. Look again: another
    // tab or device may have replaced it while the question was open.
    onPhase?.("checking");
    if ((await rereadJobs(page)) !== "ok") {
      cannotCheck(language, operationNotice);
      return null;
    }
    if (draftIdentity(language) !== judged) {
      operationNotice.warning(
        t(
          "translationJobs.replacedWhileAsking",
          "The {language} translation was replaced while you were deciding. Review the new one first.",
          { language: ctx.label(language) },
        ),
      );
      return null;
    }
    return Object.freeze({ revision: snapshot.revision });
  }

  /**
   * Publish one translation, from the tray, without opening it.
   *
   * The open one goes through the editor's own publish (it may hold unsaved
   * edits, and its validator lives there, and it asks about warnings itself);
   * any other is published with the immutable `If-Match` from its approved
   * draft snapshot, so a draft saved elsewhere in between is refused rather
   * than published unseen.
   */
  async function publishOne(
    language: string,
    {
      quiet = false,
      page = ctx.page() ?? undefined,
      approvedRevision,
    }: { quiet?: boolean; page?: string; approvedRevision?: string } = {},
  ): Promise<boolean> {
    const operationNotice = captureAccountToast();
    const identifier = page;
    let approval: DraftApproval | null = approvedRevision
      ? Object.freeze({ revision: approvedRevision })
      : null;
    if (language !== ctx.openLanguage() && !approval) {
      approval = await confirmDespiteWarnings(language);
      if (!approval) return false;
    }
    if (!identifier || ctx.page() !== identifier || publishing.has(language))
      return false;
    const t = ctx.t();
    setPublishing(language, true);
    try {
      if (language === ctx.openLanguage()) {
        if (!(await ctx.publishOpen(approvedRevision))) return false;
      } else {
        const revision = approval?.revision;
        if (!revision) {
          cannotCheck(language, operationNotice);
          return false;
        }
        await publishTranslationVariant(identifier, language, revision);
        if (!quiet)
          operationNotice.success(
            t("translationJobs.publishedToast", "{language} is published.", {
              language: ctx.label(language),
            }),
          );
      }
      markPublished(identifier, language);
      ctx.refreshVariants(identifier);
      return true;
    } catch (error) {
      operationNotice.error(
        isPreconditionFailure(error as { status?: number })
          ? t(
              "translationJobs.publishChanged",
              "The {language} draft changed somewhere else, so it was not published. Review it first.",
              { language: ctx.label(language) },
            )
          : translationErrorCode(error)
            ? translationPurchaseError(error, {
                t,
                language: ctx.label(language),
              })
            : t(
                "translationJobs.publishFailed",
                "Could not publish the {language} translation. Try again.",
                { language: ctx.label(language) },
              ),
      );
      void translationJobs.refresh(identifier);
      return false;
    } finally {
      setPublishing(language, false);
    }
  }

  /** "Publish all ready": clean drafts only, listed before anything moves. */
  async function publishAll() {
    const operationNotice = captureAccountToast();
    const identifier = ctx.page();
    if (!identifier) return;
    if ((await rereadJobs(identifier)) !== "ok") {
      cannotCheck(undefined, operationNotice);
      return;
    }
    if (ctx.page() !== identifier) return;
    const t = ctx.t();
    // "As they are saved": the open version with unsaved edits is left out
    // rather than published with them (codex adversarial review).
    const ready = ctx
      .readyLanguages()
      .filter(
        (language) => !(language === ctx.openLanguage() && ctx.isDirty()),
      );
    const warned = ready.filter(
      (language) => warningsOf(language).length || draftUnverified(language),
    );
    const languages = ready.filter((language) => !warned.includes(language));
    if (!languages.length) {
      if (warned.length)
        operationNotice.warning(
          t(
            "translationJobs.publishAllOnlyWarned",
            "{languages} have warnings to check first. Review and publish them one at a time.",
            { languages: ctx.list(warned) },
          ),
        );
      return;
    }
    const leftOut = warned.length
      ? " " +
        t(
          "translationJobs.publishAllLeavesWarned",
          "Left out, because they have warnings to check first: {languages}.",
          { languages: ctx.list(warned) },
        )
      : "";
    // What is listed is what is approved: remember which draft each one is.
    const judged = new Map(
      languages.map((language) => [
        language,
        {
          identity: draftIdentity(language),
          revision: draftRevision(language),
        },
      ]),
    );
    if ([...judged.values()].some((draft) => !draft.revision)) {
      cannotCheck(undefined, operationNotice);
      return;
    }
    const choice = await ctx.ask({
      title: t(
        "translationJobs.publishAllTitle",
        "Publish every ready translation?",
      ),
      body:
        t(
          "translationJobs.publishAllBody",
          "{languages} go live now, as they are saved.",
          { languages: ctx.list(languages) },
        ) + leftOut,
      confirmLabel: t("translationJobs.publishAllConfirm", "Publish them"),
      cancelLabel: t("common.cancel", "Cancel"),
    });
    if (choice !== "confirm") {
      ctx.resumeAutosave();
      return;
    }
    // Look again — the question may have been open a while — and leave out
    // anything replaced meanwhile.
    if ((await rereadJobs(identifier)) === "failed") {
      cannotCheck(undefined, operationNotice);
      return;
    }
    let count = 0;
    for (const language of languages) {
      // Stop the moment the editor is on another article.
      if (ctx.page() !== identifier) break;
      // Never publish in bulk a draft that is now flagged, or that is no
      // longer the draft that was listed.
      if (warningsOf(language).length) continue;
      const approved = judged.get(language)!;
      if (draftIdentity(language) !== approved.identity) continue;
      // Edited since the list was approved: "as they are saved" means the
      // open version's new edits are not published with it (codex).
      if (language === ctx.openLanguage() && ctx.isDirty()) continue;
      if (
        await publishOne(language, {
          quiet: true,
          page: identifier,
          approvedRevision: approved.revision!,
        })
      )
        count += 1;
    }
    if (count)
      operationNotice.success(
        t("translationJobs.publishedMany", "Translations published: {count}.", {
          count,
        }),
      );
  }

  return {
    get publishing() {
      return publishing;
    },
    setPublishing,
    warningsOf,
    priorWarningsOf,
    rereadJobs,
    markPublished,
    confirmDespiteWarnings,
    publishOne,
    publishAll,
  };
}
