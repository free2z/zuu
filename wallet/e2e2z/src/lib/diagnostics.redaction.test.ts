import { describe, expect, it } from "vitest";
import {
  DiagnosticsStore,
  PASSTHROUGH_SCRUBBER,
  createDiagnosticEvent,
  createEnvironment,
  scrubText,
} from "@free2z/wallet-shared";

/**
 * The redaction control.
 *
 * Every case below feeds secret-shaped material through the real capture path
 * and asserts the store holds none of it. On its own that proves nothing — an
 * assertion that a string is absent passes trivially if the string was never
 * there — so each case is paired with the same assertion run against
 * `PASSTHROUGH_SCRUBBER`, which must find the secret. If a change ever makes
 * redaction a no-op, the second half of every pair keeps passing and the first
 * half starts failing. If a change ever makes these inputs stop reaching the
 * capture path at all, the second half fails and says so.
 */

const ENVIRONMENT = createEnvironment({
  app: "e2e2z",
  version: "0.1.0",
  build: "2",
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
});

/**
 * Secret-shaped, not secret. Every value here is synthetic and is the shape of
 * a thing that must never be captured, which is the property under test.
 */
const SECRETS = {
  mnemonic:
    "abandon ability able about above absent absorb abstract absurd abuse access accident",
  unifiedAddress:
    "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkyy6c76ryxtnvhg9pt7fw7g6vwzrl2j7fkyy6c76ryxt",
  saplingAddress:
    "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9slya",
  transparentAddress: "t1KsPtV3rncjW3ULQJqLcCrRpDzHWaeuMhg",
  spendingKey:
    "secret-extended-key-main1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4nnkzqrpqxs9nywzn2nnkzqrpqxs9",
  viewingKey:
    "uview1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4nnkzqrpqxs9nywzn2nnkzqrpqxs9zarvary0",
  devicePrivateKey: "MC4CAQAwBQYDK2VwBCIEIH3JbxKQpBqMi2wEyLQvKV5Y7hZ9nRQaXcTfPmLdWgZ0",
  authToken:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  handle: "@skylar",
  amount: "0.04213500",
} as const;

/**
 * The one class token analysis cannot remove.
 *
 * A memo and an error message are the same thing to a tokenizer: short English
 * words, ordinary punctuation, no digits, no encoding. A rule that removed this
 * would remove "could not read the file at path" with it, and a diagnostics
 * screen that cannot say what went wrong is not worth shipping. See rule 3 in
 * `redact.ts`.
 */
const PROSE = "dinner at the place we talked about, bring the blue folder";

function storeWith(error: unknown): DiagnosticsStore {
  const store = new DiagnosticsStore({
    environment: ENVIRONMENT,
    persistence: null,
    now: () => 1_757_000_000_000,
  });
  store.breadcrumb("messaging", "engine-status-requested");
  store.record("unhandled-rejection", error);
  return store;
}

function captured(error: unknown): string {
  return JSON.stringify(storeWith(error).events());
}

function unredacted(error: unknown): string {
  return JSON.stringify(
    createDiagnosticEvent(
      {
        at: 1_757_000_000_000,
        kind: "unhandled-rejection",
        error,
        breadcrumbs: [],
      },
      PASSTHROUGH_SCRUBBER,
    ),
  );
}

describe("secret-shaped material cannot reach the buffer", () => {
  for (const [label, secret] of Object.entries(SECRETS)) {
    describe(label, () => {
      const thrown = new Error(`the operation failed for ${secret}`);
      thrown.stack = `Error: the operation failed for ${secret}\n    at reconcile (https://tauri.localhost/assets/index-a1b2c3d4.js:1024:15)`;

      it("is absent from every field the store keeps", () => {
        expect(captured(thrown)).not.toContain(secret);
      });

      it("would be present without redaction, so the assertion is real", () => {
        expect(unredacted(thrown)).toContain(secret);
      });
    });
  }
});

describe("the shapes secrets take", () => {
  it("collapses a recovery phrase rather than keeping it word by word", () => {
    // Each word passes the token allow-list on its own; the run is what gives
    // a mnemonic away, and the run is what is removed.
    expect(scrubText(SECRETS.mnemonic)).toBe("[redacted:word-run]");
  });

  it("keeps a short lowercase run, so ordinary messages survive", () => {
    expect(scrubText("could not read the file at path")).toBe(
      "could not read the file at path",
    );
  });

  it("drops an amount whatever its magnitude", () => {
    expect(scrubText("balance is 0.04213500 after the send")).not.toContain(
      "0.04213500",
    );
    expect(scrubText("sent 12.5")).not.toContain("12.5");
    expect(scrubText("sent 4210000")).not.toContain("4210000");
  });

  it("drops a handle", () => {
    expect(scrubText("no route to @skylar")).toBe(
      "no route to [redacted:handle]",
    );
  });

  it("drops a URL and an absolute path", () => {
    expect(scrubText("GET https://relay.example.com/queue/7 failed")).not.toContain(
      "relay.example.com",
    );
    expect(
      scrubText("open /Users/someone/Library/Application failed"),
    ).not.toContain("someone");
  });

  it("drops non-Latin text, which is where message plaintext lives", () => {
    expect(scrubText("failed to send привет мир")).toBe(
      "failed to send [redacted:value] [redacted:value]",
    );
  });

  it("bounds prose rather than claiming to remove it", () => {
    // Stated as a test so the limit is recorded where someone will read it,
    // and so a future change that widens the cap has to change this number.
    const scrubbed = scrubText(`the send failed: ${PROSE}`);
    expect(scrubbed).toContain("the place we talked");
    expect(scrubbed.length).toBeLessThanOrEqual(250);
  });

  it("caps how much prose can transit at all", () => {
    const prose = Array.from({ length: 200 }, (_, index) =>
      index % 2 === 0 ? "Word" : "text",
    ).join(" ");
    const scrubbed = scrubText(prose);
    expect(scrubbed.length).toBeLessThanOrEqual(250);
    expect(scrubbed.endsWith("[…]")).toBe(true);
  });

  it("keeps the parts of an error that make it diagnosable", () => {
    expect(
      scrubText("TypeError: undefined is not a function (getEngineStatus)"),
    ).toBe("TypeError: undefined is not a function (getEngineStatus)");
  });
});

describe("a thrown object is described, never serialized", () => {
  it("records the type and nothing else", () => {
    const walletState = {
      seed: SECRETS.mnemonic,
      address: SECRETS.unifiedAddress,
      toString() {
        return `${this.seed} ${this.address}`;
      },
    };
    const serialized = captured(walletState);
    expect(serialized).not.toContain(SECRETS.mnemonic);
    expect(serialized).not.toContain(SECRETS.unifiedAddress);
    expect(serialized).toContain('"name":"Object"');
  });

  it("would be present without redaction, so the assertion is real", () => {
    // The passthrough scrubber still refuses to call `toString` — describing a
    // non-Error by type is a structural decision in `record.ts`, not a
    // redaction step — so the control here is that the message is empty rather
    // than that it leaks.
    expect(unredacted({ seed: SECRETS.mnemonic })).toContain('"message":""');
  });
});

describe("the buffer is scrubbed again on the way out of storage", () => {
  it("refuses text a tampered payload put there", () => {
    let written = "";
    const persistence = {
      read: () =>
        JSON.stringify({
          v: 1,
          environment: ENVIRONMENT,
          events: [
            {
              at: 1,
              kind: "uncaught-error",
              name: "Error",
              message: `leaked ${SECRETS.unifiedAddress}`,
              frames: [],
              breadcrumbs: [{ at: 1, category: "wallet", code: "not-a-code" }],
            },
          ],
        }),
      write: (value: string) => {
        written = value;
      },
      clear: () => {},
    };
    const store = new DiagnosticsStore({
      environment: ENVIRONMENT,
      persistence,
    });
    expect(JSON.stringify(store.events())).not.toContain(
      SECRETS.unifiedAddress,
    );
    // The breadcrumb code is not in the vocabulary, so it is dropped rather
    // than rendered.
    expect(JSON.stringify(store.events())).not.toContain("not-a-code");
    store.record("reported-error", new Error("later"));
    expect(written).not.toContain(SECRETS.unifiedAddress);
  });
});
