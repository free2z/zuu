export const REACTION_EVENT = "free2z:meeting-reaction:v1";
export const REACTIONS = ["❤️", "👏", "😂", "😮", "🎉"] as const;
export type Reaction = (typeof REACTIONS)[number];
export type ReactionEvent = {
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
};
const WINDOW = 5_000,
  LIMIT = 12,
  COOLDOWN = 1_000,
  MAX = 8;
export function createReactionController(now = () => Date.now()) {
  let sentAt = -Infinity,
    id = 0,
    times: number[] = [];
  const active: { id: number; emoji: Reaction }[] = [];
  return {
    makePayload(emoji: Reaction) {
      const n = now();
      if (n - sentAt < COOLDOWN) return null;
      sentAt = n;
      return { emoji };
    },
    receive(e: ReactionEvent) {
      if (
        e.type !== REACTION_EVENT ||
        !e.payload ||
        typeof e.payload !== "object" ||
        Object.keys(e.payload).length !== 1 ||
        !REACTIONS.includes(e.payload.emoji as Reaction)
      )
        return null;
      const n = now();
      times = times.filter((t) => n - t < WINDOW);
      if (times.length >= LIMIT) return null;
      times.push(n);
      while (active.length >= MAX) active.shift();
      const item = { id: ++id, emoji: e.payload.emoji as Reaction };
      active.push(item);
      return item;
    },
    expire(target: number) {
      const i = active.findIndex((x) => x.id === target);
      if (i >= 0) active.splice(i, 1);
    },
    clear() {
      active.length = 0;
      times = [];
    },
    get visible() {
      return [...active];
    },
  };
}
