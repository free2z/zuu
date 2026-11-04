/**
 * Whether this tab has touched the translation jobs store yet.
 *
 * The root layout reads this, and only this, to decide whether to load the
 * app-wide jobs notifier at all. It is its own tiny module on purpose: the
 * notifier pulls in the jobs store and its API client, and a reader who never
 * opens the editor should download none of it.
 */
import { writable } from "svelte/store";

export const translationJobsInUse = writable(false);
