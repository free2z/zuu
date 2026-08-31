import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http", async (importOriginal) => {
  const original = await importOriginal<typeof import("./http")>();
  return { ...original, request: vi.fn() };
});

import {
  live,
  LivestreamKindContractError,
  LivestreamPriceContractError,
} from "./free2z";
import { request } from "./http";
import type { StreamKind } from "./types";

const requestMock = vi.mocked(request);

function meeting(meetingType: unknown, ...pricePerMinute: [unknown?]) {
  return {
    id: 814,
    creator: { username: "alice", full_name: "Alice" },
    meeting_id: "authoritative-meeting",
    meeting_type: meetingType,
    live_now: true,
    price_per_minute: pricePerMinute.length ? pricePerMinute[0] : "2",
  };
}

describe("PPV livestream HTTP contract", () => {
  beforeEach(() => requestMock.mockReset());

  it("round-trips the authoritative ppv kind through listing, status, and participant join", async () => {
    requestMock
      .mockResolvedValueOnce({ results: [meeting("ppv")] })
      .mockResolvedValueOnce({
        ppv: { meeting_type: "ppv", participants: 3 },
      })
      .mockResolvedValueOnce({
        meeting_id: "authoritative-meeting",
        auth_token: "participant-ticket",
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
    expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/dyte/public/",
      "/api/dyte/alice/live-status",
      "/api/dyte/alice/ppv",
    ]);
  });

  it("uses the ppv wire enum for the existing host-start endpoint", async () => {
    requestMock
      .mockResolvedValueOnce({ username: "alice", tuzis: "500" })
      .mockResolvedValueOnce({
        meeting_id: "authoritative-meeting",
        auth_token: "host-ticket",
      });

    await expect(live.start("ppv")).resolves.toMatchObject({
      ticket: {
        authToken: "host-ticket",
        meetingId: "authoritative-meeting",
        as: "host",
      },
    });
    expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/auth/user/",
      "/api/dyte/alice/ppv",
    ]);
  });

  it.each([
    ["0.01", 16],
    ["2.00", 75],
    ["8.30", 264],
    ["9999.99", 300_015],
  ])(
    "computes the exact backend PPV entry price for %s",
    async (rate, price) => {
      requestMock.mockResolvedValueOnce({ results: [meeting("ppv", rate)] });

      const [stream] = await live.listPublic({ force: true });

      expect(stream?.price_tuzis).toBe(price);
    },
  );

  it.each([undefined, null, 2, "", "0", "0.00", "-1", "1e2", "1.234", "nope"])(
    "rejects the invalid PPV rate %j",
    async (rate) => {
      requestMock.mockResolvedValueOnce({ results: [meeting("ppv", rate)] });

      await expect(live.listPublic({ force: true })).rejects.toBeInstanceOf(
        LivestreamPriceContractError,
      );
    },
  );

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

  it("rejects an invalid status kind before making a request", async () => {
    const invalidAlias = "pay-per-view" as StreamKind;

    await expect(live.status("alice", invalidAlias)).rejects.toBeInstanceOf(
      LivestreamKindContractError,
    );
    expect(requestMock).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown key", { legacy: { meeting_type: "ppv", participants: 3 } }],
    [
      "unknown entry kind",
      { ppv: { meeting_type: "legacy", participants: 3 } },
    ],
    ["missing entry kind", { ppv: { participants: 3 } }],
    [
      "mismatched key and entry",
      { ppv: { meeting_type: "broadcast", participants: 3 } },
    ],
  ])("rejects a status response with %s", async (_description, response) => {
    requestMock.mockResolvedValueOnce(response);

    await expect(live.status("alice", "ppv")).rejects.toBeInstanceOf(
      LivestreamKindContractError,
    );
  });
});
