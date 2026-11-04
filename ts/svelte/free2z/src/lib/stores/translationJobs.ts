/**
 * The app's one translation-jobs store, wired to the real API.
 *
 * Module scope is the point: it outlives the editor route, so leaving the
 * editor does not stop the watching and coming back finds the jobs where they
 * were. On the server it is never written to — every entry point is a browser
 * action — so it cannot leak one visitor's jobs into another's render.
 */
import { browser } from "$app/env";
import { createTranslationJobs } from "$lib/translation-jobs";
import { currentUser } from "$lib/stores/auth";
import { translationJobsInUse } from "$lib/stores/translationJobsInUse";
import { listTranslationJobs } from "$lib/api/zpage-translations";
import {
  TRANSLATION_POLL_INTERVAL_MS,
  TRANSLATION_POLL_TIMEOUT_MS,
} from "$lib/zpage-translation-purchase.js";

type StatusAnswer = Awaited<
  ReturnType<typeof import("$lib/api/zpage/zpage").zpageTranslationStatus>
> & { status: string };

function browserStorage(): Storage | null {
  if (!browser) return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const translationJobs = createTranslationJobs({
  list: (page) => listTranslationJobs(page),
  storage: browserStorage(),
  // The generated zPage client is loaded on first use, never with the root
  // layout that mounts this store: it is 1,400 lines no page outside
  // the editor needs, and statically importing it here put it on every page's
  // critical path. Only a page with a job to watch ever asks for a status, and
  // that page is the editor, which has it loaded already.
  status: async (page, language) => {
    const { zpageTranslationStatus } = await import("$lib/api/zpage/zpage");
    return (await zpageTranslationStatus(page, language, {
      timeoutMs: 20_000,
    })) as StatusAnswer;
  },
  pollIntervalMs: TRANSLATION_POLL_INTERVAL_MS,
  pollTimeoutMs: TRANSLATION_POLL_TIMEOUT_MS,
});

if (browser) {
  // Loading this module means the editor (or the notifier) is using it: the
  // root layout may now mount the app-wide notifier.
  translationJobsInUse.set(true);

  // Jobs belong to ONE account. Session expiry and the in-place sign-in modal
  // can change who is signed in without reloading the document; the previous
  // creator's articles, prices and refunds must not stay on screen or be
  // announced under the next one (codex adversarial review). `reset` also
  // makes every read still in flight for the old account land nowhere.
  // Only a change AWAY from a signed-in account resets: auth resolving
  // (nobody → someone) on page load is the same creator, not a switch.
  let owner: string | null = null;
  currentUser.subscribe((creator) => {
    const next = creator?.username ?? null;
    if (owner && next !== owner) translationJobs.reset();
    if (next) owner = next;
    else if (owner) owner = null;
  });
}
