export const ABOUT_MESSAGES = Object.freeze({
  pageTitle: "About & Feedback",
  pageDescription: "Build details and ways to contact the ZUULI team.",
  navigationLabel: "About & Feedback",
  navigationAccessibleLabel: "About and feedback",
  buildHeading: "About ZUULI",
  buildDescription: "Exact details embedded when this app was built.",
  productLabel: "Product",
  versionLabel: "Version",
  buildLabel: "Build",
  channelLabel: "Release channel",
  channelInternal: "Internal",
  channelBeta: "Beta",
  channelStable: "Stable",
  platformLabel: "Platform",
  platformAndroid: "Android",
  platformIos: "iOS",
  platformLinux: "Linux",
  platformMacos: "macOS",
  platformWindows: "Windows",
  platformWeb: "Web",
  commitLabel: "Source commit",
  unavailable: "Unavailable in this build",
  copyAction: "Copy build info",
  copySuccess: "Build info copied.",
  copyFailure: "Could not copy. Select the build details and copy them manually.",
  provenanceSummary: "Build provenance",
  applicationIdLabel: "Application ID",
  fullCommitLabel: "Full source commit",
  metadataSourceLabel: "Metadata source",
  metadataSourceValue: "Embedded at build time",
} as const);

export type AboutMessageKey = keyof typeof ABOUT_MESSAGES;
export type AboutMessages = Record<AboutMessageKey, string>;
export type AboutCatalogs = Readonly<Record<string, AboutMessages>>;

export const ABOUT_MESSAGE_KEYS = Object.freeze(
  Object.keys(ABOUT_MESSAGES) as AboutMessageKey[],
);

export function validateAboutMessages(value: unknown): asserts value is AboutMessages {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("About locale catalog must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = new Set<string>(ABOUT_MESSAGE_KEYS);
  const actual = Object.keys(record);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new Error("About locale catalog keys must exactly match en-US");
  }
  for (const key of ABOUT_MESSAGE_KEYS) {
    if (typeof record[key] !== "string" || !record[key].trim()) {
      throw new Error(`About locale catalog value is empty: ${key}`);
    }
  }
}

export function createAboutMessages(
  overrides: Partial<AboutMessages> = {},
): AboutMessages {
  const messages = { ...ABOUT_MESSAGES, ...overrides };
  validateAboutMessages(messages);
  return Object.freeze(messages);
}

export const PSEUDO_ABOUT_MESSAGES = createAboutMessages(
  Object.fromEntries(
    ABOUT_MESSAGE_KEYS.map((key) => [
      key,
      `⟦${ABOUT_MESSAGES[key]} — expanded locale ${key}⟧`,
    ]),
  ) as Partial<AboutMessages>,
);

export const ABOUT_CATALOGS: AboutCatalogs = Object.freeze({
  "en-US": ABOUT_MESSAGES,
  "en-XA": PSEUDO_ABOUT_MESSAGES,
});

function runtimeLanguages() {
  if (typeof navigator === "undefined") return ["en-US"];
  return navigator.languages.length
    ? [...navigator.languages]
    : [navigator.language || "en-US"];
}

export function resolveAboutMessages(
  languages: readonly string[] = runtimeLanguages(),
  catalogs: AboutCatalogs = ABOUT_CATALOGS,
): AboutMessages {
  const entries = Object.entries(catalogs);
  for (const value of Object.values(catalogs)) validateAboutMessages(value);
  for (const requested of languages) {
    const normalized = requested.trim().toLowerCase();
    const exact = entries.find(([locale]) => locale.toLowerCase() === normalized);
    if (exact) return exact[1];
    const language = normalized.split("-")[0];
    const fallback = entries.find(
      ([locale]) => locale.toLowerCase().split("-")[0] === language,
    );
    if (fallback) return fallback[1];
  }
  return catalogs["en-US"] ?? ABOUT_MESSAGES;
}
