/**
 * The consent screen's decisions, as pure functions (zuu
 * docs/free2z/sdk/spec/oidc.md §5).
 *
 * No imports on purpose: `tests/oidc-consent.test.mjs` loads this file
 * directly under node's type stripping, so what the page submits is pinned
 * without a browser.
 *
 * The one rule this module exists to keep: **a consent that grants
 * `ai:invoke` always carries an explicit spend cap** — a number, or `null`
 * meaning "no cap" that the user chose. The backend refuses a first consent
 * without one (400), but a page that forgot the key would otherwise inherit
 * whatever the server defaulted to, and on a re-consent an absent key
 * silently keeps the old cap. `buildConsentDecision` throws instead of
 * guessing.
 */

export type CapPeriod = "day" | "week" | "month" | "total";

export const CAP_PERIODS: readonly CapPeriod[] = [
  "day",
  "week",
  "month",
  "total",
];

/** The cap as the backend spells it: whole 2Z, `null` = no cap. */
export interface SpendCap {
  spend_cap_2z: number | null;
  cap_period: CapPeriod;
}

/**
 * What the user picked in the cap control. `preselected` is the backend's
 * optional suggestion (or prepaid balance without an extra budget); moving off it is always
 * an explicit act.
 */
export type CapChoice =
  | { kind: "preselected" }
  | { kind: "custom"; amount: string; period: CapPeriod }
  | { kind: "none" }
  /**
   * The user's existing grant, kept as it is: offered beside an
   * app's lower suggestion. Not custom input, so a grant above
   * MAX_CUSTOM_CAP_2Z can still be kept.
   */
  | { kind: "current"; cap: SpendCap };

/** Custom amounts are bounded so a typo cannot become an absurd cap. */
export const MAX_CUSTOM_CAP_2Z = 10_000_000;

/** A whole number of 2Z from 1 to MAX_CUSTOM_CAP_2Z, or `null`. */
export function parseCapAmount(raw: string): number | null {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CUSTOM_CAP_2Z) {
    return null;
  }
  return value;
}

export function isCapPeriod(value: unknown): value is CapPeriod {
  return (CAP_PERIODS as readonly unknown[]).includes(value);
}

export type CapResolution =
  | { ok: true; cap: SpendCap }
  | { ok: false; reason: "amount" | "confirmNoCap" };

/**
 * The cap the POST will carry, or why it cannot be sent yet.
 *
 * "No cap" needs `noCapConfirmed` unless the pre-selection already was no
 * cap (a new prepaid-balance consent or an unchanged earlier choice): lifting the
 * limit is the one choice that lets an app spend every 2Z credit on the
 * account, so it takes a second, deliberate click.
 */
export function resolveCap(
  choice: CapChoice,
  preselected: SpendCap,
  noCapConfirmed: boolean,
): CapResolution {
  switch (choice.kind) {
    case "current":
      return {
        ok: true,
        cap: {
          spend_cap_2z: choice.cap.spend_cap_2z,
          cap_period: choice.cap.cap_period,
        },
      };
    case "preselected":
      return {
        ok: true,
        cap: {
          spend_cap_2z: preselected.spend_cap_2z,
          cap_period: preselected.cap_period,
        },
      };
    case "custom": {
      const amount = parseCapAmount(choice.amount);
      if (amount === null || !isCapPeriod(choice.period)) {
        return { ok: false, reason: "amount" };
      }
      return {
        ok: true,
        cap: { spend_cap_2z: amount, cap_period: choice.period },
      };
    }
    case "none":
      if (preselected.spend_cap_2z !== null && !noCapConfirmed) {
        return { ok: false, reason: "confirmNoCap" };
      }
      return {
        ok: true,
        cap: { spend_cap_2z: null, cap_period: preselected.cap_period },
      };
  }
}

/**
 * Spec §5, mirrored from `dj.apps.oidc.consent.is_cap_raise`: a change is a
 * raise when it can increase what the app may spend in ANY window — a higher
 * amount, removing the cap, or ANY change of period (the ledger counts spend
 * per window, so a new period starts an empty one: "100 a month" already
 * spent → "100 in total" is a fresh 100, ). A cap of 0 admits nothing
 * and is never a raise. Used only to warn that the backend will ask for a
 * fresh sign-in; the backend decides.
 */
export function isCapRaise(previous: SpendCap, next: SpendCap): boolean {
  if (previous.spend_cap_2z === null) return false;
  if (next.spend_cap_2z === null) return true;
  if (next.spend_cap_2z === 0) return false;
  if (next.spend_cap_2z > previous.spend_cap_2z) return true;
  return next.cap_period !== previous.cap_period;
}

/**
 * The spending-limit editor on `/account/apps`: a limit (amount +
 * period) or no limit. Starts on the grant's current cap.
 */
export interface CapEdit {
  kind: "limit" | "none";
  amount: string;
  period: CapPeriod;
  noCapConfirmed: boolean;
}

export function capEditFrom(current: SpendCap): CapEdit {
  return {
    kind: current.spend_cap_2z === null ? "none" : "limit",
    amount: current.spend_cap_2z === null ? "" : String(current.spend_cap_2z),
    period: isCapPeriod(current.cap_period) ? current.cap_period : "month",
    noCapConfirmed: false,
  };
}

/**
 * The cap the editor would send, or why it cannot yet. The same rules as
 * the consent screen (`resolveCap`): an amount is a whole number of 2Z from
 * 1, and moving to "no limit" from a limit takes the confirmation.
 */
export function resolveCapEdit(
  edit: CapEdit,
  current: SpendCap,
): CapResolution {
  if (edit.kind === "none") {
    return resolveCap({ kind: "none" }, current, edit.noCapConfirmed);
  }
  return resolveCap(
    { kind: "custom", amount: edit.amount, period: edit.period },
    current,
    edit.noCapConfirmed,
  );
}

export function sameCap(a: SpendCap, b: SpendCap): boolean {
  return a.spend_cap_2z === b.spend_cap_2z && a.cap_period === b.cap_period;
}

/**
 * The PUT body for `/api/oauth/grants/<id>/cap/`: both keys, always — the
 * cap never fails open, so "no limit" is an explicit `null`.
 */
export function capUpdateBody(cap: SpendCap): {
  spend_cap_2z: number | null;
  cap_period: CapPeriod;
} {
  if (
    !isCapPeriod(cap.cap_period) ||
    !(
      cap.spend_cap_2z === null ||
      (Number.isSafeInteger(cap.spend_cap_2z) && cap.spend_cap_2z >= 0)
    )
  ) {
    throw new MissingCapDecisionError();
  }
  return { spend_cap_2z: cap.spend_cap_2z, cap_period: cap.cap_period };
}

/**
 * A fresh sign-in was already made for this page (the return trip carries
 * {@link REAUTH_MARKER}) and the backend STILL asks for one: stop offering
 * another sign-in, which would only loop.
 */
export function stepUpPhase(search: URLSearchParams): "stepUp" | "stepUpLoop" {
  return search.get(REAUTH_MARKER) === "1" ? "stepUpLoop" : "stepUp";
}

export interface ConsentDecisionInput {
  requestId: string;
  authorizationRequest: Record<string, unknown>;
  allow: boolean;
  /** True when the request includes `ai:invoke` (the backend's `cap_required`). */
  capRequired: boolean;
  /** The resolved cap; REQUIRED when approving with `capRequired`. */
  cap?: SpendCap;
}

export interface ConsentDecisionBody {
  request_id: string;
  authorization_request: Record<string, unknown>;
  allow: boolean;
  spend_cap_2z?: number | null;
  cap_period?: CapPeriod;
}

export class MissingCapDecisionError extends Error {
  constructor() {
    super("ai:invoke consent needs an explicit spend cap decision");
    this.name = "MissingCapDecisionError";
  }
}

/**
 * The `POST /api/oauth/authorize` body.
 *
 * A denial carries no cap. An approval that grants `ai:invoke` ALWAYS
 * carries `spend_cap_2z` (possibly `null`) and `cap_period`; without a
 * resolved cap this throws rather than send a body the server would read as
 * "keep whatever was there".
 */
export function buildConsentDecision(
  input: ConsentDecisionInput,
): ConsentDecisionBody {
  const body: ConsentDecisionBody = {
    request_id: input.requestId,
    authorization_request: input.authorizationRequest,
    allow: input.allow,
  };
  if (!input.allow || !input.capRequired) return body;
  const cap = input.cap;
  if (
    !cap ||
    !isCapPeriod(cap.cap_period) ||
    !(
      cap.spend_cap_2z === null ||
      (Number.isSafeInteger(cap.spend_cap_2z) && cap.spend_cap_2z >= 0)
    )
  ) {
    throw new MissingCapDecisionError();
  }
  body.spend_cap_2z = cap.spend_cap_2z;
  body.cap_period = cap.cap_period;
  return body;
}

/**
 * Basis points as a percentage string for display: 2000 → "20",
 * 250 → "2.5", 1 → "0.01". Locale-aware when a locale is given.
 */
export function markupPercent(bps: number, locale?: string): string {
  const value = Math.max(0, Number(bps) || 0) / 100;
  try {
    return new Intl.NumberFormat(locale || "en", {
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return String(value);
  }
}

/** The authorization parameters the backend reads (views.AUTHORIZATION_PARAMETERS). */
export const AUTHORIZATION_PARAMETERS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "nonce",
  "prompt",
  "max_age",
  "acr_values",
  "login_hint",
  "ui_locales",
  "response_mode",
  "f2z_login_ticket",
  "f2z_spend_cap",
  "f2z_spend_period",
] as const;

/**
 * The app's optional spend-cap hint: the backend clamps it to the
 * registration's default and to the existing grant and returns the result as
 * `spend_cap` (`spend_cap_source: "request"`). The page only PRE-SELECTS it;
 * what is recorded is the cap the user confirms in the POST body. Echoed in
 * `authorization_request` like every parameter above, because the request id
 * is bound to all of them.
 */
export const SPEND_CAP_HINT = "f2z_spend_cap";
export const SPEND_PERIOD_HINT = "f2z_spend_period";

/**
 * What a chosen cap is compared with to warn that a fresh sign-in is needed:
 * the EXISTING grant's cap when the backend says what it is. The
 * pre-selection may be lower than the grant (a clamped hint), and choosing the
 * grant's own cap back is not a raise. An older backend sends no
 * `current_spend_cap`; the pre-selection then is the grant's cap.
 */
export function raiseBaseline(
  current: SpendCap | null | undefined,
  preselected: SpendCap,
): SpendCap {
  if (
    current &&
    isCapPeriod(current.cap_period) &&
    (current.spend_cap_2z === null ||
      (Number.isSafeInteger(current.spend_cap_2z) && current.spend_cap_2z >= 0))
  ) {
    return {
      spend_cap_2z: current.spend_cap_2z,
      cap_period: current.cap_period,
    };
  }
  return preselected;
}

/**
 * The backend's own parameter (not OAuth): the `login_ticket` a `login`
 * answer carries, sent back on the request repeated after the sign-in. A
 * sign-in at or after the ticket's time satisfies `prompt=login` and any
 * `max_age`, including `max_age=0`. It is one of the parameters
 * above, so it is echoed into `authorization_request` and reaches the POST.
 */
export const LOGIN_TICKET = "f2z_login_ticket";

/**
 * Marks an authorize URL the page has already sent through a fresh sign-in.
 * The backend ignores unknown parameters (`_params` reads only the list
 * above), so it never reaches the request digest; the page uses it to stop
 * a sign-in loop when the backend still cannot confirm a recent sign-in.
 */
export const REAUTH_MARKER = "f2z_reauth";

/** The recognised parameters from a query string, non-empty values only. */
export function authorizationParams(
  search: URLSearchParams,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of AUTHORIZATION_PARAMETERS) {
    const value = search.get(name);
    if (value !== null && value !== "") out[name] = value;
  }
  return out;
}

/**
 * Where to come back to after a fresh sign-in: the same request, marked,
 * WITHOUT `prompt=login`, carrying the `login` answer's ticket — the
 * backend's contract (views._authentication_gate) is that the page signs the
 * user in and repeats the request, and a sign-in at or after the ticket's
 * time is then fresh enough for `prompt=login` and `max_age`.
 */
export function reauthReturnPath(
  pathname: string,
  search: string,
  ticket?: string,
): string {
  const params = new URLSearchParams(search);
  const prompt = (params.get("prompt") || "")
    .split(/\s+/)
    .filter((value) => value && value !== "login");
  if (prompt.length) params.set("prompt", prompt.join(" "));
  else params.delete("prompt");
  params.set(REAUTH_MARKER, "1");
  return withLoginTicket(pathname, params.toString(), ticket);
}

/**
 * The same URL carrying `ticket` as `f2z_login_ticket`, replacing any older
 * one. No ticket (an older backend) leaves the URL as it was.
 */
export function withLoginTicket(
  pathname: string,
  search: string,
  ticket?: string,
): string {
  const params = new URLSearchParams(search);
  if (ticket) params.set(LOGIN_TICKET, ticket);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * The backend's `redirect_to` is navigated to as-is, but never as script:
 * a `javascript:`/`data:`/`vbscript:` target is refused whatever produced it.
 */
export function isNavigableRedirect(target: unknown): target is string {
  if (typeof target !== "string" || !target) return false;
  const scheme = /^\s*([A-Za-z][A-Za-z0-9+.-]*):/.exec(target)?.[1];
  if (!scheme) return false;
  return !["javascript", "data", "vbscript", "blob", "file"].includes(
    scheme.toLowerCase(),
  );
}
