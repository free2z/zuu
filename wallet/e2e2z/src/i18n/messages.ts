// Every message key this surface declares. The catalog policy holds each
// shipped locale to exactly this set, so a key added to a screen without a
// translation is a test failure rather than a runtime `missing i18n message`.
export const MESSAGE_KEYS = [
  "app.name",
  "app.tagline",
  "placeholder.heading",
  "placeholder.body",
] as const;

export type MessageKey = (typeof MESSAGE_KEYS)[number];

export const DECLARED_MESSAGE_KEYS: ReadonlySet<string> = new Set(MESSAGE_KEYS);
