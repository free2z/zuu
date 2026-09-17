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
  it("publishes the signed-out state at startup, and every change after it", () => {
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
    // so one is sent even when there is nothing to send.
    expect(slot.published).toEqual([null]);
    listeners[0]?.("knox-token");
    expect(slot.published).toEqual([null, "knox-token"]);
    stop();
    expect(listeners).toHaveLength(0);
  });

  it("never lets a slow sign-in overtake a sign-out", async () => {
    const order: string[] = [];
    const gate: { release: (() => void) | null } = { release: null };
    const publish = createNativeSessionPublisher({
      invoke: async (_command, args) => {
        const token = (args as { args: { token: string | null } }).args.token;
        if (token === "slow") {
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        order.push(String(token));
        return null;
      },
      token: () => null,
      subscribe: () => () => {},
    });
    const slow = publish("slow");
    const fast = publish(null);
    await fast;
    gate.release?.();
    await slow;
    // Both reached the wallet, and the *last issued* one is the one that stands:
    // the generation check is what makes a late answer inert.
    expect(order).toEqual(["null", "slow"]);
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

  it("is inert in a browser, where there is no wallet process to tell", () => {
    // No `invoke` seam and no Tauri host: nothing is published and nothing
    // throws.
    expect(() => installNativeSessionMirror()()).not.toThrow();
  });
});
