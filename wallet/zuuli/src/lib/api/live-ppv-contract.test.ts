import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http", async (importOriginal) => {
  const original = await importOriginal<typeof import("./http")>();
  return { ...original, request: vi.fn() };
});

import { live, LivestreamKindContractError } from "./free2z";
import { request } from "./http";
import type { StreamKind } from "./types";

const requestMock = vi.mocked(request);

function meeting(meetingType: unknown, pricePerMinute = "2") {
  return {
    id: 814,
    creator: { username: "alice", full_name: "Alice" },
    meeting_id: "authoritative-meeting",
    meeting_type: meetingType,
    live_now: true,
    price_per_minute: pricePerMinute,
  };
}

describe("PPV livestream HTTP contract", () => {
  beforeEach(() => requestMock.mockReset());

  it("round-trips the authoritative ppv kind through listing, status, pricing, join, and host start", async () => {
    requestMock
      .mockResolvedValueOnce({ results: [meeting("ppv")] })
      .mockResolvedValueOnce({
        ppv: { meeting_type: "ppv", participants: 3 },
        "pay-per-view": {
          meeting_type: "pay-per-view",
          participants: 99,
        },
      })
      .mockResolvedValueOnce({
        meeting_id: "authoritative-meeting",
        auth_token: "participant-ticket",
      })
      .mockResolvedValueOnce({ username: "alice", tuzis: "500" })
      .mockResolvedValueOnce({
        meeting_id: "authoritative-meeting",
        auth_token: "host-ticket",
      });

    const [stream] = await live.listPublic({ force: true });
    expect(stream).toMatchObject({
      id: "814",
      username: "alice",
      kind: "ppv",
      price_tuzis: 75,
    });
    await expect(live.status("alice", stream!.kind)).resolves.toEqual({
      live: true,
      participants: 3,
    });

    await expect(live.join("alice", stream!.kind)).resolves.toMatchObject({
      authToken: "participant-ticket",
      meetingId: "authoritative-meeting",
      as: "participant",
    });
    await expect(live.start(stream!.kind)).resolves.toMatchObject({
      ticket: {
        authToken: "host-ticket",
        meetingId: "authoritative-meeting",
        as: "host",
      },
    });

    expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/dyte/public/",
      "/api/dyte/alice/live-status",
      "/api/dyte/alice/ppv",
      "/api/auth/user/",
      "/api/dyte/alice/ppv",
    ]);
  });

  it.each(["pay-per-view", "subscriber", "unknown", null])(
    "rejects the non-contract listing kind %j instead of classifying it as free or paid",
    async (meetingType) => {
      requestMock.mockResolvedValueOnce({ results: [meeting(meetingType)] });

      await expect(live.listPublic({ force: true })).rejects.toBeInstanceOf(
        LivestreamKindContractError,
      );
    },
  );

  it("rejects the invented pay-per-view alias before join or host requests", async () => {
    const invalidAlias = "pay-per-view" as StreamKind;

    await expect(live.join("alice", invalidAlias)).rejects.toBeInstanceOf(
      LivestreamKindContractError,
    );
    await expect(live.start(invalidAlias)).rejects.toBeInstanceOf(
      LivestreamKindContractError,
    );
    expect(requestMock).not.toHaveBeenCalled();
  });
});
