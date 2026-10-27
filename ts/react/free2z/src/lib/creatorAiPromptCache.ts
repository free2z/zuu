const CREATOR_AI_PROMPT_PREFIX = "f2z:creator-ai-prompt:v1:";

export function pruneInsertedCreatorAiPromptsOnLogout(storage?: Storage) {
  try {
    const target = storage ?? window.localStorage;
    const keysToRemove: string[] = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (!key?.startsWith(CREATOR_AI_PROMPT_PREFIX)) continue;
      const stored = target.getItem(key);
      if (stored === null) continue;
      try {
        const intent = JSON.parse(stored);
        // Keep unknown outcomes and paid replies that still need recovery.
        // Only an insertion-confirmed result can be discarded safely.
        if (
          typeof intent?.completedAt === "number" &&
          typeof intent?.insertedAt === "number"
        ) {
          keysToRemove.push(key);
        }
      } catch {
        // An unrecognized record may still be the only retry evidence.
      }
    }
    keysToRemove.forEach((key) => target.removeItem(key));
  } catch {
    // Storage can be disabled or unavailable; logout must still complete.
  }
}
