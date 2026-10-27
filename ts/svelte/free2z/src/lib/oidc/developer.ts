/**
 * The developer console's form model (; zuu docs/free2z/sdk/spec/oidc.md §2).
 *
 * The console edits text; the API takes lists and basis points. The
 * conversions live here, import-free, so `tests/oidc-developer.test.mjs`
 * pins them without a browser — in particular that a markup typed as a
 * percentage reaches the server as the basis points the developer meant.
 */

/** The platform cap on a developer markup (scopes.MARKUP_CAP_BPS). */
export const MARKUP_CAP_BPS = 5000;

/** The column's bound (developer.MAX_DEFAULT_SPEND_CAP_2Z, a PositiveIntegerField). */
export const MAX_DEFAULT_SPEND_CAP_2Z = 2_147_483_647;

export const ALL_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "balance:read",
  "purchase:create",
  "ai:invoke",
] as const;

export type ClientType = "public" | "confidential";
export type FormCapPeriod = "day" | "week" | "month" | "total";

export interface AppForm {
  name: string;
  clientType: ClientType;
  redirectUris: string;
  allowedScopes: string[];
  allowedOrigins: string;
  markupPercent: string;
  defaultCap: string;
  defaultCapPeriod: FormCapPeriod;
  logoUrl: string;
  privacyUrl: string;
  termsUrl: string;
  /** Directed to children or to all ages (zuu docs/free2z/sdk/CHILD-DIRECTED.md). */
  childDirected: boolean;
}

/** What the API returns for an app (the subset the form reads). */
export interface AppLike {
  name: string;
  client_type: ClientType;
  redirect_uris: string[];
  allowed_scopes?: string[];
  allowed_origins?: string[];
  markup_bps?: number;
  default_spend_cap_2z?: number | null;
  default_cap_period?: string;
  logo_url?: string;
  privacy_url?: string;
  terms_url?: string;
  child_directed?: boolean;
}

export function emptyForm(): AppForm {
  return {
    name: "",
    clientType: "public",
    redirectUris: "",
    allowedScopes: ["openid", "profile"],
    allowedOrigins: "",
    markupPercent: "0",
    defaultCap: "",
    defaultCapPeriod: "month",
    logoUrl: "",
    privacyUrl: "",
    termsUrl: "",
    childDirected: false,
  };
}

/** Basis points as the percentage text the form shows: 2000 → "20". */
export function bpsToPercentText(bps: number | undefined | null): string {
  const value = Math.max(0, Number(bps) || 0);
  return String(value / 100);
}

/**
 * A typed percentage as basis points, or `null` when it is not a number
 * from 0 to the platform cap with at most two decimals ("12.5" → 1250).
 * Decimal text is parsed digit by digit, never through a float, so
 * "0.29" is 29 and not 28.999….
 */
export function percentToBps(text: string): number | null {
  const raw = String(text ?? "")
    .trim()
    .replace(",", ".");
  if (raw === "") return 0;
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const bps = whole * 100 + fraction;
  return bps <= MARKUP_CAP_BPS ? bps : null;
}

/** An optional whole number of 2Z: "" → null, "250" → 250, else undefined (invalid). */
export function parseOptionalCap(text: string): number | null | undefined {
  const raw = String(text ?? "").trim();
  if (raw === "") return null;
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= MAX_DEFAULT_SPEND_CAP_2Z
    ? value
    : undefined;
}

export function lines(text: string): string[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const PERIODS: readonly string[] = ["day", "week", "month", "total"];

export function formFromApp(app: AppLike): AppForm {
  return {
    name: app.name ?? "",
    clientType: app.client_type,
    redirectUris: (app.redirect_uris ?? []).join("\n"),
    allowedScopes: [...(app.allowed_scopes ?? [])],
    allowedOrigins: (app.allowed_origins ?? []).join("\n"),
    markupPercent: bpsToPercentText(app.markup_bps),
    defaultCap:
      app.default_spend_cap_2z === null ||
      app.default_spend_cap_2z === undefined
        ? ""
        : String(app.default_spend_cap_2z),
    defaultCapPeriod: PERIODS.includes(app.default_cap_period ?? "")
      ? (app.default_cap_period as FormCapPeriod)
      : "month",
    logoUrl: app.logo_url ?? "",
    privacyUrl: app.privacy_url ?? "",
    termsUrl: app.terms_url ?? "",
    childDirected: app.child_directed === true,
  };
}

export type FormProblem =
  | "name"
  | "markup"
  | "defaultCap"
  | "origins"
  | "logoUrl"
  | "privacyUrl"
  | "termsUrl";

export type PayloadResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; problems: FormProblem[] };

/**
 * The JSON body for a create (`includeClientType`) or an edit. The client
 * type is fixed at registration, so an edit never sends it. Redirect URIs
 * are validated separately (`validateRedirectUris`) so each line gets its
 * own message; this only checks the fields it converts.
 *
 * `original` is the app being edited. The  origin and https-link
 * checks judge a field only when it is new or changed — the server's rule
 * (`F2ZApplication._policy_judges`), so an app registered before them stays
 * editable without first fixing an unrelated legacy link.
 */
export function payloadFromForm(
  form: AppForm,
  includeClientType: boolean,
  original?: AppLike | null,
): PayloadResult {
  const problems: FormProblem[] = [];
  const name = form.name.trim();
  if (!name) problems.push("name");
  const markup = percentToBps(form.markupPercent);
  if (markup === null) problems.push("markup");
  const cap = parseOptionalCap(form.defaultCap);
  if (cap === undefined) problems.push("defaultCap");
  const origins =
    form.clientType === "public" ? lines(form.allowedOrigins) : [];
  const originsUnchanged =
    Boolean(original) &&
    origins.join(" ") === (original?.allowed_origins ?? []).join(" ");
  if (
    !originsUnchanged &&
    origins.some((origin) => !originVerdict(origin).ok)
  ) {
    problems.push("origins");
  }
  const links: [FormProblem, string, string | undefined][] = [
    ["logoUrl", form.logoUrl.trim(), original?.logo_url],
    ["privacyUrl", form.privacyUrl.trim(), original?.privacy_url],
    ["termsUrl", form.termsUrl.trim(), original?.terms_url],
  ];
  for (const [problem, value, before] of links) {
    const unchanged = Boolean(original) && value === (before ?? "");
    if (!unchanged && !isAcceptableMetadataUrl(value)) problems.push(problem);
  }
  if (problems.length) return { ok: false, problems };

  const payload: Record<string, unknown> = {
    name,
    redirect_uris: lines(form.redirectUris),
    allowed_scopes: ALL_SCOPES.filter((s) => form.allowedScopes.includes(s)),
    allowed_origins: origins,
    markup_bps: markup,
    default_spend_cap_2z: cap,
    default_cap_period: form.defaultCapPeriod,
    logo_url: form.logoUrl.trim(),
    privacy_url: form.privacyUrl.trim(),
    terms_url: form.termsUrl.trim(),
    child_directed: form.childDirected,
  };
  if (includeClientType) payload.client_type = form.clientType;
  return { ok: true, payload };
}

/**
 * Registrable domains that are Free2Z's (`registration_policy.FIRST_PARTY_SITES`).
 * A browser app on one of them, or under one, is same-site with Free2Z and
 * would receive its cookies, so the server refuses it.
 */
export const FIRST_PARTY_SITES = [
  "free2z.cash",
  "free2z.com",
  "free2z.net",
  "free2give.xyz",
] as const;

export type OriginProblem =
  | "whitespace"
  | "query"
  | "fragment"
  | "notHttps"
  | "credentials"
  | "path"
  | "noHost"
  | "sameSite"
  | "notCanonical";

export type OriginVerdict =
  { ok: true } | { ok: false; problem: OriginProblem; canonical?: string };

export function isFirstPartySite(host: string): boolean {
  const name = host.trim().replace(/\.+$/, "").toLowerCase();
  return FIRST_PARTY_SITES.some(
    (site) => name === site || name.endsWith(`.${site}`),
  );
}

/**
 * One allowed-origin line, judged the way the server's
 * `registration_policy.origin_problem` does: exactly `https://host[:port]`
 * as a browser sends it in `Origin` — lowercase, no default port, no path,
 * query, fragment or credentials, and not on a Free2Z domain. The server
 * stays the authority; this only says what is wrong before a round trip.
 */
export function originVerdict(origin: string): OriginVerdict {
  const text = String(origin ?? "");
  if (!text || /\s/.test(text)) return { ok: false, problem: "whitespace" };
  if (text.includes("?")) return { ok: false, problem: "query" };
  if (text.includes("#")) return { ok: false, problem: "fragment" };
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(.*)$/.exec(text);
  if (!match || match[1].toLowerCase() !== "https") {
    return { ok: false, problem: "notHttps" };
  }
  const netloc = match[2];
  const rest = match[3];
  if (netloc.includes("@")) return { ok: false, problem: "credentials" };
  if (rest) return { ok: false, problem: "path" };
  if (!netloc || netloc.startsWith(":")) {
    return { ok: false, problem: "noHost" };
  }
  // The browser's own serialization (WHATWG URL) IS what `Origin` carries:
  // punycode for an internationalized host, a compressed IPv6 literal,
  // dotted-quad IPv4 ("127.1" is 127.0.0.1), percent-escapes decoded, no
  // default port. Judge the same-site rule on it and suggest it verbatim.
  let parsed: URL;
  try {
    parsed = new URL(`https://${netloc}`);
  } catch {
    return { ok: false, problem: "noHost" };
  }
  if (!parsed.hostname) return { ok: false, problem: "noHost" };
  if (isFirstPartySite(parsed.hostname)) {
    return { ok: false, problem: "sameSite" };
  }
  const canonical = parsed.origin;
  if (text !== canonical) {
    return { ok: false, problem: "notCanonical", canonical };
  }
  return { ok: true };
}

/** Every origin line with its verdict, in order. */
export function validateOrigins(
  origins: string[],
): { origin: string; verdict: OriginVerdict }[] {
  return origins.map((origin) => ({ origin, verdict: originVerdict(origin) }));
}

/**
 * A consent-screen link (logo, privacy policy, terms): empty, or an https
 * URL with a host and no credentials. The server refuses anything
 * else; the consent page never shows a non-https one either way.
 */
export function isAcceptableMetadataUrl(url: string): boolean {
  const text = String(url ?? "").trim();
  if (!text) return true;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    Boolean(parsed.hostname) &&
    !parsed.username &&
    !parsed.password
  );
}
