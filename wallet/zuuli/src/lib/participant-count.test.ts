import { describe, expect, it } from "vitest";
import {
  compareParticipantCountsDescending,
  normalizeParticipantCount,
  participantCountCopy,
  sumParticipantCounts,
  type ParticipantCount,
} from "./participant-count";

describe("participant count truthfulness", () => {
  it("preserves exact non-negative integers without coercing missing or malformed values", () => {
    expect(normalizeParticipantCount(0)).toBe(0);
    expect(normalizeParticipantCount(37)).toBe(37);

    for (const unavailable of [
      null,
      undefined,
      "0",
      "37",
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(normalizeParticipantCount(unavailable)).toBeNull();
    }
  });

  it("rejects partial and unsafe aggregates instead of adding fallback zeroes", () => {
    expect(sumParticipantCounts([0])).toBe(0);
    expect(sumParticipantCounts([12, 5, 0])).toBe(17);
    expect(sumParticipantCounts([])).toBeNull();
    expect(sumParticipantCounts([12, undefined, 5])).toBeNull();
    expect(sumParticipantCounts([12, "5"])).toBeNull();
    expect(sumParticipantCounts([Number.MAX_SAFE_INTEGER, 1])).toBeNull();
  });

  it("sorts known positive counts, then known zero, then stable unknowns", () => {
    const rows: { id: string; count: ParticipantCount }[] = [
      { id: "unknown-first", count: null },
      { id: "zero", count: 0 },
      { id: "eight", count: 8 },
      { id: "unknown-second", count: null },
      { id: "three", count: 3 },
    ];

    expect(
      rows
        .sort((left, right) =>
          compareParticipantCountsDescending(left.count, right.count),
        )
        .map(({ id }) => id),
    ).toEqual(["eight", "three", "zero", "unknown-first", "unknown-second"]);
    expect(compareParticipantCountsDescending(null, null)).toBe(0);
    expect(compareParticipantCountsDescending(0, null)).toBeLessThan(0);
    expect(compareParticipantCountsDescending(null, 0)).toBeGreaterThan(0);
  });

  it("keeps unavailable, zero, singular, and plural copy distinct", () => {
    expect(participantCountCopy(null)).toEqual({
      value: "Unavailable",
      watching: "Participant count unavailable",
    });
    expect(participantCountCopy(0)).toEqual({
      value: "0",
      watching: "0 people watching",
    });
    expect(participantCountCopy(1)).toEqual({
      value: "1",
      watching: "1 person watching",
    });
    expect(participantCountCopy(12_345)).toEqual({
      value: "12,345",
      watching: "12,345 people watching",
    });
  });
});
