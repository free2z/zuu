/**
 * Contract B (#1022): opening e2e2z on someone's handle.
 *
 * ```text
 *   https://free2z.com/bridge/e2e2z/chat/#peer=<handle>     handle ∈ ^[a-z0-9_]{1,30}$
 * ```
 *
 * The free2z app, and the notification a chat request sends, link here. If
 * e2e2z is installed the verified App Link opens it; otherwise the same URL
 * opens free2z.com's "Install e2e2z" page.
 *
 * ## What the link may do
 *
 * Fill in first contact, and nothing else. It carries no authority, so it is
 * not an intent-bridge message, and it **never sends anything**: the person
 * holding the phone taps "Start chat" or doesn't. That is the whole security
 * argument for accepting a link anybody can craft. The worst a forged link can
 * do is put a handle in a text field.
 *
 * ## What the parser refuses
 *
 * Anything that is not exactly this route: another scheme, host or path, a
 * query component (`CALLER-AUTHENTICATION.md` §4.1 keeps payloads in the
 * fragment), any fragment key but `peer`, a repeated key, or a handle that
 * fails the pattern. Nothing is decoded, trimmed or case-folded, because the
 * directory's exact ASCII predicate is the boundary (`FirstContact.tsx`).
 *
 * The intent reply route, `/bridge/e2e2z/#res=…&rid=…`, has a different exact
 * path (`appLinkTransport.ts`'s `REPLY_PATH`), so neither parser can accept
 * the other's link.
 *
 * ## If the device is not enrolled yet
 *
 * The handle is kept as the *pending peer* and offered again once first
 * contact is available. Enrolling means a trip to ZUULI and possibly an
 * install, and the OS may end this process meanwhile, so it is kept in local
 * storage for a day. It is a handle this person chose to open and nothing
 * more; it never leaves the device.
 */

import { HANDLE_PATTERN } from "../messaging/types";
import { isTauri } from "../platform";

export const CHAT_LINK_HOST = "free2z.com";
export const CHAT_LINK_PATH = "/bridge/e2e2z/chat/";
const PEER_KEY = "peer";

export type ChatLink =
  /** A well-formed link to this route. */
  | { readonly kind: "peer"; readonly handle: string }
  /** This route, but malformed. Worth telling the user; never acted on. */
  | { readonly kind: "invalid" };

/**
 * Read a chat link.
 *
 * `null` means the URL is not addressed to this route at all — an intent
 * reply, a custom-scheme return, anything else — and must be left alone.
 */
export function parseChatLink(raw: string): ChatLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== CHAT_LINK_HOST) return null;
  if (url.pathname !== CHAT_LINK_PATH) return null;

  const invalid: ChatLink = { kind: "invalid" };
  if (url.username !== "" || url.password !== "" || url.port !== "") {
    return invalid;
  }
  // `URL.search` is "" for both no query and a bare "?", so the raw text is
  // checked as well: a link that ever carried a query is not this contract.
  if (url.search !== "" || raw.includes("?")) return invalid;

  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : "";
  const pairs = fragment.split("&");
  if (pairs.length !== 1) return invalid;
  const [pair] = pairs as [string];
  const at = pair.indexOf("=");
  if (at <= 0 || pair.slice(0, at) !== PEER_KEY) return invalid;
  const handle = pair.slice(at + 1);
  if (!HANDLE_PATTERN.test(handle)) return invalid;
  return { kind: "peer", handle };
}

// ---------------------------------------------------------------------------
// The pending peer
// ---------------------------------------------------------------------------

/** A handle a link asked to open, waiting for first contact. */
export interface PendingPeer {
  readonly handle: string;
  /** When the link arrived, milliseconds since the epoch. */
  readonly receivedAt: number;
  /**
   * Increases on every delivery, so opening the same link twice still counts
   * as a second request to show it.
   */
  readonly sequence: number;
}

/** The chat-link state the screen renders. */
export interface ChatLinkState {
  readonly pending: PendingPeer | null;
  /** A link to this route arrived malformed. */
  readonly rejected: boolean;
}

export const PENDING_PEER_STORAGE_KEY = "e2e2z.pending-peer.v1";

/** How long a pending peer survives a process that is ended meanwhile. */
export const PENDING_PEER_TTL_MS = 24 * 60 * 60 * 1000;

let sequence = 0;
let state: ChatLinkState = { pending: null, rejected: false };
const listeners = new Set<() => void>();

function publish(next: ChatLinkState): void {
  state = next;
  for (const listener of listeners) listener();
}

function persist(pending: PendingPeer | null): void {
  try {
    if (pending === null) {
      globalThis.localStorage?.removeItem(PENDING_PEER_STORAGE_KEY);
    } else {
      globalThis.localStorage?.setItem(
        PENDING_PEER_STORAGE_KEY,
        JSON.stringify({ handle: pending.handle, receivedAt: pending.receivedAt }),
      );
    }
  } catch {
    // Storage is a convenience here. The in-memory copy still works.
  }
}

/** Read a pending peer a previous process left, if it is still fresh. */
export function restorePendingPeer(now: number = Date.now()): void {
  let stored: unknown;
  try {
    const raw = globalThis.localStorage?.getItem(PENDING_PEER_STORAGE_KEY);
    if (!raw) return;
    stored = JSON.parse(raw);
  } catch {
    persist(null);
    return;
  }
  const record = stored as { handle?: unknown; receivedAt?: unknown } | null;
  const fresh =
    record !== null &&
    typeof record === "object" &&
    typeof record.handle === "string" &&
    HANDLE_PATTERN.test(record.handle) &&
    typeof record.receivedAt === "number" &&
    record.receivedAt <= now &&
    now - record.receivedAt < PENDING_PEER_TTL_MS;
  if (!fresh) {
    persist(null);
    return;
  }
  sequence += 1;
  publish({
    pending: {
      handle: record.handle as string,
      receivedAt: record.receivedAt as number,
      sequence,
    },
    rejected: state.rejected,
  });
}

/**
 * Handle one delivered URL. Returns whether it was addressed to this route.
 */
export function deliverChatLink(raw: string, now: number = Date.now()): boolean {
  const link = parseChatLink(raw);
  if (link === null) return false;
  if (link.kind === "invalid") {
    publish({ pending: state.pending, rejected: true });
    return true;
  }
  sequence += 1;
  const pending: PendingPeer = {
    handle: link.handle,
    receivedAt: now,
    sequence,
  };
  persist(pending);
  publish({ pending, rejected: false });
  return true;
}

/** First contact now shows the handle, or the user dismissed it. */
export function clearPendingPeer(): void {
  persist(null);
  publish({ pending: null, rejected: state.rejected });
}

/** The user has read the malformed-link notice. */
export function dismissRejectedChatLink(): void {
  publish({ pending: state.pending, rejected: false });
}

export function subscribeChatLinks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function chatLinkSnapshot(): ChatLinkState {
  return state;
}

const LAUNCH_SEEN_KEY = "e2e2z.chat-link.launch-seen.v1";

function launchUrlSeen(url: string): boolean {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return false;
    if (storage.getItem(LAUNCH_SEEN_KEY) === url) return true;
    storage.setItem(LAUNCH_SEEN_KEY, url);
  } catch {
    // Without session storage a reload may offer the handle again. Harmless.
  }
  return false;
}

/**
 * Listen for chat links: the one that launched the app (`getCurrent`) and every
 * one after it (`onOpenUrl`). The pattern is `wallet/free2z`'s
 * `listenForCheckoutReturns`.
 *
 * Installed in any native runtime. On desktop no association exists, so
 * nothing arrives, which is harmless.
 */
export function installChatLinkListener(): void {
  restorePendingPeer();
  if (!isTauri()) return;
  void (async () => {
    try {
      const { getCurrent, onOpenUrl } = await import(
        "@tauri-apps/plugin-deep-link"
      );
      await onOpenUrl((urls) => {
        for (const url of urls) deliverChatLink(url);
      });
      // `getCurrent` answers the launch URL again after a webview reload, when
      // it has already been shown once; this session remembers that.
      for (const url of (await getCurrent()) ?? []) {
        if (launchUrlSeen(url)) continue;
        deliverChatLink(url);
      }
    } catch {
      // No deep-link plugin in this runtime. Typing the handle still works.
    }
  })();
}

/** Forget everything. For tests. */
export function resetChatLinksForTests(): void {
  sequence = 0;
  state = { pending: null, rejected: false };
  listeners.clear();
  persist(null);
}
