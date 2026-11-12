import { isTauri } from "@/lib/platform";

/** A link selects local wallet history; it never supplies transaction state,
 * attribution, a payment, or a destination. Unknown txids remain unknown.
 */
export function parseWalletHistoryLink(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.origin !== "https://free2z.com" ||
    url.username ||
    url.password ||
    url.pathname !== "/bridge/zuuli/" ||
    url.search
  )
    return null;
  const match = /^#history=(all|[0-9a-f]{64})$/.exec(url.hash);
  if (!match) return null;
  return match[1] === "all"
    ? "/wallet/history"
    : `/wallet/history?txid=${match[1]}`;
}
export async function listenForWalletHistoryLinks(
  navigate: (path: string) => void,
): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { getCurrent, onOpenUrl } = await import(
    "@tauri-apps/plugin-deep-link"
  );
  const process = (urls: string[]) => {
    for (const raw of urls) {
      const path = parseWalletHistoryLink(raw);
      if (path) navigate(path);
    }
  };
  const stop = await onOpenUrl(process);
  try {
    const urls = await getCurrent();
    if (urls) process(urls);
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
