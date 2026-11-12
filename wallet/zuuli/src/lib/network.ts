import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./platform";
export interface TorStatus { enabled: boolean; suspended: boolean; epoch: number; state: string }
export const torStatus = () => invoke<TorStatus>("tor_status");
export const torSet = (enabled: boolean) => invoke<TorStatus>("tor_set", { enabled });
export async function openNetworkUrl(url: string) {
  if (isTauri()) return invoke<void>("network_open", { url });
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  return openUrl(url);
}
export const nativeApiFetch: typeof fetch = async (input, init) => {
  init?.signal?.throwIfAborted();
  const request = new Request(input, init);
  const body = request.body ? Array.from(new Uint8Array(await request.arrayBuffer())) : null;
  const result = await invoke<{ status: number; body: string }>("api_request", {
    url: request.url, method: request.method,
    headers: Object.fromEntries(request.headers.entries()), body,
  });
  init?.signal?.throwIfAborted();
  return new Response(result.body || null, { status: result.status });
};
export function installNetworkLifecycle() {
  if (!isTauri()) return () => {};
  const suspend = () => { void invoke("tor_suspend"); };
  const visibility = () => { if (document.hidden) suspend(); };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("offline", suspend);
  window.addEventListener("online", suspend);
  return () => {
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("offline", suspend);
    window.removeEventListener("online", suspend);
  };
}
