import { failure } from "./error.js";
import type { SpendCapHint } from "./types.js";

/** The IdP's bound on a cap, in whole 2Z (a Postgres `integer`). */
export const MAX_SPEND_CAP_HINT_2Z = 2_147_483_647n;
const PERIODS: readonly string[] = ["day", "week", "month", "total"];

/**
 * The wire form of a sign-in's spend-cap hint, or
 * `invalid_request`. The IdP silently ignores an unusable hint; refusing it
 * here tells the developer instead of quietly suggesting nothing.
 */
export function spendCapParams(hint: SpendCapHint): {
  f2z_spend_cap: string;
  f2z_spend_period?: string;
} {
  if (
    !hint ||
    typeof hint !== "object" ||
    typeof hint.cap2z !== "bigint" ||
    hint.cap2z < 1n ||
    hint.cap2z > MAX_SPEND_CAP_HINT_2Z ||
    (hint.period !== undefined && !PERIODS.includes(hint.period))
  )
    failure("invalid_request");
  const out: { f2z_spend_cap: string; f2z_spend_period?: string } = {
    f2z_spend_cap: hint.cap2z.toString(),
  };
  if (hint.period !== undefined) out.f2z_spend_period = hint.period;
  return out;
}
