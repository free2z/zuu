export const REACTION_EVENT = "free2z:meeting-reaction:v1";
export const REACTIONS = ["❤️", "👏", "😂", "😮", "🎉"] as const;
export type Reaction = (typeof REACTIONS)[number];
export type ReactionEvent = {
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
};
export type VisibleReaction = { id: number; emoji: Reaction };
const SEND_COOLDOWN_MS = 1_000;
const RECEIVE_WINDOW_MS = 5_000;
const RECEIVE_LIMIT = 12;
const MAX_VISIBLE = 8;
const TTL_MS = 3_000;

export function createReactionController(now = () => Date.now()) {
  let lastSent = -Infinity;
  let receiveTimes: number[] = [];
  let id = 0;
  const visible: VisibleReaction[] = [];
  return {
    makePayload(emoji: Reaction) {
      const time = now();
      if (time - lastSent < SEND_COOLDOWN_MS) return null;
      lastSent = time;
      return { emoji };
    },
    receive(event: ReactionEvent): VisibleReaction | null {
      if (
        event.type !== REACTION_EVENT ||
        !event.payload ||
        typeof event.payload !== "object"
      )
        return null;
      const keys = Object.keys(event.payload);
      if (
        keys.length !== 1 ||
        keys[0] !== "emoji" ||
        !REACTIONS.includes(event.payload.emoji as Reaction)
      )
        return null;
      const time = now();
      receiveTimes = receiveTimes.filter((t) => time - t < RECEIVE_WINDOW_MS);
      if (receiveTimes.length >= RECEIVE_LIMIT) return null;
      receiveTimes.push(time);
      while (visible.length >= MAX_VISIBLE) visible.shift();
      const item = { id: ++id, emoji: event.payload.emoji as Reaction };
      visible.push(item);
      return item;
    },
    expire(idToRemove: number) {
      const index = visible.findIndex((item) => item.id === idToRemove);
      if (index >= 0) visible.splice(index, 1);
    },
    clear() {
      visible.length = 0;
      receiveTimes = [];
    },
    get visible() {
      return [...visible];
    },
  };
}
