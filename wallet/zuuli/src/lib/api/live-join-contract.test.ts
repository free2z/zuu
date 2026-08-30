import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http", async (importOriginal) => {
  const original = await importOriginal<typeof import("./http")>();
  return { ...original, request: vi.fn() };
});

import { live } from "./free2z";
import { request } from "./http";
import { LiveTicketError } from "./live-ticket";

const requestMock = vi.mocked(request);

function token(
  participantId: string,
  meetingId = "selected-meeting",
  orgId = "production-org",
): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  return `${encode({ alg: "RS256" })}.${encode({
    meetingId,
    participantId,
    orgId,
    exp: 4_102_444_800,
  })}.signature`;
}

describe("authoritative public live join and refresh", () => {
  beforeEach(() => requestMock.mockReset());

  it("binds the initial ticket to the exact meeting selected in discovery", async () => {
    const authToken = token("viewer-one");
    requestMock.mockResolvedValueOnce({
      auth_token: authToken,
      meeting_id: "selected-meeting",
    });

    await expect(
      live.join("alice", "broadcast", undefined, "participant", {
        expectedMeetingId: "selected-meeting",
      }),
    ).resolves.toMatchObject({
      authToken,
      meetingId: "selected-meeting",
      environmentId: "production-org",
      as: "participant",
    });
    expect(requestMock).toHaveBeenCalledWith("/api/dyte/alice/broadcast", {
      method: "POST",
    });
  });

  it("refreshes through one join request and never calls a creator management route", async () => {
    const previous = {
      authToken: token("viewer-one"),
      meetingId: "selected-meeting",
      environmentId: "production-org",
      as: "participant" as const,
    };
    const fresh = token("viewer-two");
    requestMock.mockResolvedValueOnce({
      auth_token: fresh,
      meeting_id: "selected-meeting",
    });

    await expect(
      live.refreshParticipant("alice", "broadcast", previous),
    ).resolves.toMatchObject({ authToken: fresh, meetingId: "selected-meeting" });
    expect(requestMock.mock.calls).toEqual([
      ["/api/dyte/alice/broadcast", { method: "POST" }],
    ]);
    expect(requestMock.mock.calls.flat().join(" ")).not.toContain("/private");
  });

  it("fails closed when retry replays, rotates rooms, or changes environment", async () => {
    const previous = {
      authToken: token("viewer-one"),
      meetingId: "selected-meeting",
      environmentId: "production-org",
      as: "participant" as const,
    };

    requestMock.mockResolvedValueOnce({
      auth_token: previous.authToken,
      meeting_id: "selected-meeting",
    });
    await expect(
      live.refreshParticipant("alice", "broadcast", previous),
    ).rejects.toMatchObject({
      code: "replayed-ticket",
    } satisfies Partial<LiveTicketError>);

    requestMock.mockResolvedValueOnce({
      auth_token: token("viewer-two", "rotated-meeting"),
      meeting_id: "rotated-meeting",
    });
    await expect(
      live.refreshParticipant("alice", "broadcast", previous),
    ).rejects.toMatchObject({
      code: "meeting-mismatch",
    } satisfies Partial<LiveTicketError>);

    requestMock.mockResolvedValueOnce({
      auth_token: token("viewer-three", "selected-meeting", "staging-org"),
      meeting_id: "selected-meeting",
    });
    await expect(
      live.refreshParticipant("alice", "broadcast", previous),
    ).rejects.toMatchObject({
      code: "environment-mismatch",
    } satisfies Partial<LiveTicketError>);
  });

  it("refuses to turn host recovery into a participant or room mutation", async () => {
    await expect(
      live.refreshParticipant("alice", "broadcast", {
        authToken: token("host"),
        meetingId: "selected-meeting",
        environmentId: "production-org",
        as: "host",
      }),
    ).rejects.toThrow("Only participant join tickets");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("uses the non-management secret join route for private viewer refresh", async () => {
    const inviteId = "123e4567-e89b-42d3-a456-426614174000";
    const previous = {
      authToken: token("private-viewer-one", "private-meeting"),
      meetingId: "private-meeting",
      environmentId: "production-org",
      as: "participant" as const,
    };
    requestMock.mockResolvedValueOnce({
      auth_token: token("private-viewer-two", "private-meeting"),
    });

    await live.refreshParticipant("alice", "private", previous, inviteId);
    expect(requestMock).toHaveBeenCalledWith(
      `/api/dyte/alice/private/${inviteId}`,
      { method: "POST" },
    );
    expect(requestMock.mock.calls[0]?.[0]).not.toBe("/api/dyte/alice/private");
  });
});
