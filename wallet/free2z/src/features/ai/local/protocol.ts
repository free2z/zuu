export type Command = { kind: "probe" } | { kind: "load" } | { kind: "generate"; prompt: string };
export type Metrics = { loadMs?: number; firstTokenMs?: number | null; finishedMs?: number };
export type Reply =
  | { kind: "supported"; description: string }
  | { kind: "progress"; text: string }
  | { kind: "ready"; metrics: Metrics }
  | { kind: "token"; text: string }
  | { kind: "done"; metrics: Metrics }
  | { kind: "failed"; reason: string };
export const CACHE = "free2z-local-draft-smollm2-360m-v1";
export const POLICY = "/local-draft-policy.json";
export const MAX_PROMPT = 2000;

export function isReply(value: unknown): value is Reply {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  const message = value as Record<string, unknown>;
  const text = (key: string, max = 1000) => typeof message[key] === "string" && (message[key] as string).length <= max;
  const metrics = () => {
    if (!message.metrics || typeof message.metrics !== "object") return false;
    return Object.entries(message.metrics).every(([key, v]) =>
      ["loadMs", "firstTokenMs", "finishedMs"].includes(key) &&
      ((key === "firstTokenMs" && v === null) || (typeof v === "number" && Number.isFinite(v) && v >= 0)));
  };
  switch (message.kind) {
    case "supported": return text("description");
    case "progress": return text("text");
    case "ready": case "done": return metrics();
    case "token": return text("text", 8192);
    case "failed": return text("reason");
    default: return false;
  }
}
