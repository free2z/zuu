import {
  ABOUT_MESSAGES,
  ABOUT_MESSAGE_KEYS,
  type AboutMessages,
} from "@/lib/about-copy";

// Retained for the existing expansion tests; no pseudo text is loaded in a catalog.
export const PSEUDO_ABOUT_MESSAGES = Object.freeze(
  Object.defineProperties(
    {},
    Object.fromEntries(
      ABOUT_MESSAGE_KEYS.map((key) => [
        key,
        {
          enumerable: true,
          get: () =>
            `⟦${ABOUT_MESSAGES[key]} — expanded locale ${key.replace(/([A-Z])/g, " $1").toLowerCase()}⟧`,
        },
      ]),
    ),
  ),
) as AboutMessages;
