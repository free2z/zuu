import { isTauri, invoke } from "@tauri-apps/api/core";
import { nativeDiagnosticsReport } from "@free2z/wallet-shared";

/** No arguments, arbitrary paths, event listeners or cross-surface transport. */
export async function readNativeDiagnostics(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return nativeDiagnosticsReport(await invoke<unknown>("native_diagnostics_report"));
  } catch {
    return null;
  }
}
