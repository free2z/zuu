import type { AuthUser } from "@/lib/api/types";

export type PaidActionGate = "loading" | "sign-in" | "low-balance" | "ready";

/**
 * The shared ordering for every action that can spend 2Z.
 *
 * Anonymous `tuzis` is deliberately initialized to zero, so balance must not
 * be interpreted until the session has resolved and an account exists.
 */
export function paidActionGate({
  sessionLoading,
  user,
  balance,
  cost,
}: {
  sessionLoading: boolean;
  user: AuthUser | null;
  balance: number;
  cost: number | null;
}): PaidActionGate {
  if (sessionLoading) return "loading";
  if (!user) return "sign-in";
  if (cost !== null && cost > balance) return "low-balance";
  return "ready";
}

/** Testable money-boundary runner: blocked states never invoke the API task. */
export async function runPaidAction<T>(
  state: Parameters<typeof paidActionGate>[0],
  action: () => Promise<T>,
): Promise<{ gate: PaidActionGate; result?: T }> {
  const gate = paidActionGate(state);
  if (gate !== "ready") return { gate };
  return { gate, result: await action() };
}
