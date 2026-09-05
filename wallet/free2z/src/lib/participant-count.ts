export type ParticipantCount = number | null;

/** Accept only complete, non-negative integer counts from hydration. */
export function normalizeParticipantCount(value: unknown): ParticipantCount {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Aggregate only complete hydration. A missing or malformed member makes the
 * whole total unknown instead of silently contributing a fabricated zero.
 */
export function sumParticipantCounts(
  values: readonly unknown[],
): ParticipantCount {
  if (values.length === 0) return null;

  let total = 0;
  for (const value of values) {
    const count = normalizeParticipantCount(value);
    if (count === null) return null;
    total += count;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/** Most-watched ordering: every known count, including zero, precedes unknown. */
export function compareParticipantCountsDescending(
  left: ParticipantCount,
  right: ParticipantCount,
): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return right - left;
}

export interface ParticipantCountCopy {
  /** Compact value used where the surrounding UI already names the metric. */
  value: string;
  /** Complete truthful phrase for visible prose and accessible names. */
  watching: string;
}

export function participantCountCopy(
  count: ParticipantCount,
): ParticipantCountCopy {
  if (count === null) {
    return {
      value: "Unavailable",
      watching: "Participant count unavailable",
    };
  }

  const value = count.toLocaleString();
  return {
    value,
    watching: `${value} ${count === 1 ? "person" : "people"} watching`,
  };
}
