export const ABOUT_MESSAGES = {
  pageTitle: "About & Feedback",
  pageDescription: "Build details and ways to contact the ZUULI team.",
  buildHeading: "About ZUULI",
  buildDescription: "Exact details embedded when this app was built.",
  productLabel: "Product",
  versionLabel: "Version",
  buildLabel: "Build",
  channelLabel: "Release channel",
  platformLabel: "Platform",
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
} as const;

export type AboutMessageKey = keyof typeof ABOUT_MESSAGES;
export type AboutMessages = Record<AboutMessageKey, string>;

export const ABOUT_MESSAGE_KEYS = Object.freeze(
  Object.keys(ABOUT_MESSAGES) as AboutMessageKey[],
);

export function createAboutMessages(
  overrides: Partial<AboutMessages> = {},
): AboutMessages {
  return { ...ABOUT_MESSAGES, ...overrides };
}

