// The renderer's half of the native session slot (ADR 0017 §4.1).
//
// What matters here is what is published and in what order: a stale "signed
// in" landing after a "signed out" must not leave the wallet process holding a
// session the user ended, and a startup with no token must still say so.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FREE2Z_SESSION_COMMAND,
  createNativeSessionPublisher,
  installNativeSessionMirror,
} from "./native-session";
import { setToken } from "@/lib/api/http";

/** A slot the wallet process would hold. */
function nativeSlot() {
  const published: Array<string | null> = [];
  return {
    published,
    invoke: (command: string, args: unknown) => {
      expect(command).toBe(FREE2Z_SESSION_COMMAND);
      const token = (args as { args: { token: string | null } }).args.token;
      published.push(token);
      return Promise.resolve(null);
    },
  };
}

beforeEach(() => {
  setToken(null);
  vi.restoreAllMocks();
});

describe("mirroring the free2z session into the wallet process", () => {
  it("publishes the signed-out state at startup, and every change after it", async () => {
    const slot = nativeSlot();
    const listeners: Array<(token: string | null) => void> = [];
    const stop = installNativeSessionMirror({
      invoke: slot.invoke,
      token: () => null,
      subscribe: (listener) => {
        listeners.push(listener);
        return () => {
          listeners.length = 0;
        };
      },
    });
    // Silence is not "signed out": the native slot waits for a first answer,
    // so one is sent even when there is nothing to send. Publications are
    // queued, so a tick is what "has reached the wallet" means here.
    await Promise.resolve();
    expect(slot.published).toEqual([null]);
    listeners[0]?.("knox-token");
    await Promise.resolve();
    await Promise.resolve();
    expect(slot.published).toEqual([null, "knox-token"]);
    stop();
    expect(listeners).toHaveLength(0);
  });

  it("leaves the wallet holding the last value asked for, not the last to arrive", async () => {
    // The slot as the wallet holds it: whatever the last completed `invoke`
    // wrote. Asserting arrival order would pass on the bug this is about — a
    // stale sign-in landing last leaves a live session behind.
    let slot: string | null | undefined;
    const gate: { release: (() => void) | null } = { release: null };
    const publish = createNativeSessionPublisher({
      invoke: async (_command, args) => {
        const token = (args as { args: { token: string | null } }).args.token;
        if (token === "slow") {
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        slot = token;
        return null;
      },
      token: () => null,
      subscribe: () => () => {},
    });

    const slow = publish("slow");
    const signedOut = publish(null);
    // The first call is still in flight; release it and let the queue drain.
    gate.release?.();
    await Promise.all([slow, signedOut]);

    expect(slot).toBeNull();
  });

  it("drops a value that was overtaken before it was ever sent", async () => {
    const sent: Array<string | null> = [];
    const gate: { release: (() => void) | null } = { release: null };
    const publish = createNativeSessionPublisher({
      invoke: async (_command, args) => {
        const token = (args as { args: { token: string | null } }).args.token;
        if (token === "first") {
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        sent.push(token);
        return null;
      },
      token: () => null,
      subscribe: () => () => {},
    });

    const first = publish("first");
    // Two more while the first is in flight: only the newest may be sent.
    const second = publish("stale");
    const third = publish(null);
    gate.release?.();
    await Promise.all([first, second, third]);

    expect(sent).toEqual(["first", null]);
    expect(sent).not.toContain("stale");
  });

  it("does not break sign-in when the wallet process refuses", async () => {
    const failures: unknown[] = [];
    const publish = createNativeSessionPublisher({
      invoke: () => Promise.reject(new Error("no wallet")),
      token: () => null,
      subscribe: () => () => {},
      onFailure: (error) => failures.push(error),
    });
    await expect(publish("knox-token")).resolves.toBeUndefined();
    expect(failures).toHaveLength(1);
  });

  it("keeps publishing after a reporter throws", async () => {
    // The seam accepts a callback, so a callback that throws is a shape this
    // module has to survive: a `drain` that ended by throwing would leave the
    // queue holding a rejected promise and the mirror would never publish
    // again.
    const sent: Array<string | null> = [];
    const publish = createNativeSessionPublisher({
      invoke: (_command, args) => {
        const token = (args as { args: { token: string | null } }).args.token;
        sent.push(token);
        return token === "doomed"
          ? Promise.reject(new Error("the wallet refused"))
          : Promise.resolve(null);
      },
      token: () => null,
      subscribe: () => () => {},
      onFailure: () => {
        throw new Error("a reporter that throws");
      },
    });

    await publish("doomed");
    await publish("after");
    expect(sent).toEqual(["doomed", "after"]);
  });

  it("is inert in a browser, where there is no wallet process to tell", () => {
    // No `invoke` seam and no Tauri host: nothing is published and nothing
    // throws.
    expect(() => installNativeSessionMirror()()).not.toThrow();
  });
});
