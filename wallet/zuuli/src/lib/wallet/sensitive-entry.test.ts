import { describe, expect, it, vi } from "vitest";
import {
  SENSITIVE_ENTRY_PURPOSES,
  SensitiveEntrySession,
  bindSensitiveEntryLifecycle,
  type SensitiveEntryAuthority,
} from "../../../../shared/sensitive-entry-session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SensitiveEntrySession", () => {
  it("protects the exact three typed-mnemonic purposes before editability", async () => {
    expect(SENSITIVE_ENTRY_PURPOSES).toEqual([
      "zuuliRestore",
      "zuualletRestore",
      "zuualletRelink",
    ]);

    for (const purpose of SENSITIVE_ENTRY_PURPOSES) {
      const acquired = deferred<string>();
      const events: string[] = [];
      const authority: SensitiveEntryAuthority = {
        begin: vi.fn(async (requestedPurpose) => {
          events.push(`begin:${requestedPurpose}`);
          return acquired.promise;
        }),
        end: vi.fn(async () => {}),
      };
      const session = new SensitiveEntrySession(
        authority,
        purpose,
        () => events.push("clear"),
        (editable) => events.push(`editable:${editable}`),
      );

      const acquisition = session.acquire();
      expect(events).toEqual(["clear", "editable:false", `begin:${purpose}`]);
      acquired.resolve(`token:${purpose}`);
      await expect(acquisition).resolves.toBe(true);
      expect(events).toEqual([
        "clear",
        "editable:false",
        `begin:${purpose}`,
        "editable:true",
      ]);
    }
  });

  it("clears and disables before releasing the exact token and purpose", async () => {
    const events: string[] = [];
    const scheduled: Array<() => void> = [];
    let value = "alpha beta gamma";
    const end = vi.fn(async (token: string, purpose: string) => {
      events.push(`end:${token}:${purpose}:value=${value}`);
    });
    const authority: SensitiveEntryAuthority = {
      begin: async () => "entry-token",
      end,
    };
    const session = new SensitiveEntrySession(
      authority,
      "zuualletRelink",
      () => {
        value = "";
        events.push("clear");
      },
      (editable) => events.push(`editable:${editable}`),
      (release) => scheduled.push(release),
    );
    await session.acquire();
    value = "alpha beta gamma";
    events.length = 0;

    const cleared = session.clear();
    expect(events).toEqual(["clear", "editable:false"]);
    expect(scheduled).toHaveLength(1);
    expect(end).not.toHaveBeenCalled();
    scheduled[0]();
    await cleared;
    expect(events).toEqual([
      "clear",
      "editable:false",
      "end:entry-token:zuualletRelink:value=",
    ]);
  });

  it("stays cleared and disabled when native acquisition fails", async () => {
    const values = ["typed mnemonic"];
    const editable: boolean[] = [];
    const session = new SensitiveEntrySession(
      {
        begin: async () => {
          throw new Error("native protection unavailable");
        },
        end: async () => {},
      },
      "zuuliRestore",
      () => values.push(""),
      (enabled) => editable.push(enabled),
    );

    await expect(session.acquire()).rejects.toThrow(
      "native protection unavailable",
    );
    expect(values).toEqual(["typed mnemonic", "", ""]);
    expect(editable).toEqual([false, false]);
  });

  it("rejects an empty native token and keeps the surface disabled", async () => {
    const editable: boolean[] = [];
    const session = new SensitiveEntrySession(
      { begin: async () => "", end: async () => {} },
      "zuuliRestore",
      () => {},
      (enabled) => editable.push(enabled),
    );
    await expect(session.acquire()).rejects.toThrow(
      "Sensitive-entry lease token is missing.",
    );
    expect(editable).toEqual([false, false]);
  });

  it("shares one native acquisition across overlapping and active calls", async () => {
    const acquired = deferred<string>();
    const begin = vi.fn(() => acquired.promise);
    const session = new SensitiveEntrySession(
      { begin, end: async () => {} },
      "zuualletRestore",
      () => {},
      () => {},
    );
    const first = session.acquire();
    const overlap = session.acquire();
    expect(begin).toHaveBeenCalledTimes(1);
    acquired.resolve("single-token");
    await expect(Promise.all([first, overlap])).resolves.toEqual([true, true]);
    await expect(session.acquire()).resolves.toBe(true);
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it("releases a late acquisition without ever enabling the stale surface", async () => {
    const acquired = deferred<string>();
    const end = vi.fn(async () => {});
    const editable: boolean[] = [];
    const session = new SensitiveEntrySession(
      { begin: () => acquired.promise, end },
      "zuualletRestore",
      () => {},
      (enabled) => editable.push(enabled),
      (release) => release(),
    );

    const acquisition = session.acquire();
    await session.clear();
    acquired.resolve("late-token");
    await expect(acquisition).resolves.toBe(false);
    expect(editable).toEqual([false, false]);
    expect(end).toHaveBeenCalledWith("late-token", "zuualletRestore");
  });

  it("reacquires after a pending lease was invalidated by lifecycle cleanup", async () => {
    const first = deferred<string>();
    const end = vi.fn(async () => {});
    const begin = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce("replacement-token");
    const editable: boolean[] = [];
    const session = new SensitiveEntrySession(
      { begin, end },
      "zuuliRestore",
      () => {},
      (enabled) => editable.push(enabled),
      (release) => release(),
    );

    const stale = session.acquire();
    await session.clear();
    const replacement = session.acquire();
    first.resolve("stale-token");

    await expect(stale).resolves.toBe(false);
    await expect(replacement).resolves.toBe(true);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledWith("stale-token", "zuuliRestore");
    expect(editable).toEqual([false, false, false, true]);
  });

  it("clears every lifecycle loss and reacquires only after release", async () => {
    class Events {
      private listeners = new Map<string, Set<() => void>>();
      addEventListener(type: string, listener: () => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
      removeEventListener(type: string, listener: () => void) {
        this.listeners.get(type)?.delete(listener);
      }
      dispatch(type: string) {
        for (const listener of this.listeners.get(type) ?? []) listener();
      }
    }
    const windowTarget = new Events();
    const documentTarget = new Events();
    const events: string[] = [];
    let visible = true;
    let release!: () => void;
    const clear = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          events.push("clear");
          release = () => {
            events.push("released");
            resolve();
          };
        }),
    );
    const acquire = vi.fn(async () => events.push("acquire"));
    const unbind = bindSensitiveEntryLifecycle(
      windowTarget,
      documentTarget,
      () => visible,
      clear,
      acquire,
    );

    windowTarget.dispatch("blur");
    expect(events).toEqual(["clear"]);
    release();
    await Promise.resolve();

    windowTarget.dispatch("pagehide");
    expect(events).toEqual(["clear", "released", "clear"]);
    release();
    await Promise.resolve();

    visible = false;
    documentTarget.dispatch("visibilitychange");
    expect(events).toEqual([
      "clear",
      "released",
      "clear",
      "released",
      "clear",
    ]);
    release();
    await Promise.resolve();

    visible = true;
    documentTarget.dispatch("visibilitychange");
    expect(events[events.length - 1]).toBe("clear");
    expect(acquire).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() =>
      expect(events[events.length - 1]).toBe("acquire"),
    );

    windowTarget.dispatch("focus");
    expect(events[events.length - 1]).toBe("clear");
    release();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));

    unbind();
    expect(events[events.length - 1]).toBe("clear");
    release();
    windowTarget.dispatch("blur");
    expect(clear).toHaveBeenCalledTimes(6);
  });
});
