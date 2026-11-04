/**
 * The accounts the signed-in reader has blocked.
 *
 * The API already stops serving a blocked account's comments, zPages and
 * notifications to the blocker on every request that carries the reader's
 * session. Some lists are rendered WITHOUT it: the homepage is cached and
 * shared, and SSR loaders fetch public lists anonymously. Those cards reach
 * the browser unfiltered, so the card components consult this store and
 * render a placeholder instead.
 *
 * Loaded once per signed-in account from `GET /api/g12f/blocks/mine/`, kept
 * in step by the block/unblock control, and emptied on sign-out. Usernames
 * compare case-insensitively, like the API's `username__iexact` routes.
 */
import { browser } from "$app/env";
import { derived, get, writable } from "svelte/store";
import { g12fBlocksMineList } from "$lib/api/g12f/g12f";
import { currentUser } from "$lib/stores/auth";

/** Server maximum (Free2zPagination.max_page_size). */
const PAGE_SIZE = 48;
/** Per-request deadline (ms): a stalled request must fail into a retry. */
const REQUEST_TIMEOUT_MS = 15_000;
/** A load re-runs at most this many times when blocks change under it. */
const MAX_RECONCILES = 3;
/** Retries after a failed load, with these delays (ms). */
export const RETRY_DELAYS_MS = [2_000, 10_000, 30_000];

type BlockState = { owner: string | null; usernames: ReadonlySet<string> };

const state = writable<BlockState>({ owner: null, usernames: new Set() });

/**
 * Blocks/unblocks the reader made in THIS tab since the list load started.
 * A load is a snapshot that can be older than such a change (page one lists
 * Alice, the reader unblocks Alice, page two lands), so the reader's own
 * changes always win over whatever a load returns.
 */
let localChanges = new Map<string, boolean>();
let generation = 0;
/** The owner whose last load gave up after its retries, if any. */
let failedOwner: string | null = null;
/** Bumped by every local block/unblock; see `blockRevision`. */
let revision = 0;

/**
 * A counter that moves on every block/unblock made in this tab. A read that
 * started before a change must not be applied after it -- whichever
 * component made the read, and whether or not it still exists.
 */
export function blockRevision(): number {
  return revision;
}

export const blockedUsernames = derived(state, ($state) => $state.usernames);

function normalize(username: string): string {
  return username.trim().toLowerCase();
}

/** Has the reader blocked `username`? Pass the store's current value. */
export function isBlockedIn(
  usernames: ReadonlySet<string>,
  username: string | null | undefined,
): boolean {
  return !!username && usernames.has(normalize(username));
}

function publish(owner: string, found: Iterable<string>) {
  state.update((current) => {
    if (current.owner !== owner) return current;
    const usernames = new Set([...current.usernames, ...found]);
    for (const [name, blocked] of localChanges) {
      if (blocked) usernames.add(name);
      else usernames.delete(name);
    }
    return { owner, usernames };
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Load the block list for `owner`, page by page, until the server says there
 * is no next page. Never throws. Pages that arrived are kept even when a
 * later one fails, and a failed load is retried a bounded number of times.
 */
export async function loadBlocksFor(
  owner: string,
  retryDelays: readonly number[] = RETRY_DELAYS_MS,
): Promise<void> {
  const mine = generation;
  const current = () => mine === generation && get(state).owner === owner;
  let reconciles = 0;
  for (let attempt = 0; ; attempt++) {
    let failed = false;
    const revisionAtStart = revision;
    try {
      // Bounded by the server's own `count`, so a misbehaving `next` cannot
      // loop forever; there is no client-side cap on how many blocks load.
      let pages = 1;
      for (let page = 1; page <= pages; page++) {
        const body = await g12fBlocksMineList(
          { page, page_size: PAGE_SIZE },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        );
        if (!current()) return;
        pages = Math.max(pages, Math.ceil((body?.count ?? 0) / PAGE_SIZE));
        publish(
          owner,
          (body?.results ?? [])
            .map((row) => row?.username)
            .filter((name): name is string => !!name)
            .map(normalize),
        );
        if (!body?.next) break;
      }
    } catch {
      failed = true;
    }
    if (!failed) {
      // Page-number pages are newest-first, so a block/unblock during the
      // load shifts every later page by one and can skip a row entirely.
      // Read the whole list again (bounded) rather than trust that one.
      if (revision !== revisionAtStart && reconciles < MAX_RECONCILES) {
        reconciles += 1;
        attempt -= 1;
        continue;
      }
      if (failedOwner === owner) failedOwner = null;
      return;
    }
    if (attempt >= retryDelays.length) {
      // Out of retries. Not final: the next auth revalidation, a return to
      // the tab, or the network coming back tries again (`retryFailedLoad`).
      failedOwner = owner;
      return;
    }
    await sleep(retryDelays[attempt]);
    if (!current()) return;
  }
}

/**
 * Reflect a block/unblock the reader just made, without a reload.
 *
 * Pass `reader` -- the account signed in when the write or read was STARTED
 * -- from anything that awaited the network first. If a different account
 * owns the store by the time the answer lands (sign-out, or a sign-in as
 * someone else in another tab), the answer is about the previous account's
 * block list and is dropped; the new account's own list load is the truth.
 */
export function setLocallyBlocked(
  username: string,
  blocked: boolean,
  reader?: string | null,
): void {
  if (reader !== undefined) {
    const expected = reader ? normalize(reader) : null;
    if (expected === null || expected !== get(state).owner) return;
  }
  const name = normalize(username);
  revision += 1;
  localChanges.set(name, blocked);
  state.update((current) => {
    const usernames = new Set(current.usernames);
    if (blocked) usernames.add(name);
    else usernames.delete(name);
    return { ...current, usernames };
  });
}

/** Follow the signed-in account: load on sign-in, clear on sign-out. */
export function trackSignedInAccount(
  username: string | null | undefined,
  retryDelays: readonly number[] = RETRY_DELAYS_MS,
) {
  const owner = username ? normalize(username) : null;
  if (owner === get(state).owner) {
    if (owner && failedOwner === owner) retryFailedLoad(retryDelays);
    return;
  }
  failedOwner = null;
  generation += 1;
  localChanges = new Map();
  state.set({ owner, usernames: new Set() });
  if (owner) void loadBlocksFor(owner, retryDelays);
}

/** Reload a list whose load gave up, for the same signed-in reader. */
export function retryFailedLoad(
  retryDelays: readonly number[] = RETRY_DELAYS_MS,
) {
  const owner = get(state).owner;
  if (!owner || failedOwner !== owner) return;
  failedOwner = null;
  void loadBlocksFor(owner, retryDelays);
}

if (browser) {
  currentUser.subscribe((user) => trackSignedInAccount(user?.username));
  window.addEventListener("online", () => retryFailedLoad());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") retryFailedLoad();
  });
}
