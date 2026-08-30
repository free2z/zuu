import { describe, expect, it } from "vitest";
import authSource from "../../features/auth/useZcashChallengeFlow.ts?raw";
import onboardingSource from "../../features/wallet/Onboarding.tsx?raw";
import walletFeatureSource from "../../features/wallet/index.tsx?raw";

function ordered(source: string, fragments: readonly string[]): void {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, cursor + 1);
    expect(next, `missing ordered lifecycle fragment: ${fragment}`).toBeGreaterThan(
      cursor,
    );
    cursor = next;
  }
}

describe("wallet identity mutation lifecycle", () => {
  it("refreshes auth restore before a flow-local invalidation can return", () => {
    const nativeResult = authSource.indexOf("const restored = await restoration;");
    const refresh = authSource.indexOf(
      "refreshWalletIdentity(restored.walletId)",
      nativeResult,
    );
    expect(authSource.slice(nativeResult, refresh)).not.toContain("isCurrent()");
    ordered(authSource, [
      "const restored = await restoration;",
      "clearPhrase();",
      "refreshWalletIdentity(restored.walletId)",
      "if (!isCurrent()) return;",
    ]);
  });

  it("refreshes auth create before a flow-local invalidation can return", () => {
    const createFlow = authSource.slice(authSource.indexOf("const createIdentity"));
    const nativeResult = createFlow.indexOf(
      "const { walletId } = await wallet.createWallet();",
    );
    const refresh = createFlow.indexOf(
      "refreshWalletIdentity(walletId)",
      nativeResult,
    );
    expect(createFlow.slice(nativeResult, refresh)).not.toContain("isCurrent()");
    ordered(createFlow, [
      "const { walletId } = await wallet.createWallet();",
      "refreshWalletIdentity(walletId)",
      "if (!isCurrent()) return;",
    ]);
  });

  it("publishes create identity without replacing its protected seed flow", () => {
    ordered(onboardingSource, [
      "const w = await wallet.createWallet();",
      "onCreated(w);",
      "refreshWalletIdentity(w.walletId)",
    ]);

    expect(walletFeatureSource).toContain(
      "(!status || !status.initialized || status.backupRequired)",
    );
  });
});
