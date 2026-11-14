/** Small, SDK-independent model for the screenshares currently published in a room. */
export type ScreenShareParticipant = {
  id: string;
  name?: string | null;
  screenShareEnabled?: boolean;
  screenShareTracks?: { video?: MediaStreamTrack | null };
};

export type ScreenShareItem = { id: string; label: string };

/** One share per participant: RealtimeKit exposes one screenshare video track per peer. */
export function collectScreenShares(
  participants: Iterable<ScreenShareParticipant>,
): ScreenShareItem[] {
  return [...participants]
    .filter((participant) => Boolean(participant.screenShareEnabled))
    .map((participant) => ({
      id: participant.id,
      label: participant.name?.trim() || `Participant ${participant.id}`,
    }))
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.id.localeCompare(right.id),
    );
}

export function limitScreenShares<T extends ScreenShareItem>(
  items: T[],
  limit = 4,
): T[] {
  return items.slice(0, limit);
}

/** Keep subscriptions aligned with active, provider-authorized publishers. */
export function diffScreenShareSubscriptions(
  subscribedIds: Iterable<string>,
  activeIds: Iterable<string>,
) {
  const subscribed = new Set(subscribedIds);
  const active = new Set(activeIds);
  return {
    subscribe: [...active].filter((id) => !subscribed.has(id)),
    unsubscribe: [...subscribed].filter((id) => !active.has(id)),
  };
}
