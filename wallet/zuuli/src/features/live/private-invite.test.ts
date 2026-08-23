import { describe, expect, it } from "vitest";
import {
  normalizePrivateSecret,
  parsePrivateInviteHash,
  privateInviteDisplayUrl,
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
    expect(
      privateInviteDisplayUrl({
        appOrigin: "https://app.example/base",
        publicWebBase: "",
        native: false,
        username: "alice",
        secret,
      }),
    ).toBe(url);
  });

  it("never shares a packaged native origin and uses the proven public route", () => {
    for (const appOrigin of ["tauri://localhost", "http://tauri.localhost"]) {
      const url = privateInviteDisplayUrl({
        appOrigin,
        publicWebBase: "https://free2z.cash/api?stale=1#stale",
        native: true,
        username: "alice/example",
        secret,
      });
      expect(url).toBe(`https://free2z.cash/alice%2Fexample/private/${secret}`);
      expect(url).not.toContain("localhost");
    }

    expect(
      privateInviteDisplayUrl({
        appOrigin: "tauri://localhost",
        publicWebBase: "http://tauri.localhost",
        native: true,
        username: "alice",
        secret,
      }),
    ).toBeNull();
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
