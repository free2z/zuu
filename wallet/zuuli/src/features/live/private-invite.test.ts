import { describe, expect, it } from "vitest";
import {
  normalizePrivateSecret,
  parsePrivateInviteHash,
  privateInviteHash,
  privateInvitePath,
  privateInviteUrl,
} from "@/lib/private-live";

const secret = "123e4567-e89b-42d3-a456-426614174000";

describe("private livestream invite", () => {
  it("keeps the opaque secret in the URL fragment", () => {
    expect(privateInviteHash(secret)).toBe(`#private=${secret}`);
    expect(privateInvitePath("alice/example", secret)).toBe(
      `/live/alice%2Fexample#private=${secret}`,
    );
    const url = privateInviteUrl("https://app.example/base", "alice", secret);
    expect(url).toBe(`https://app.example/live/alice#private=${secret}`);
    expect(new URL(url).pathname).not.toContain(secret);
    expect(new URL(url).search).not.toContain(secret);
  });

  it("accepts one canonical UUID and rejects decorated or malformed input", () => {
    expect(parsePrivateInviteHash(`#private=${secret.toUpperCase()}`)).toBe(
      secret,
    );
    expect(normalizePrivateSecret(` ${secret} `)).toBe(secret);
    for (const hash of [
      `#private=${secret}&tracking=1`,
      `#other=${secret}`,
      "#private=not-a-secret",
      "#private=%E0%A4%A",
    ]) {
      expect(parsePrivateInviteHash(hash)).toBeNull();
    }
  });
});
