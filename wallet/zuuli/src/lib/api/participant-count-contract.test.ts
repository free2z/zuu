import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http", async (importOriginal) => {
  const original = await importOriginal<typeof import("./http")>();
  return { ...original, request: vi.fn() };
});

import { live } from "./free2z";
import { request } from "./http";

const requestMock = vi.mocked(request);
const creator = {
  username: "alice",
  full_name: "Alice",
  free2zaddr: "alice",
};

describe("participant count hydration contract", () => {
  beforeEach(() => requestMock.mockReset());

  it("coalesces concurrent listing reads and never invents a count absent from that endpoint", async () => {
    requestMock.mockResolvedValue({
      results: [
        {
          id: 1,
          creator,
          meeting_id: "broadcast-id",
          meeting_type: "broadcast",
          live_now: true,
        },
      ],
    });

    const first = live.listPublic({ force: true });
    const second = live.listPublic({ force: true });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(requestMock).toHaveBeenCalledOnce();
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toHaveLength(1);
    expect(firstResult[0]?.participants).toBeNull();
  });

  it("preserves an authoritative zero and complete multi-room total", async () => {
    requestMock
      .mockResolvedValueOnce({ broadcast: { participants: 0 } })
      .mockResolvedValueOnce({
        broadcast: { participants: 9 },
        "pay-per-view": { participants: 4 },
      });

    await expect(live.status("alice", "broadcast")).resolves.toEqual({
      live: true,
      participants: 0,
    });
    await expect(live.status("alice")).resolves.toEqual({
      live: true,
      participants: 13,
    });
  });

  it("makes missing or malformed partial hydration explicitly unavailable", async () => {
    requestMock
      .mockResolvedValueOnce({ broadcast: {} })
      .mockResolvedValueOnce({
        broadcast: { participants: 9 },
        "pay-per-view": {},
      })
      .mockResolvedValueOnce({ broadcast: { participants: "9" } });

    await expect(live.status("alice")).resolves.toEqual({
      live: true,
      participants: null,
    });
    await expect(live.status("alice")).resolves.toEqual({
      live: true,
      participants: null,
    });
    await expect(live.status("alice")).resolves.toEqual({
      live: true,
      participants: null,
    });
  });

  it("returns unavailable on empty and failed hydration instead of fabricated zero", async () => {
    requestMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("offline"));

    await expect(live.status("alice")).resolves.toEqual({
      live: false,
      participants: null,
    });
    await expect(live.status("alice")).resolves.toEqual({
      live: false,
      participants: null,
    });
  });
});
