import { describe, expect, it, vi } from "vitest";
import {
  SensitiveSeedSession,
  type SensitiveSeedAuthority,
} from "./sensitive-seed";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SensitiveSeedSession", () => {
  it("activates native protection before reading and publishing a phrase", async () => {
    const events: string[] = [];
    const authority: SensitiveSeedAuthority = {
      begin: async () => {
        events.push("protected");
        return "lease-1";
      },
      end: async () => {
        events.push("released");
      },
    };
    const session = new SensitiveSeedSession(authority, (phrase) =>
      events.push(`publish:${phrase}`),
    );

    await expect(
      session.reveal(async () => {
        events.push("custody-read");
        return "alpha beta gamma";
      }),
    ).resolves.toBe(true);
    expect(events).toEqual([
      "publish:null",
      "protected",
      "custody-read",
      "publish:alpha beta gamma",
    ]);
  });

  it("clears synchronously and discards a custody result that wins after blur", async () => {
    const read = deferred<string>();
    const published: Array<string | null> = [];
    const end = vi.fn(async () => {});
    const session = new SensitiveSeedSession(
      { begin: async () => "lease-1", end },
      (phrase) => published.push(phrase),
      (release) => release(),
    );

    const reveal = session.reveal(() => read.promise);
    await Promise.resolve();
    session.clear();
    expect(published[published.length - 1]).toBeNull();
    read.resolve("must never publish");

    await expect(reveal).resolves.toBe(false);
    expect(published).not.toContain("must never publish");
    expect(end).toHaveBeenCalledWith("lease-1");
  });

  it("releases protection and publishes no phrase when custody rejects", async () => {
    const published: Array<string | null> = [];
    const end = vi.fn(async () => {});
    const session = new SensitiveSeedSession(
      { begin: async () => "lease-failed", end },
      (phrase) => published.push(phrase),
      (release) => release(),
    );

    await expect(
      session.reveal(async () => {
        throw new Error("presence cancelled");
      }),
    ).rejects.toThrow("presence cancelled");
    expect(published).toEqual([null, null]);
    expect(end).toHaveBeenCalledWith("lease-failed");
  });

  it("cannot publish when cleared before native protection acquisition resolves", async () => {
    const begin = deferred<string>();
    const read = vi.fn(async () => "must never read");
    const end = vi.fn(async () => {});
    const session = new SensitiveSeedSession(
      { begin: () => begin.promise, end },
      () => {},
      (release) => release(),
    );
    const reveal = session.reveal(read);
    session.clear();
    begin.resolve("late-lease");

    await expect(reveal).resolves.toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledWith("late-lease");
  });

  it("does not release native protection until the cleared renderer is painted", async () => {
    const scheduled: Array<() => void> = [];
    const end = vi.fn(async () => {});
    const session = new SensitiveSeedSession(
      { begin: async () => "lease-painted", end },
      () => {},
      (release) => scheduled.push(release),
    );
    await session.reveal(async () => "alpha beta gamma");

    session.clear();
    expect(end).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    await Promise.resolve();
    expect(end).toHaveBeenCalledWith("lease-painted");
  });
});
