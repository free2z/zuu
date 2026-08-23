import type { SendConfirmation, SendProposal } from "./types";

interface ExpectedPayment {
  recipient: string;
  amount: number;
  memo?: string;
}

/** Renderer defense in depth; native monotonic expiry remains authoritative. */
export function assertFreshSendConfirmation(
  confirmation: SendConfirmation,
  now = Date.now(),
): void {
  if (
    !/^[a-f0-9]{64}$/.test(confirmation.confirmationToken) ||
    !Number.isSafeInteger(confirmation.expiresAt) ||
    confirmation.expiresAt <= now ||
    confirmation.expiresAt > now + 5 * 60 * 1000
  ) {
    throw new Error("Wallet returned an invalid native payment confirmation");
  }
}

/** Reject a proposal that changes the requested payment or carries lossy totals. */
export function assertExactSendProposal(
  expected: ExpectedPayment,
  proposal: SendProposal,
): void {
  const payment = proposal.review.payments[0];
  if (
    proposal.review.version !== 2 ||
    proposal.review.payments.length !== 1 ||
    !payment ||
    payment.recipient !== expected.recipient ||
    payment.amount !== expected.amount ||
    payment.memo !== (expected.memo ?? null)
  ) {
    throw new Error("Wallet proposal changed the requested payment");
  }
  if (
    !Number.isSafeInteger(payment.amount) ||
    !Number.isSafeInteger(proposal.review.fee) ||
    proposal.review.fee < 0 ||
    !Number.isSafeInteger(proposal.review.total) ||
    proposal.review.total !== payment.amount + proposal.review.fee
  ) {
    throw new Error("Wallet proposal returned invalid payment totals");
  }
  if (
    proposal.review.feePolicy !== "zip317-standard" ||
    proposal.review.changePolicy !== "zip317-shielded-auto" ||
    !["mainnet", "testnet"].includes(proposal.review.network) ||
    !/^[a-f0-9]{64}$/.test(proposal.reviewDigest) ||
    !/^[a-f0-9]{64}$/.test(proposal.proposalToken)
  ) {
    throw new Error("Wallet proposal returned unsupported review authorization");
  }
}
