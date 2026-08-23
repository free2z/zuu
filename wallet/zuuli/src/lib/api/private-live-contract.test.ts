import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http", async (importOriginal) => {
  const original = await importOriginal<typeof import("./http")>();
  return { ...original, request: vi.fn() };
});

import { live, PrivateRoomUnavailableError } from "./free2z";
import { ApiError, request } from "./http";

const requestMock = vi.mocked(request);
const secret = "123e4567-e89b-42d3-a456-426614174000";

describe("private livestream HTTP contract", () => {
  beforeEach(() => requestMock.mockReset());

  it("creates the secret and then joins the same private room as host", async () => {
    requestMock
      .mockResolvedValueOnce({ username: "alice", tuzis: "500" })
      .mockResolvedValueOnce({ secret, e2ee: true, meeting_id: "not-a-ticket" })
      .mockResolvedValueOnce({ auth_token: "host-ticket", e2ee: true });

    await expect(live.start("private")).resolves.toEqual({
      inviteSecret: secret,
      ticket: {
        authToken: "host-ticket",
        meetingId: "",
        as: "host",
      },
    });
    expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/auth/user/",
      "/api/dyte/alice/private",
      `/api/dyte/alice/private/${secret}`,
    ]);
    expect(requestMock.mock.calls[1]?.[1]).toEqual({ method: "POST" });
    expect(requestMock.mock.calls[2]?.[1]).toEqual({ method: "POST" });
  });

  it("does not invent a host ticket when creation omits a valid secret", async () => {
    requestMock
      .mockResolvedValueOnce({ username: "alice", tuzis: "500" })
      .mockResolvedValueOnce({ auth_token: "wrong-stage-token" });
    await expect(live.start("private")).rejects.toThrow(
      "Private room creation returned no safe invite",
    );
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed and expired invites without disclosing backend metadata", async () => {
    await expect(
      live.join("alice", "private", "../public"),
    ).rejects.toBeInstanceOf(PrivateRoomUnavailableError);
    expect(requestMock).not.toHaveBeenCalled();

    requestMock.mockRejectedValueOnce(
      new ApiError(404, "meeting 991 belongs to alice", {
        detail: "meeting 991 belongs to alice",
      }),
    );
    const error = await live
      .join("alice", "private", secret)
      .catch((value) => value);
    expect(error).toBeInstanceOf(PrivateRoomUnavailableError);
    expect(String(error)).not.toContain("991");
  });

  it("uses the secret join endpoint for cold guests and refreshed hosts", async () => {
    requestMock
      .mockResolvedValueOnce({ auth_token: "guest-ticket" })
      .mockResolvedValueOnce({ auth_token: "refreshed-host-ticket" });
    await expect(live.join("alice", "private", secret)).resolves.toMatchObject({
      authToken: "guest-ticket",
      as: "participant",
    });
    await expect(
      live.join("alice", "private", secret, "host"),
    ).resolves.toMatchObject({
      authToken: "refreshed-host-ticket",
      as: "host",
    });
    expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
      `/api/dyte/alice/private/${secret}`,
      `/api/dyte/alice/private/${secret}`,
    ]);
  });

  it("keeps private meetings out of public discovery and its cache", async () => {
    const creator = {
      username: "alice",
      full_name: "Alice",
      free2zaddr: "alice",
    };
    requestMock.mockResolvedValueOnce({
      results: [
        {
          id: 1,
          creator,
          meeting_id: "private-id",
          meeting_type: "private",
          live_now: true,
        },
        {
          id: 2,
          creator,
          meeting_id: "public-id",
          meeting_type: "broadcast",
          live_now: true,
        },
      ],
    });
    await expect(live.listPublic({ force: true })).resolves.toMatchObject([
      { id: "2", kind: "broadcast" },
    ]);
    await expect(live.listPublic()).resolves.toMatchObject([
      { id: "2", kind: "broadcast" },
    ]);
    expect(requestMock).toHaveBeenCalledOnce();
  });
});
