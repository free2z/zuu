import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/http";
import type { SimpleCreator } from "@/lib/api/types";
import {
  classifyTransferFailure,
  clearPendingDonation,
  createDonationIdempotencyKey,
  initialRecipientState,
  nextHighlight,
  recipientKeyAction,
  recipientReducer,
  reviewMatchesTransfer,
  isDonationIdempotencyKey,
  loadPendingDonation,
  pendingDonationMatches,
  persistPendingDonation,
  sameUsername,
  shouldSearchRecipients,
  transferBlock,
  transferFailureIsAmbiguous,
} from "./send-recipient";

const donationKey = "00000000-0000-4000-8000-000000000000";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

const alice: SimpleCreator = {
  username: "alice",
  free2zaddr: "alice",
  display_name: "Alice Example",
  image: "/alice.png",
};

const bob: SimpleCreator = {
  username: "bob",
  free2zaddr: "bob",
  display_name: "Bob Example",
};

describe("recipientReducer", () => {
  it("never treats arbitrary typed text as a resolved recipient", () => {
    const state = recipientReducer(initialRecipientState, {
      type: "queryChanged",
      query: "typoed-user",
    });

    expect(state.selected).toBeNull();
    expect(
      transferBlock({
        selected: state.selected,
        query: state.query,
        ownUsername: "sender",
        amount: 100,
        validAmount: true,
        balance: 500,
        sending: false,
      }),
    ).toBe("unresolved");
  });

  it("invalidates selection and confirmation as soon as the text changes", () => {
    let state = recipientReducer(initialRecipientState, {
      type: "select",
      creator: alice,
    });
    state = recipientReducer(state, {
      type: "startReview",
      amount: 100,
      senderUsername: "sender",
      idempotencyKey: donationKey,
    });
    expect(state.review?.recipient.username).toBe("alice");
    expect(state.review?.senderUsername).toBe("sender");

    state = recipientReducer(state, {
      type: "queryChanged",
      query: "alicee",
    });
    expect(state.selected).toBeNull();
    expect(state.review).toBeNull();
  });

  it("ignores stale successes and failures after a newer query", () => {
    let state = recipientReducer(initialRecipientState, {
      type: "queryChanged",
      query: "ali",
    });
    const staleGeneration = state.generation;
    state = recipientReducer(state, {
      type: "searchStarted",
      generation: staleGeneration,
    });
    state = recipientReducer(state, {
      type: "queryChanged",
      query: "bob",
    });

    state = recipientReducer(state, {
      type: "searchSucceeded",
      generation: staleGeneration,
      results: [alice],
    });
    state = recipientReducer(state, {
      type: "searchFailed",
      generation: staleGeneration,
    });

    expect(state.query).toBe("bob");
    expect(state.results).toEqual([]);
    expect(state.searchStatus).toBe("idle");
  });

  it("resolves a canonical recipient from a pointer/mobile selection", () => {
    const state = recipientReducer(initialRecipientState, {
      type: "select",
      creator: alice,
    });
    expect(state.query).toBe("alice");
    expect(state.selected).toEqual(alice);
  });
});

describe("keyboard result navigation", () => {
  it("enters and wraps a result list in both directions", () => {
    expect(nextHighlight(-1, 2, 1)).toBe(0);
    expect(nextHighlight(-1, 2, -1)).toBe(1);
    expect(nextHighlight(0, 2, -1)).toBe(1);
    expect(nextHighlight(1, 2, 1)).toBe(0);
    expect(nextHighlight(0, 0, 1)).toBe(-1);
  });

  it("selects only the highlighted result on Enter and closes on Escape", () => {
    expect(recipientKeyAction("Enter", [alice, bob], 1)).toEqual({
      type: "select",
      creator: bob,
    });
    expect(recipientKeyAction("Enter", [alice], -1)).toBeNull();
    expect(recipientKeyAction("Escape", [alice], 0)).toEqual({
      type: "closeResults",
    });
  });
});

describe("donation idempotency key", () => {
  it("creates an RFC 4122 UUIDv4 from secure random bytes", () => {
    const key = createDonationIdempotencyKey((bytes) => {
      bytes.fill(0xab);
      return bytes;
    });
    expect(key).toBe("abababab-abab-4bab-abab-abababababab");
    expect(isDonationIdempotencyKey(key)).toBe(true);
  });

  it.each(["", "key-123", "00000000-0000-0000-0000-000000000000"])(
    "rejects non-v4 transfer key %s",
    (key) => expect(isDonationIdempotencyKey(key)).toBe(false),
  );
});

describe("crash-safe pending donation", () => {
  const review = {
    recipient: alice,
    amount: 100,
    senderUsername: "sender",
    idempotencyKey: donationKey,
  };

  it("persists and reloads the exact keyed transfer", () => {
    const storage = memoryStorage();
    expect(persistPendingDonation(review, storage)).toBe(true);
    expect(loadPendingDonation(storage)).toEqual({
      senderUsername: "sender",
      amount: 100,
      idempotencyKey: donationKey,
      recipient: { username: "alice", free2zaddr: "alice" },
    });
    expect(
      pendingDonationMatches(review, {
        senderUsername: "SENDER",
        recipient: { ...alice, username: "ALICE" },
        amount: 100,
      }),
    ).toBe(true);
  });

  it("rejects changed sender, recipient, or amount fingerprints", () => {
    expect(
      pendingDonationMatches(review, {
        senderUsername: "other",
        recipient: alice,
        amount: 100,
      }),
    ).toBe(false);
    expect(
      pendingDonationMatches(review, {
        senderUsername: "sender",
        recipient: bob,
        amount: 100,
      }),
    ).toBe(false);
    expect(
      pendingDonationMatches(review, {
        senderUsername: "sender",
        recipient: alice,
        amount: 101,
      }),
    ).toBe(false);
  });

  it("clears only the resolved key and leaves a different pending key", () => {
    const storage = memoryStorage();
    persistPendingDonation(review, storage);
    clearPendingDonation("ffffffff-ffff-4fff-bfff-ffffffffffff", storage);
    expect(loadPendingDonation(storage)?.idempotencyKey).toBe(donationKey);
    clearPendingDonation(donationKey, storage);
    expect(loadPendingDonation(storage)).toBeNull();
  });

  it("fails closed when durable storage cannot be written", () => {
    const unavailable = {
      getItem: () => null,
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => undefined,
    };
    expect(persistPendingDonation(review, unavailable)).toBe(false);
  });

  it("does not overwrite a different pending attempt from another tab", () => {
    const storage = memoryStorage();
    expect(persistPendingDonation(review, storage)).toBe(true);
    expect(
      persistPendingDonation(
        {
          ...review,
          idempotencyKey: "ffffffff-ffff-4fff-bfff-ffffffffffff",
        },
        storage,
      ),
    ).toBe(false);
    expect(loadPendingDonation(storage)?.idempotencyKey).toBe(donationKey);
  });
});

describe("debounced search authorization", () => {
  it("does not start a stale debounced query after the user edits again", () => {
    expect(
      shouldSearchRecipients({
        currentQuery: "bob",
        debouncedQuery: "alice",
        selected: null,
        isSelf: false,
      }),
    ).toBe(false);
  });

  it("does not search a selected or self recipient", () => {
    expect(
      shouldSearchRecipients({
        currentQuery: "alice",
        debouncedQuery: "alice",
        selected: alice,
        isSelf: false,
      }),
    ).toBe(false);
    expect(
      shouldSearchRecipients({
        currentQuery: "sender",
        debouncedQuery: "sender",
        selected: null,
        isSelf: true,
      }),
    ).toBe(false);
  });
});

describe("transferBlock", () => {
  const valid = {
    selected: alice,
    query: "alice",
    ownUsername: "sender",
    amount: 100,
    validAmount: true,
    balance: 500,
    sending: false,
  };

  it("requires auth, a current exact selection, a non-self recipient, and balance", () => {
    expect(transferBlock(valid)).toBeNull();
    expect(transferBlock({ ...valid, ownUsername: undefined })).toBe("auth");
    expect(transferBlock({ ...valid, selected: null })).toBe("unresolved");
    expect(transferBlock({ ...valid, query: "alicee" })).toBe("unresolved");
    expect(transferBlock({ ...valid, ownUsername: "ALICE" })).toBe("self");
    expect(transferBlock({ ...valid, amount: 0 })).toBe("amount");
    expect(transferBlock({ ...valid, amount: 1.5 })).toBe("amount");
    expect(transferBlock({ ...valid, amount: 501 })).toBe("balance");
    expect(transferBlock({ ...valid, sending: true })).toBe("sending");
  });

  it("compares canonical usernames case-insensitively", () => {
    expect(sameUsername(" Alice ", "aLiCe")).toBe(true);
    expect(transferBlock({ ...valid, query: "ALICE" })).toBeNull();
    expect(transferBlock({ ...valid, selected: bob })).toBe("unresolved");
  });
});

describe("reviewMatchesTransfer", () => {
  const review = {
    recipient: alice,
    amount: 100,
    senderUsername: "sender",
    idempotencyKey: donationKey,
  };
  const current = {
    review,
    selected: alice,
    query: "alice",
    ownUsername: "sender",
    amount: 100,
    validAmount: true,
    balance: 500,
  };

  it("binds confirmation to the exact sender, recipient, amount, and balance", () => {
    expect(reviewMatchesTransfer(current)).toBe(true);
    expect(
      reviewMatchesTransfer({ ...current, ownUsername: "other-sender" }),
    ).toBe(false);
    expect(reviewMatchesTransfer({ ...current, selected: bob })).toBe(false);
    expect(reviewMatchesTransfer({ ...current, query: "alicee" })).toBe(false);
    expect(reviewMatchesTransfer({ ...current, amount: 101 })).toBe(false);
    expect(reviewMatchesTransfer({ ...current, balance: 99 })).toBe(false);
  });
});

describe("classifyTransferFailure", () => {
  it.each([
    [new ApiError(401, "failure"), "auth"],
    [new ApiError(403, "failure"), "auth"],
    [new ApiError(402, "failure"), "balance"],
    [
      new ApiError(400, "failure", {
        error: "Request must contain amount > 1 and < balance",
      }),
      "balance",
    ],
    [
      new ApiError(400, "failure", { code: "insufficient_funds" }),
      "balance",
    ],
    [new ApiError(400, "failure", { code: "self_send" }), "self"],
    [new ApiError(404, "failure", { code: "recipient_not_found" }), "not-found"],
    [new ApiError(404, "failure"), "unsupported"],
    [new ApiError(409, "failure", { code: "request_in_progress" }), "pending"],
    [
      new ApiError(409, "failure", { code: "idempotency_mismatch" }),
      "idempotency-conflict",
    ],
    [
      new ApiError(409, "failure", { code: "invalid_idempotency_record" }),
      "idempotency-conflict",
    ],
    [new ApiError(409, "failure"), "idempotency-conflict"],
    [new ApiError(500, "failure"), "network"],
  ] as const)("distinguishes transfer failure as %s", (error, expected) => {
    expect(classifyTransferFailure(error)).toBe(expected);
  });

  it("treats transport errors as network failures", () => {
    expect(classifyTransferFailure(new TypeError("Failed to fetch"))).toBe(
      "network",
    );
  });

  it("retains the keyed review only for ambiguous network/in-flight results", () => {
    expect(transferFailureIsAmbiguous("network")).toBe(true);
    expect(transferFailureIsAmbiguous("pending")).toBe(true);
    expect(transferFailureIsAmbiguous("idempotency-conflict")).toBe(true);
    expect(transferFailureIsAmbiguous("balance")).toBe(false);
    expect(transferFailureIsAmbiguous("unsupported")).toBe(false);
  });
});
