import test from "node:test";
import assert from "node:assert/strict";
import {
  collectScreenShares,
  diffScreenShareSubscriptions,
} from "../src/lib/utils/concurrent-screen-shares.ts";

const track = { id: "track", kind: "video" };

test("collects two simultaneous participant shares and excludes inactive tracks", () => {
  assert.deepEqual(
    collectScreenShares([
      {
        id: "b",
        name: "Bea",
        screenShareEnabled: true,
        screenShareTracks: { video: track },
      },
      {
        id: "a",
        name: "Ada",
        screenShareEnabled: true,
        screenShareTracks: { video: track },
      },
      {
        id: "c",
        name: "Cam",
        screenShareEnabled: false,
        screenShareTracks: { video: track },
      },
    ]),
    [
      { id: "a", label: "Ada" },
      { id: "b", label: "Bea" },
    ],
  );
});

test("stop and participant leave remove their screenshare subscription", () => {
  assert.deepEqual(diffScreenShareSubscriptions(["a", "b"], ["b"]), {
    subscribe: [],
    unsubscribe: ["a"],
  });
  assert.deepEqual(diffScreenShareSubscriptions(["b"], []), {
    subscribe: [],
    unsubscribe: ["b"],
  });
});

test("missing permission is excluded and unhydrated screen shares remain discoverable", () => {
  assert.deepEqual(
    collectScreenShares([
      {
        id: "denied",
        name: "Denied",
        screenShareEnabled: false,
        screenShareTracks: { video: track },
      },
      { id: "unsupported", name: "Unsupported", screenShareEnabled: true },
    ]),
    [{ id: "unsupported", label: "Unsupported" }],
  );
});
