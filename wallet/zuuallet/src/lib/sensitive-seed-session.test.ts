import { describe, expect, it, vi } from "vitest";
import {
  CreatedSeedSession,
  SensitiveSeedSession,
} from "./sensitive-seed-session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness() {
  let tokenCounter = 0;
  let phrase: string | null = null;
  const ended: string[] = [];
  const releases: Array<() => void> = [];
  const display = new SensitiveSeedSession(
    {
      begin: async () => `lease-${++tokenCounter}`,
      end: async (token) => {
        ended.push(token);
      },
    },
    (next) => {
      phrase = next;
    },
    (release) => releases.push(release),
  );
  return {
    session: new CreatedSeedSession(display),
    phrase: () => phrase,
    ended,
    releases,
  };
}

describe("Zuuallet created-seed backup transaction", () => {
  it("serializes forced cross-session reveals without clearing the protected winner", async () => {
    const begin = deferred<string>();
    const read = deferred<string>();
    let protectedDisplay = false;
    const beginAuthority = vi.fn(async () => {
      await begin.promise;
      protectedDisplay = true;
      return "classic-lease";
    });
    const endAuthority = vi.fn(async () => {
      protectedDisplay = false;
    });
    const firstPublished: Array<string | null> = [];
    const secondPublished: Array<string | null> = [];
    const firstRead = vi.fn(() => read.promise);
    const secondRead = vi.fn(async () => "must never read");
    const first = new SensitiveSeedSession(
      { begin: beginAuthority, end: endAuthority },
      (phrase) => {
        if (phrase) expect(protectedDisplay).toBe(true);
        firstPublished.push(phrase);
      },
      (release) => release(),
    );
    const second = new SensitiveSeedSession(
      { begin: beginAuthority, end: endAuthority },
      (phrase) => secondPublished.push(phrase),
      (release) => release(),
    );

    const firstReveal = first.reveal(firstRead);
    const overlappingReveal = second.reveal(secondRead);

    await expect(overlappingReveal).resolves.toBe(false);
    expect(beginAuthority).toHaveBeenCalledTimes(1);
    expect(firstRead).not.toHaveBeenCalled();
    expect(secondRead).not.toHaveBeenCalled();
    expect(secondPublished).toEqual([]);

    begin.resolve("ignored");
    await vi.waitFor(() => expect(firstRead).toHaveBeenCalledTimes(1));
    read.resolve("covered classic phrase");
    await expect(firstReveal).resolves.toBe(true);
    expect(firstPublished).toEqual([null, "covered classic phrase"]);
    expect(protectedDisplay).toBe(true);

    first.clear();
    await vi.waitFor(() => expect(protectedDisplay).toBe(false));
  });

  it("binds the backup read and acknowledgement to the exact created wallet", async () => {
    const state = harness();
    const reads: Array<[string, string]> = [];
    await expect(
      state.session.reveal("wallet-a", async (walletId, token) => {
        reads.push([walletId, token]);
        return "alpha beta gamma";
      }),
    ).resolves.toBe(true);

    expect(reads).toEqual([["wallet-a", "lease-1"]]);
    expect(state.phrase()).toBe("alpha beta gamma");
    const confirmations: string[] = [];
    await expect(
      state.session.confirm("wallet-a", async (walletId) => {
        confirmations.push(walletId);
      }),
    ).resolves.toBe(true);

    expect(confirmations).toEqual(["wallet-a"]);
    expect(state.phrase()).toBeNull();
    expect(state.ended).toEqual([]);
    expect(state.releases).toHaveLength(1);
    state.releases[0]();
    await Promise.resolve();
    expect(state.ended).toEqual(["lease-1"]);
  });

  it("rejects a stale or wrong-wallet acknowledgement without touching the current phrase", async () => {
    const state = harness();
    await state.session.reveal("wallet-a", async () => "wallet a phrase");
    await state.session.reveal("wallet-b", async () => "wallet b phrase");
    const confirmations: string[] = [];

    await expect(
      state.session.confirm("wallet-a", async (walletId) => {
        confirmations.push(walletId);
      }),
    ).rejects.toThrow("missing or stale");
    expect(confirmations).toEqual([]);
    expect(state.session.currentWalletId).toBe("wallet-b");
    expect(state.phrase()).toBe("wallet b phrase");
  });

  it("keeps the phrase, identity, and lease retryable when acknowledgement fails", async () => {
    const state = harness();
    await state.session.reveal("wallet-a", async () => "retry phrase");

    await expect(
      state.session.confirm("wallet-a", async () => {
        throw new Error("native manifest write failed");
      }),
    ).rejects.toThrow("native manifest write failed");
    expect(state.session.currentWalletId).toBe("wallet-a");
    expect(state.phrase()).toBe("retry phrase");
    expect(state.releases).toEqual([]);

    await expect(
      state.session.confirm("wallet-a", async () => undefined),
    ).resolves.toBe(true);
    expect(state.phrase()).toBeNull();
  });

  it("keeps a cold or cancelled backup gate resumable without retaining a phrase", async () => {
    const state = harness();
    state.session.prepare("wallet-a");
    expect(state.session.currentWalletId).toBe("wallet-a");
    expect(state.phrase()).toBeNull();

    await expect(
      state.session.reveal("wallet-a", async () => {
        throw new Error("device authentication cancelled");
      }),
    ).rejects.toThrow("device authentication cancelled");
    expect(state.session.currentWalletId).toBe("wallet-a");
    expect(state.phrase()).toBeNull();

    await expect(
      state.session.reveal("wallet-a", async () => "freshly revealed phrase"),
    ).resolves.toBe(true);
    expect(state.phrase()).toBe("freshly revealed phrase");
  });

  it("serializes a double-click so only one native acknowledgement can run", async () => {
    const state = harness();
    await state.session.reveal("wallet-a", async () => "one phrase");
    const confirmation = deferred<void>();
    let calls = 0;
    const first = state.session.confirm("wallet-a", async () => {
      calls += 1;
      await confirmation.promise;
    });
    const second = state.session.confirm("wallet-a", async () => {
      calls += 1;
    });

    await expect(second).resolves.toBe(false);
    expect(calls).toBe(1);
    expect(state.phrase()).toBe("one phrase");
    confirmation.resolve();
    await expect(first).resolves.toBe(true);
    expect(state.phrase()).toBeNull();
  });

  it("cancels without acknowledging and makes a late in-flight confirmation inert", async () => {
    const state = harness();
    await state.session.reveal("wallet-a", async () => "cancel phrase");
    const confirmation = deferred<void>();
    const pending = state.session.confirm("wallet-a", async () => {
      await confirmation.promise;
    });

    expect(state.session.cancel()).toBe(true);
    expect(state.phrase()).toBeNull();
    confirmation.resolve();
    await expect(pending).resolves.toBe(false);
    expect(state.session.currentWalletId).toBeNull();
  });

  it("holds the native acknowledgement lock across cancellation and replacement", async () => {
    const state = harness();
    await state.session.reveal("wallet-a", async () => "wallet a phrase");
    const firstConfirmation = deferred<void>();
    const confirmations: string[] = [];
    const first = state.session.confirm("wallet-a", async (walletId) => {
      confirmations.push(walletId);
      await firstConfirmation.promise;
    });

    expect(state.session.cancel()).toBe(true);
    state.session.prepare("wallet-b");
    await expect(
      state.session.reveal("wallet-b", async () => "wallet b phrase"),
    ).rejects.toThrow("acknowledgement is still in progress");
    await expect(
      state.session.confirm("wallet-b", async (walletId) => {
        confirmations.push(walletId);
      }),
    ).resolves.toBe(false);
    expect(confirmations).toEqual(["wallet-a"]);

    firstConfirmation.resolve();
    await expect(first).resolves.toBe(false);
    expect(state.session.currentWalletId).toBe("wallet-b");
    expect(state.phrase()).toBeNull();

    await expect(
      state.session.reveal("wallet-b", async () => "wallet b phrase"),
    ).resolves.toBe(true);
    expect(state.phrase()).toBe("wallet b phrase");
    await expect(
      state.session.confirm("wallet-b", async (walletId) => {
        confirmations.push(walletId);
      }),
    ).resolves.toBe(true);
    expect(confirmations).toEqual(["wallet-a", "wallet-b"]);
  });

  it("unlocks after a late failed acknowledgement without reviving stale state", async () => {
    const state = harness();
    await state.session.reveal("wallet-a", async () => "wallet a phrase");
    const firstConfirmation = deferred<void>();
    const first = state.session.confirm("wallet-a", async () => {
      await firstConfirmation.promise;
    });

    expect(state.session.cancel()).toBe(true);
    state.session.prepare("wallet-b");
    firstConfirmation.reject(new Error("late native failure"));
    await expect(first).rejects.toThrow("late native failure");
    expect(state.session.currentWalletId).toBe("wallet-b");
    expect(state.phrase()).toBeNull();

    await expect(
      state.session.reveal("wallet-b", async () => "wallet b phrase"),
    ).resolves.toBe(true);
    expect(state.session.currentWalletId).toBe("wallet-b");
    expect(state.phrase()).toBe("wallet b phrase");
  });

  it("finishes the exact acknowledgement after background hiding without republishing", async () => {
    const state = harness();
    await state.session.reveal("wallet-a", async () => "background phrase");
    const confirmation = deferred<void>();
    const pending = state.session.confirm("wallet-a", async () => {
      await confirmation.promise;
    });

    expect(state.session.hide()).toBe(true);
    expect(state.phrase()).toBeNull();
    expect(state.session.currentWalletId).toBe("wallet-a");
    confirmation.resolve();
    await expect(pending).resolves.toBe(true);
    expect(state.session.currentWalletId).toBeNull();
    expect(state.phrase()).toBeNull();
  });
});
