import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  classifyHostSeat,
  hostSeatConflict,
  newHostSession,
  openHostSeatChannel,
  startHostSeatHeartbeat,
} from "../src/lib/utils/host-seat.js";

//  -- one broadcaster seat per creator. The server enforces it; these
// pin the browser half: what the dashboard shows, when it gives up the room,
// and that same-browser tabs hear about a take-over at once.

test("a seat is only 'mine' when the server names this tab's session", () => {
  assert.equal(classifyHostSeat(null, "a"), "free");
  assert.equal(classifyHostSeat({ active: false }, "a"), "free");
  assert.equal(
    classifyHostSeat({ active: true, host_session: "a" }, "a"),
    "mine",
  );
  assert.equal(
    classifyHostSeat({ active: true, host_session: "b" }, "a"),
    "elsewhere",
  );
  // Active but unnamed is still somebody else's -- never a green light.
  assert.equal(classifyHostSeat({ active: true }, "a"), "elsewhere");
});

test("only the server's two seat 409s are seat conflicts", () => {
  assert.deepEqual(
    hostSeatConflict({
      status: 409,
      data: {
        code: "already_live_elsewhere",
        meeting_type: "ppv",
        last_seen_at: "2026-09-28T00:00:00Z",
      },
    }),
    {
      code: "already_live_elsewhere",
      meetingType: "ppv",
      lastSeenAt: "2026-09-28T00:00:00Z",
    },
  );
  assert.equal(
    hostSeatConflict({ status: 409, data: { code: "host_session_superseded" } })
      ?.code,
    "host_session_superseded",
  );
  assert.equal(
    hostSeatConflict({ status: 409, data: { code: "other" } }),
    null,
  );
  assert.equal(
    hostSeatConflict({ status: 400, data: { code: "already_live_elsewhere" } }),
    null,
  );
  assert.equal(hostSeatConflict(new Error("offline")), null);
  assert.equal(hostSeatConflict(undefined), null);
});

test("every page load gets its own seat id", () => {
  const ids = new Set(Array.from({ length: 50 }, () => newHostSession()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
  // The getRandomValues fallback is a valid v4 UUID too.
  const fallback = newHostSession({});
  assert.match(
    fallback,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

function manualTimers() {
  let callback = null;
  let cleared = false;
  return {
    timers: {
      setInterval: (fn) => {
        callback = fn;
        return 1;
      },
      clearInterval: () => {
        cleared = true;
      },
    },
    tick: () => callback?.(),
    get cleared() {
      return cleared;
    },
  };
}

test("the heartbeat stops and hands over the moment the seat is taken", async () => {
  const clock = manualTimers();
  let superseded = 0;
  let beats = 0;
  let answer = () => Promise.resolve({ active: true });
  startHostSeatHeartbeat({
    beat: () => {
      beats += 1;
      return answer();
    },
    onSuperseded: () => {
      superseded += 1;
    },
    timers: clock.timers,
  });

  await clock.tick();
  assert.equal(superseded, 0);

  answer = () =>
    Promise.reject({ status: 409, data: { code: "host_session_superseded" } });
  await clock.tick();
  assert.equal(superseded, 1);
  assert.equal(clock.cleared, true);

  await clock.tick();
  assert.equal(beats, 2, "no beats after losing the seat");
  assert.equal(superseded, 1);
});

test("a network blip does not end the broadcast", async () => {
  const clock = manualTimers();
  let superseded = 0;
  startHostSeatHeartbeat({
    beat: () => Promise.reject(new TypeError("Failed to fetch")),
    onSuperseded: () => {
      superseded += 1;
    },
    timers: clock.timers,
  });
  await clock.tick();
  await clock.tick();
  assert.equal(superseded, 0);
  assert.equal(clock.cleared, false);
});

/** An in-memory BroadcastChannel: every instance with a name hears the others. */
function fakeChannelBus() {
  const channels = new Map();
  class FakeChannel {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
      if (!channels.has(name)) channels.set(name, new Set());
      channels.get(name).add(this);
    }
    postMessage(data) {
      for (const peer of channels.get(this.name)) {
        if (peer !== this) peer.onmessage?.({ data });
      }
    }
    close() {
      channels.get(this.name).delete(this);
    }
  }
  return FakeChannel;
}

test("a take-over reaches a live tab in the same browser at once", () => {
  const Channel = fakeChannelBus();
  const heard = [];
  let liveType = "broadcast";
  const liveTab = openHostSeatChannel({
    username: "Alice",
    session: "tab-a",
    isLive: () => liveType,
    onTakeover: (m) => heard.push(["takeover", m.session, m.meetingType]),
    Channel,
  });
  const newTab = openHostSeatChannel({
    username: "alice",
    session: "tab-b",
    onPeerLive: (m) => heard.push(["live", m.session, m.meetingType]),
    Channel,
  });

  // A fresh dashboard asks; the live sibling answers with its type.
  newTab.query();
  assert.deepEqual(heard, [["live", "tab-a", "broadcast"]]);

  newTab.announceTakeover("broadcast");
  assert.deepEqual(heard.at(-1), ["takeover", "tab-b", "broadcast"]);

  // A tab that is not live stays quiet when asked.
  liveType = null;
  heard.length = 0;
  newTab.query();
  assert.deepEqual(heard, []);

  liveTab.close();
  newTab.close();
});

test("a browser without BroadcastChannel loses nothing but speed", () => {
  const channel = openHostSeatChannel({
    username: "alice",
    session: "tab-a",
    Channel: null,
  });
  assert.equal(channel.available, false);
  channel.query();
  channel.announceLive("broadcast");
  channel.close();
});

// The broadcaster dashboard must not offer to open the public stream page:
// from the broadcaster's own browser that is one more copy of them in the
// room. "Copy viewer link" is the one way to share it.
test("the broadcaster dashboard has no open-in-a-new-tab control", () => {
  const source = readFileSync(
    new URL(
      "../src/routes/[username]/dashboard/stream/+page.svelte",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /target=["']_blank["']/);
  assert.doesNotMatch(source, /\bExternalLink\b/);
  assert.doesNotMatch(source, /openViewerLink/);
  assert.match(source, /dashboard\.stream\.copyViewerLink/);
});

// The public stream page renders for the creator too, and must only ever
// join as a viewer.
test("the public stream viewer never joins as a host", () => {
  const viewer = readFileSync(
    new URL(
      "../src/lib/components/stream/LiveStreamViewer.svelte",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(viewer, /export\s+let\s+isHost/);
  assert.match(viewer, /const isHost = false;/);
  assert.match(
    viewer,
    /\{\s*role:\s*["']viewer["'],\s*expectedActorId:\s*originalViewerActorId,\s*signal\s*\}/,
  );
});

// Codex review: a take-over that lands while RealtimeKit is still initializing
// (e.g. the camera permission prompt is open) must not leave this tab holding
// a host meeting it no longer has the seat for. The ownership browser specs use a held SDK initialization; also pin the ordering in the source: after the init
// await, the page checks for supersession BEFORE it adopts the meeting.
test("a meeting that finishes initializing after a take-over is disposed", () => {
  const source = readFileSync(
    new URL(
      "../src/routes/[username]/dashboard/stream/+page.svelte",
      import.meta.url,
    ),
    "utf8",
  );
  const init = source.indexOf("await initRtkMeeting(");
  const guard = source.indexOf("if (superseded || !isCurrentStart()) {", init);
  const adopt = source.indexOf("cleanup = cleanupFn;", init);
  assert.ok(init > 0, "initRtkMeeting call");
  assert.ok(guard > init, "supersession checked after the init await");
  assert.ok(adopt > guard, "meeting adopted only after the check");
  assert.match(source.slice(guard, adopt), /await cleanupFn\(\);\s*return;/);
});

// Codex review, round 2: a start that resolves after the page was left must
// release its seat rather than start a heartbeat, and a release must rotate
// the tab's seat id so it can never clear a retry's resumed seat.
test("a late start or a release cannot strand or steal a seat", () => {
  const source = readFileSync(
    new URL(
      "../src/routes/[username]/dashboard/stream/+page.svelte",
      import.meta.url,
    ),
    "utf8",
  );
  const start = source.indexOf("await StreamService.initStream(");
  const lateGuard = source.indexOf("if (!isCurrentStart()) {", start);
  const begin = source.indexOf(
    "beginSeat(startType, takeover, owner, session);",
    start,
  );
  assert.ok(start > 0 && lateGuard > start && begin > lateGuard);
  assert.match(
    source.slice(lateGuard, begin),
    /releaseOwnedSeat\(\{ actor: owner, session \}\);\s*return;/,
  );

  const endSeat = source.slice(source.indexOf("function endSeat("));
  const body = endSeat.slice(0, endSeat.indexOf("\n  }\n"));
  assert.match(body, /hostSession = newHostSession\(\);/);
  assert.match(body, /releaseOwnedSeat\(released, keepalive\)/);
  const release = source.slice(source.indexOf("function releaseOwnedSeat("));
  const releaseBody = release.slice(0, release.indexOf("\n  }\n"));
  assert.match(releaseBody, /if \(!isSameAccount\(seat.actor\)\)/);
  assert.match(
    releaseBody,
    /releaseHostSeat\(\s*seat.actor.username,\s*seat.session,/,
  );
  const wait = source.lastIndexOf("await waitForOwnedRelease(owner);", start);
  const waitGuard = source.indexOf("if (!isCurrentStart()) return;", wait);
  assert.ok(
    wait > 0 && waitGuard > wait && start > waitGuard,
    "retry waits for the original seat release and rechecks ownership before requesting a grant",
  );
});
