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
  feedbackHeading: "Send feedback",
  feedbackDescription:
    "Choose a destination, then review exactly what will leave ZUULI.",
  feedbackChannelLegend: "Where should this report go?",
  feedbackEmailName: "Private email",
  feedbackEmailPrivacy:
    "Opens a draft to help@free2z.com. Only that support inbox can read it unless you send it elsewhere.",
  feedbackGithubName: "Public GitHub issue",
  feedbackGithubPrivacy:
    "Opens a public draft in free2z/zuu. Anyone can read the issue and its history.",
  feedbackDescriptionLabel: "What happened?",
  feedbackDescriptionHint:
    "Do not include wallet secrets, passwords, tokens, addresses, transaction details, balances, device details, or local files.",
  feedbackMnemonicLanguageScope:
    "Automatic screening for recovery phrases only recognizes the English BIP-39 wordlist. A recovery phrase in another language (for example Japanese, Spanish, French, Italian, Korean, Czech, or Portuguese) will not be detected or removed automatically — never paste a recovery phrase here yourself, in any language.",
  feedbackDiagnosticsLabel: "Include sanitized diagnostics",
  feedbackDiagnosticsUnavailable:
    "Off. This build does not collect logs or tracebacks for feedback because their privacy safety is not proven.",
  feedbackReviewAction: "Review report",
  feedbackPreviewTitle: "Review the complete outgoing draft",
  feedbackPreviewDescription:
    "Edit this draft before continuing. ZUULI never sends it automatically.",
  feedbackSubjectLabel: "Outgoing subject or title",
  feedbackBodyLabel: "Outgoing body",
  feedbackRemoveDiagnosticsAction: "Remove diagnostics",
  feedbackCopyAction: "Copy reviewed report",
  feedbackEditAction: "Edit description",
  feedbackCancelAction: "Cancel",
  feedbackContinueAction: "Continue to chosen app",
  feedbackScrubbedWarning:
    "Potential private data was removed. Review the updated draft before trying again.",
  feedbackTooLongWarning:
    "This complete report is too long for a safe app handoff. It was not shortened or opened. Copy the same reviewed report instead.",
  feedbackHandoffFailure:
    "The chosen app could not be opened. Nothing was sent. Copy the same reviewed report instead.",
  feedbackCopyFailure:
    "The clipboard is unavailable. Nothing was sent. Select and copy the reviewed subject and body instead.",
  feedbackCopiedStatus: "Reviewed report copied. Nothing was sent.",
  feedbackHandoffStatus:
    "The chosen app was opened with this draft. ZUULI cannot know whether you submit it.",
  feedbackDefaultSubject: "ZUULI feedback",
  feedbackRedactedValue: "[removed: sensitive value]",
  feedbackCopiedSubjectPrefix: "Subject",
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
    ABOUT_MESSAGE_KEYS.map((key) => {
      const breakableKey = key.replace(/([A-Z])/g, " $1").toLowerCase();
      return [
        key,
        `⟦${ABOUT_MESSAGES[key]} — expanded locale ${breakableKey}⟧`,
      ];
    }),
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
