import {
  MAX_COMMENT_TUZIS,
  validateTuzis,
  type TuziInputError,
} from "@/lib/format";

export interface CommentWeightState {
  value: number | null;
  error: TuziInputError | null;
  needsTopUp: boolean;
}

/** Keep malformed/over-limit weights distinct from valid unaffordable ones. */
export function commentWeightState(raw: string, balance: number): CommentWeightState {
  const parsed = validateTuzis(raw, {
    minimum: 1,
    maximum: MAX_COMMENT_TUZIS,
  });
  return {
    ...parsed,
    needsTopUp:
      parsed.error === null && parsed.value !== null && parsed.value > balance,
  };
}
