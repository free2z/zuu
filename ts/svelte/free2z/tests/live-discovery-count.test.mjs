import test from "node:test";
import assert from "node:assert/strict";
import {
  freshParticipantCount,
  liveStatusFromStreams,
} from "../src/lib/live-discovery.js";

test("discovery count is one for host-alone and unknown without a fresh timestamp", () => {
  const now = Date.now();
  assert.equal(
    freshParticipantCount(
      {
        participant_count: 1,
        participant_count_as_of: new Date(now).toISOString(),
      },
      now,
    ),
    1,
  );
  assert.equal(freshParticipantCount({ participant_count: 1 }, now), undefined);
  assert.equal(
    freshParticipantCount(
      {
        participant_count: 9,
        participant_count_as_of: new Date(now - 91_000).toISOString(),
      },
      now,
    ),
    undefined,
  );
  assert.equal(
    freshParticipantCount(
      {
        participant_count: 9,
        participant_count_as_of: new Date(now + 1).toISOString(),
      },
      now,
    ),
    undefined,
  );
});

test("creator status mapping carries authoritative count and never synthesizes one", () => {
  const streams = liveStatusFromStreams([
    {
      meeting_type: "broadcast",
      participant_count: 1,
      participant_count_as_of: new Date().toISOString(),
    },
  ]);
  assert.equal(streams.streams[0].participant_count, 1);
  assert.equal(
    liveStatusFromStreams([{ meeting_type: "broadcast" }]).streams[0]
      .participant_count,
    undefined,
  );
});
