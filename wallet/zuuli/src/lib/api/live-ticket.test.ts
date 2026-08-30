import { describe, expect, it } from "vitest";
import {
  LiveTicketError,
  parseJoinTicketResponse,
} from "./live-ticket";

const NOW = 2_000_000_000_000;

function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = { alg: "RS256" },
): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  return `${encode(header)}.${encode({
    meetingId: "meeting-one",
    orgId: "production-org",
    participantId: "viewer-participant",
    exp: 2_100_000_000,
    ...claims,
  })}.signature`;
}

function parse(
  response: unknown,
  overrides: Partial<Parameters<typeof parseJoinTicketResponse>[1]> = {},
) {
  return parseJoinTicketResponse(response, {
    as: "participant",
    responseMeetingIdRequired: true,
    nowMs: NOW,
    ...overrides,
  });
}

async function failure(operation: () => unknown): Promise<LiveTicketError> {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(LiveTicketError);
    return error as LiveTicketError;
  }
  throw new Error("Expected ticket parsing to fail");
}

describe("strict RealtimeKit join ticket parsing", () => {
  it("returns only the bounded provider data needed by the meeting stage", () => {
    const authToken = token({
      email: "must-not-escape@example.test",
      private_url: "https://private.invalid/secret",
      nested: { identity: "must-not-escape" },
    });

    expect(parse({ auth_token: authToken, meeting_id: "meeting-one" })).toEqual({
      authToken,
      meetingId: "meeting-one",
      environmentId: "production-org",
      expiresAt: 2_100_000_000,
      as: "participant",
    });
  });

  it.each([
    null,
    {},
    { auth_token: "" },
    { auth_token: "not-a-participant-token", meeting_id: "meeting-one" },
    { auth_token: "a.b.c", meeting_id: "meeting-one" },
    { auth_token: token({ meetingId: "" }), meeting_id: "meeting-one" },
    { auth_token: token({ orgId: null }), meeting_id: "meeting-one" },
    { auth_token: token({ participantId: [] }), meeting_id: "meeting-one" },
    { auth_token: token({ exp: "2100000000" }), meeting_id: "meeting-one" },
    { auth_token: token(), meeting_id: " meeting-one" },
  ])("fails closed on a malformed response without echoing it: %#", async (value) => {
    const error = await failure(() => parse(value));
    expect(error.code).toBe("malformed-ticket");
    expect(error.message).not.toContain("participant");
    expect(error.message).not.toContain("meeting-one");
  });

  it("requires meeting_id on the public contract but derives it for private joins", async () => {
    const authToken = token();
    const publicError = await failure(() => parse({ auth_token: authToken }));
    expect(publicError.code).toBe("malformed-ticket");

    expect(
      parse(
        { auth_token: authToken },
        { responseMeetingIdRequired: false },
      ).meetingId,
    ).toBe("meeting-one");
  });

  it("rejects an expired credential before RealtimeKit sees it", async () => {
    const error = await failure(() =>
      parse({
        auth_token: token({ exp: NOW / 1_000 }),
        meeting_id: "meeting-one",
      }),
    );
    expect(error.code).toBe("expired-ticket");
  });

  it("binds the response, token, and selected listing to one meeting", async () => {
    const responseMismatch = await failure(() =>
      parse({ auth_token: token(), meeting_id: "meeting-two" }),
    );
    expect(responseMismatch.code).toBe("meeting-mismatch");

    const rotatedListing = await failure(() =>
      parse(
        { auth_token: token(), meeting_id: "meeting-one" },
        { expectedMeetingId: "meeting-before-rotation" },
      ),
    );
    expect(rotatedListing.code).toBe("meeting-mismatch");
  });

  it("rejects environment changes and credential replay during refresh", async () => {
    const first = token();
    const wrongEnvironment = await failure(() =>
      parse(
        {
          auth_token: token({ orgId: "staging-org", participantId: "new-viewer" }),
          meeting_id: "meeting-one",
        },
        { expectedEnvironmentId: "production-org" },
      ),
    );
    expect(wrongEnvironment.code).toBe("environment-mismatch");

    const replay = await failure(() =>
      parse(
        { auth_token: first, meeting_id: "meeting-one" },
        { previousAuthToken: first },
      ),
    );
    expect(replay.code).toBe("replayed-ticket");
  });
});
