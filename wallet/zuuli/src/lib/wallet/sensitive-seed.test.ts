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
  it("serializes forced cross-session reveals before either lease can be replaced", async () => {
    const begin = deferred<string>();
    const read = deferred<string>();
    const firstPublished: Array<string | null> = [];
    const secondPublished: Array<string | null> = [];
    let protectedDisplay = false;
    let currentToken: string | null = null;
    let consumed = false;
    let tokenCounter = 0;
    const authority: SensitiveSeedAuthority = {
      begin: vi.fn(async () => {
        if (consumed) {
          throw new Error("consumed native lease cannot be replaced");
        }
        if (tokenCounter === 0) await begin.promise;
        protectedDisplay = true;
        currentToken = `lease-serialized-${++tokenCounter}`;
        return currentToken;
      }),
      end: vi.fn(async (token) => {
        if (currentToken === token) {
          currentToken = null;
          consumed = false;
          protectedDisplay = false;
        }
      }),
    };
    const firstRead = vi.fn(() => {
      consumed = true;
      return read.promise;
    });
    const secondRead = vi.fn(async () => "must never read");
    const first = new SensitiveSeedSession(
      authority,
      (phrase) => {
        if (phrase) expect(protectedDisplay).toBe(true);
        firstPublished.push(phrase);
      },
      (release) => release(),
    );
    const second = new SensitiveSeedSession(
      authority,
      (phrase) => secondPublished.push(phrase),
      (release) => release(),
    );

    const firstReveal = first.reveal(firstRead);
    const overlappingReveal = second.reveal(secondRead);

    await expect(overlappingReveal).resolves.toBe(false);
    expect(authority.begin).toHaveBeenCalledTimes(1);
    expect(firstRead).not.toHaveBeenCalled();
    expect(secondRead).not.toHaveBeenCalled();
    expect(secondPublished).toEqual([]);

    begin.resolve("ignored");
    await vi.waitFor(() => expect(firstRead).toHaveBeenCalledTimes(1));
    read.resolve("covered phrase");
    await expect(firstReveal).resolves.toBe(true);
    expect(firstPublished).toEqual([null, "covered phrase"]);
    expect(protectedDisplay).toBe(true);

    await expect(
      second.reveal(async () => "must not replace published phrase"),
    ).rejects.toThrow("consumed native lease cannot be replaced");
    expect(firstPublished[firstPublished.length - 1]).toBe("covered phrase");
    expect(protectedDisplay).toBe(true);
    expect(currentToken).toBe("lease-serialized-1");

    first.clear();
    await vi.waitFor(() => expect(protectedDisplay).toBe(false));

    await expect(
      second.reveal(async () => {
        consumed = true;
        return "new phrase after exact release";
      }),
    ).resolves.toBe(true);
    expect(secondPublished[secondPublished.length - 1]).toBe(
      "new phrase after exact release",
    );
    expect(protectedDisplay).toBe(true);
    second.clear();
    await vi.waitFor(() => expect(protectedDisplay).toBe(false));
  });

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
      session.reveal(async (token) => {
        events.push(`read-token:${token}`);
        events.push("custody-read");
        return "alpha beta gamma";
      }),
    ).resolves.toBe(true);
    expect(events).toEqual([
      "publish:null",
      "protected",
      "read-token:lease-1",
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
