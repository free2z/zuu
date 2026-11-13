import { openUrl } from "@tauri-apps/plugin-opener";
import { ACCOUNT_ORIGIN } from "./env";
import { isTauri, useMock } from "./platform";
import { auth } from "./api/free2z";
import { getTokenSnapshot } from "./api/http";
import { useSession } from "@/store/session";

/** Build only from deployment configuration, never from a return URL or receipt.
 * No amount, memo, token, callback, or invented SDK client_id crosses this link. */
export function accountBillingUrl(origin: string): string {
  const url = new URL(origin);
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("The account website origin is invalid.");
  }
  return new URL("/buy-2z", url).href;
}

export async function openAccountBilling(): Promise<void> {
  if (useMock()) throw new Error("Live account billing is unavailable in mock mode.");
  const url = accountBillingUrl(ACCOUNT_ORIGIN);
  if (isTauri()) await openUrl(url);
  else window.location.assign(url);
}

/** Read current credit, never settlement of a particular payment. No POST, send,
 * receipt replay, or arithmetic: retry and restart are read-only. A browser
 * session may belong to someone else, so don't import its identity or balance. */
export async function refreshBillingBalance(signal: AbortSignal): Promise<void> {
  if (useMock()) throw new Error("A mock balance cannot verify account funding.");
  const session = getTokenSnapshot();
  const username = useSession.getState().user?.username;
  if (!session.token || !username) throw new Error("Log in to check your balance.");
  const user = await auth.me(session.token, signal);
  const current = getTokenSnapshot();
  if (
    signal.aborted || current.token !== session.token ||
    current.generation !== session.generation ||
    useSession.getState().user?.username !== username || user.username !== username
  ) {
    throw new Error("The account changed. Check the signed-in account and retry.");
  }
  useSession.getState().setTuzis(user.tuzis);
}
