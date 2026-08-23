import { describe, expect, it } from "vitest";
import { mockWallet } from "./mock";

const RECOVERY_PHRASE =
  "wisdom shadow orchard zebra pledge notice frost violet render " +
  "summer harvest mirror canyon velvet ranch fossil pupil sunset " +
  "quantum ledger prosper anchor beyond zephyr";

describe("mockWallet.parsePaymentUri", () => {
  it("preserves an exact eight-decimal URI amount", () => {
    expect(mockWallet.parsePaymentUri("zcash:u1test?amount=1.00000001").amount).toBe(
      100_000_001,
    );
  });

  it.each(["1.000000001", "1e3", "-1", "Infinity"])(
    "rejects malformed URI amount %s instead of rounding it",
    (amount) => {
      expect(() =>
        mockWallet.parsePaymentUri(`zcash:u1test?amount=${encodeURIComponent(amount)}`),
      ).toThrow("Invalid ZEC amount");
    },
  );
});

describe("mockWallet.restoreWallet", () => {
  it("returns the exact published wallet identity without a backup obligation", async () => {
    expect(await mockWallet.restoreWallet(RECOVERY_PHRASE)).toEqual({
      success: true,
      walletId: "mock-wallet-0",
    });
    expect(mockWallet.getWalletStatus()).toMatchObject({
      activeWalletId: "mock-wallet-0",
      backupRequired: false,
      initialized: true,
    });
  });

  it("rejects invalid recovery input without echoing it", () => {
    const privateInput = "private invalid recovery material";
    expect(() => mockWallet.restoreWallet(privateInput)).toThrow(
      "Recovery phrase is not a valid supported BIP39 mnemonic.",
    );
    try {
      mockWallet.restoreWallet(privateInput);
    } catch (error) {
      expect(String(error)).not.toContain(privateInput);
    }
  });
});

describe("mockWallet send confirmation", () => {
  it("requires exact credentials and consumes them once", async () => {
    const proposal = await mockWallet.proposeSend("u1recipient", 50_000, "memo");

    expect(() =>
      mockWallet.discardSendProposal(
        proposal.proposalId,
        proposal.reviewDigest,
        "wrong-token",
      ),
    ).toThrow("do not match");
    expect(() =>
      mockWallet.executeSend(proposal.proposalId, proposal.reviewDigest, "unissued-token"),
    ).toThrow("absent, stale, or mismatched");
    expect(() =>
      mockWallet.confirmSend(proposal.proposalId, proposal.reviewDigest, "wrong-token"),
    ).toThrow("do not match");
    const confirmation = mockWallet.confirmSend(
      proposal.proposalId,
      proposal.reviewDigest,
      proposal.proposalToken,
    );
    expect(confirmation.expiresAt).toBeGreaterThan(Date.now());
    expect(() =>
      mockWallet.executeSend(
        proposal.proposalId,
        proposal.reviewDigest,
        confirmation.confirmationToken,
      ),
    ).not.toThrow();
    expect(() =>
      mockWallet.executeSend(
        proposal.proposalId,
        proposal.reviewDigest,
        confirmation.confirmationToken,
      ),
    ).toThrow("absent, stale, or mismatched");
  });
});
