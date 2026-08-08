import type { SendProposal } from "./types";

/** Reject a proposal that changes the requested amount or carries lossy totals. */
export function assertExactSendProposal(
  expectedAmount: number,
  proposal: SendProposal,
): void {
  if (proposal.amount !== expectedAmount) {
    throw new Error("Wallet proposal changed the payment amount");
  }
  if (
    !Number.isSafeInteger(proposal.amount) ||
    !Number.isSafeInteger(proposal.fee) ||
    proposal.fee < 0 ||
    !Number.isSafeInteger(proposal.total) ||
    proposal.total !== proposal.amount + proposal.fee
  ) {
    throw new Error("Wallet proposal returned invalid payment totals");
  }
}
