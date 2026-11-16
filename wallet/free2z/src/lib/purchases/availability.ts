import policy from "./policy.json";

/** Native injection is immutable; the bundled target flag covers early startup.
 * Neither user agent, locale, session nor a remote flag can enable purchases. */
export function digitalPurchasesUnavailable(): boolean {
  return import.meta.env.TAURI_ENV_PLATFORM === "android" ||
    (typeof window !== "undefined" &&
      (window as unknown as Record<string, unknown>).__FREE2Z_ANDROID_PURCHASES_UNAVAILABLE__ === true);
}

export class DigitalPurchaseUnavailableError extends Error {
  constructor() {
    super("Digital purchases are unavailable in this Android app.");
    this.name = "DigitalPurchaseUnavailableError";
  }
}

export function assertDigitalPurchaseAvailable(): void {
  if (digitalPurchasesUnavailable()) throw new DigitalPurchaseUnavailableError();
}

/** Same inventory is compiled into the native HTTP bridge. Recovery endpoints
 * are deliberately absent: a receipt is never permission to start a purchase. */
export function isDigitalPurchaseRequest(value: string, method = "GET"): boolean {
  const url = new URL(value, "https://free2z.cash");
  let path: string;
  try { path = decodeURIComponent(url.pathname).replace(/\/+$/, "").toLowerCase(); }
  catch { return true; }
  // Encoded separators/dot segments and ambiguous paths are unnecessary for
  // these API routes. Refuse them rather than interpret differently from Django.
  if (path.includes("%") || path.includes("//") || path.includes("\\") || path.split("/").some((part) => part === "." || part === "..")) return true;
  return policy.rules.some((rule) => {
    const prefix = rule.prefix.replace(/\/+$/, "");
    return (path === prefix || path.startsWith(`${prefix}/`)) &&
      (!("suffix" in rule) || path.endsWith(rule.suffix ?? "")) &&
      (!("contains" in rule) || path.includes(rule.contains ?? "")) &&
      (rule.methods.includes("*") || rule.methods.includes(method.toUpperCase()));
  });
}
