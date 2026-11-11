// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

describe("mock creator-follow persistence", () => {
  it("scopes follow rows to each mock viewer across reloads", async () => {
    const firstSession = await import("./mock-data");
    expect(firstSession.mockCreatorFollow("fan-one", "creator", "follow")).toBe(
      true,
    );
    expect(firstSession.mockCreatorFollow("fan-one", "creator", "state")).toBe(
      true,
    );
    expect(firstSession.mockCreatorFollow("fan-two", "creator", "state")).toBe(
      false,
    );

    vi.resetModules();
    const reloadedSession = await import("./mock-data");
    expect(
      reloadedSession.mockCreatorFollow("fan-one", "creator", "state"),
    ).toBe(true);
    expect(
      reloadedSession.mockCreatorFollow("fan-two", "creator", "state"),
    ).toBe(false);
    expect(
      reloadedSession.mockCreatorFollow("fan-two", "creator", "follow"),
    ).toBe(true);
    expect(
      reloadedSession.mockCreatorFollow("fan-one", "creator", "state"),
    ).toBe(true);
  });
});
