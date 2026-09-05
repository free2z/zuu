// @vitest-environment jsdom
//
// `enroll`'s lazily imported chunk fails to load. It must still refuse in the
// typed way.
//
// `bridge.ts` reaches the intent client through a dynamic `import()`, matching
// the lazy `@tauri-apps/api/core` import beside it, so the browser bundle never
// requires either. That import can reject on its own: offline, a half-rolled
// deploy, a stale service worker holding a manifest whose chunks are gone.
//
// It fails closed either way — a rejected import cannot produce an
// `EnrollmentStatus`. What is at stake is narrower and still worth a test: the
// screen branches on `isEnrollmentUnavailable`, so an untyped escape would show
// a user "something went wrong" instead of the standing "enrollment happens in
// the wallet app" state, which is the one true thing this app can say. The
// typed refusal is the contract; every way this can fail has to wear it.
//
// Its own file because it plays with the module registry — `vi.resetModules()`
// plus a `vi.doMock` factory that throws — and a reset registry orphans the
// module instances other tests in a file have already captured. `enroll-intent
// .test.ts` registers a transport into exactly such an instance.
//
// The mutation that proves this is not inert: move the `import()` above the
// `try` in `bridge.ts` and the first assertion below fails, because the raw
// chunk-load error escapes `enroll` unwrapped.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnrollmentUnavailableError } from "./bridge";

const CHUNK_FAILURE = "Failed to fetch dynamically imported module";

afterEach(() => {
  vi.doUnmock("../enrollment/issueDeviceCredential");
  vi.resetModules();
});

describe("a chunk that never loads", () => {
  it("still refuses with the typed enrollment refusal", async () => {
    vi.resetModules();
    vi.doMock("../enrollment/issueDeviceCredential", () => {
      throw new Error(CHUNK_FAILURE);
    });

    // A fresh instance, so the mock applies to the import `enroll` performs.
    const { enrollment, EnrollmentUnavailableError: Refusal } = await import(
      "./bridge"
    );

    const refusal = await enrollment
      .enroll("alice")
      .catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(Refusal);
    const typed = refusal as EnrollmentUnavailableError;
    expect(typed.reason).toBe("enrollment-requires-wallet-app");
    expect(typed.method).toBe("enroll");
    // Not summarised away: whatever actually failed is still reachable from the
    // refusal, so a bug report can say which of the two failure modes this was.
    expect(typed.cause).toBeDefined();
  });

  it("never resolves, so the screen cannot read it as enrolled", async () => {
    vi.resetModules();
    vi.doMock("../enrollment/issueDeviceCredential", () => {
      throw new Error(CHUNK_FAILURE);
    });
    const { enrollment } = await import("./bridge");

    const settled = await enrollment.enroll("alice").then(
      (value) => ({ resolved: true as const, value }),
      () => ({ resolved: false as const }),
    );
    expect(settled.resolved).toBe(false);
  });
});
