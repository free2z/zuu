import { translate } from "@/i18n/translate";
import { MESSAGE_KEYS } from "@/i18n/messages";
export const ABOUT_MESSAGES = Object.freeze({
  get pageTitle() {
    return translate(MESSAGE_KEYS.libAboutCopyAboutFeedback);
  },
  get pageDescription() {
    return translate(MESSAGE_KEYS.libAboutCopyBuildDetailsAndWaysToContactThe);
  },
  get navigationLabel() {
    return translate(MESSAGE_KEYS.libAboutCopyAboutFeedback);
  },
  get navigationAccessibleLabel() {
    return translate(MESSAGE_KEYS.libAboutCopyAboutAndFeedback);
  },
  get buildHeading() {
    return translate(MESSAGE_KEYS.libAboutCopyAboutZUULI);
  },
  get buildDescription() {
    return translate(
      MESSAGE_KEYS.libAboutCopyExactDetailsEmbeddedWhenThisAppWas,
    );
  },
  get productLabel() {
    return translate(MESSAGE_KEYS.libAboutCopyProduct);
  },
  get versionLabel() {
    return translate(MESSAGE_KEYS.libAboutCopyVersion);
  },
  get buildLabel() {
    return translate(MESSAGE_KEYS.libAboutCopyBuild);
  },
  get channelLabel() {
    return translate(MESSAGE_KEYS.libAboutCopyReleaseChannel);
  },
  get channelInternal() {
    return translate(MESSAGE_KEYS.libAboutCopyInternal);
  },
  get channelBeta() {
    return translate(MESSAGE_KEYS.libAboutCopyBeta);
  },
  get channelStable() {
    return translate(MESSAGE_KEYS.libAboutCopyStable);
  },
  get platformLabel() {
    return translate(MESSAGE_KEYS.libAboutCopyPlatform);
  },
  platformAndroid: "Android",
  platformIos: "iOS",
  platformLinux: "Linux",
  platformMacos: "macOS",
  platformWindows: "Windows",
  platformWeb: "Web",
  get commitLabel() {
    return translate(MESSAGE_KEYS.libAboutCopySourceCommit);
  },
  get unavailable() {
    return translate(MESSAGE_KEYS.libAboutCopyUnavailableInThisBuild);
  },
  get copyAction() {
    return translate(MESSAGE_KEYS.libAboutCopyCopyBuildInfo);
  },
  get copySuccess() {
    return translate(MESSAGE_KEYS.libAboutCopyBuildInfoCopied);
  },
  get copyFailure() {
    return translate(
      MESSAGE_KEYS.libAboutCopyCouldNotCopySelectTheBuildDetails,
    );
  },
  get provenanceSummary() {
    return translate(MESSAGE_KEYS.libAboutCopyBuildProvenance);
  },
  get applicationIdLabel() {
    return translate(MESSAGE_KEYS.libAboutCopyApplicationID);
  },
  get fullCommitLabel() {
    return translate(MESSAGE_KEYS.libAboutCopyFullSourceCommit);
  },
  get metadataSourceLabel() {
    return translate(MESSAGE_KEYS.libAboutCopyMetadataSource);
  },
  get metadataSourceValue() {
    return translate(MESSAGE_KEYS.libAboutCopyEmbeddedAtBuildTime);
  },
  get feedbackHeading() {
    return translate(MESSAGE_KEYS.libAboutCopySendFeedback);
  },
  get feedbackDescription() {
    return translate(
      MESSAGE_KEYS.libAboutCopyChooseADestinationThenReviewExactlyWhat,
    );
  },
  get feedbackChannelLegend() {
    return translate(MESSAGE_KEYS.libAboutCopyWhereShouldThisReportGo);
  },
  get feedbackEmailName() {
    return translate(MESSAGE_KEYS.libAboutCopyPrivateEmail);
  },
  get feedbackEmailPrivacy() {
    return translate(MESSAGE_KEYS.libAboutCopyOpensADraftToHelpFree2zCom);
  },
  get feedbackGithubName() {
    return translate(MESSAGE_KEYS.libAboutCopyPublicGitHubIssue);
  },
  get feedbackGithubPrivacy() {
    return translate(MESSAGE_KEYS.libAboutCopyOpensAPublicDraftInFree2zZuu);
  },
  get feedbackDescriptionLabel() {
    return translate(MESSAGE_KEYS.libAboutCopyWhatHappened);
  },
  get feedbackDescriptionHint() {
    return translate(
      MESSAGE_KEYS.libAboutCopyDoNotIncludeWalletSecretsPasswordsTokens,
    );
  },
  get feedbackMnemonicLanguageScope() {
    return translate(
      MESSAGE_KEYS.libAboutCopyAutomaticScreeningForRecoveryPhrasesOnlyRecognizes,
    );
  },
  get feedbackDiagnosticsLabel() {
    return translate(MESSAGE_KEYS.libAboutCopyIncludeSanitizedDiagnostics);
  },
  get feedbackDiagnosticsUnavailable() {
    return translate(MESSAGE_KEYS.libAboutCopyOffThisBuildDoesNotCollectLogs);
  },
  get feedbackReviewAction() {
    return translate(MESSAGE_KEYS.libAboutCopyReviewReport);
  },
  get feedbackPreviewTitle() {
    return translate(MESSAGE_KEYS.libAboutCopyReviewTheCompleteOutgoingDraft);
  },
  get feedbackPreviewDescription() {
    return translate(
      MESSAGE_KEYS.libAboutCopyEditThisDraftBeforeContinuingZUULINever,
    );
  },
  get feedbackSubjectLabel() {
    return translate(MESSAGE_KEYS.libAboutCopyOutgoingSubjectOrTitle);
  },
  get feedbackBodyLabel() {
    return translate(MESSAGE_KEYS.libAboutCopyOutgoingBody);
  },
  get feedbackRemoveDiagnosticsAction() {
    return translate(MESSAGE_KEYS.libAboutCopyRemoveDiagnostics);
  },
  get feedbackCopyAction() {
    return translate(MESSAGE_KEYS.libAboutCopyCopyReviewedReport);
  },
  get feedbackEditAction() {
    return translate(MESSAGE_KEYS.libAboutCopyEditDescription);
  },
  get feedbackCancelAction() {
    return translate(MESSAGE_KEYS.libAboutCopyCancel);
  },
  get feedbackContinueAction() {
    return translate(MESSAGE_KEYS.libAboutCopyContinueToChosenApp);
  },
  get feedbackScrubbedWarning() {
    return translate(
      MESSAGE_KEYS.libAboutCopyPotentialPrivateDataWasRemovedReviewThe,
    );
  },
  get feedbackTooLongWarning() {
    return translate(MESSAGE_KEYS.libAboutCopyThisCompleteReportIsTooLongFor);
  },
  get feedbackHandoffFailure() {
    return translate(MESSAGE_KEYS.libAboutCopyTheChosenAppCouldNotBeOpened);
  },
  get feedbackCopyFailure() {
    return translate(
      MESSAGE_KEYS.libAboutCopyTheClipboardIsUnavailableNothingWasSent,
    );
  },
  get feedbackCopiedStatus() {
    return translate(
      MESSAGE_KEYS.libAboutCopyReviewedReportCopiedNothingWasSent,
    );
  },
  get feedbackHandoffStatus() {
    return translate(MESSAGE_KEYS.libAboutCopyTheChosenAppWasOpenedWithThis);
  },
  get feedbackDefaultSubject() {
    return translate(MESSAGE_KEYS.libAboutCopyZUULIFeedback);
  },
  get feedbackRedactedValue() {
    return translate(MESSAGE_KEYS.libAboutCopyRemovedSensitiveValue);
  },
  get feedbackCopiedSubjectPrefix() {
    return translate(MESSAGE_KEYS.libAboutCopySubject);
  },
} as const);

export type AboutMessageKey = keyof typeof ABOUT_MESSAGES;
export type AboutMessages = Record<AboutMessageKey, string>;
export type AboutCatalogs = Readonly<Record<string, AboutMessages>>;

export const ABOUT_MESSAGE_KEYS = Object.freeze(
  Object.keys(ABOUT_MESSAGES) as AboutMessageKey[],
);

export function validateAboutMessages(
  value: unknown,
): asserts value is AboutMessages {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("About locale catalog must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = new Set<string>(ABOUT_MESSAGE_KEYS);
  const actual = Object.keys(record);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
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

function runtimeLanguages() {
  if (typeof navigator === "undefined") return ["en-US"];
  return navigator.languages.length
    ? [...navigator.languages]
    : [navigator.language || "en-US"];
}

export function resolveAboutMessages(
  languages: readonly string[] = runtimeLanguages(),
  catalogs?: AboutCatalogs,
): AboutMessages {
  if (!catalogs) return ABOUT_MESSAGES;
  const entries = Object.entries(catalogs);
  for (const value of Object.values(catalogs)) validateAboutMessages(value);
  for (const requested of languages) {
    const normalized = requested.trim().toLowerCase();
    const exact = entries.find(
      ([locale]) => locale.toLowerCase() === normalized,
    );
    if (exact) return exact[1];
    const language = normalized.split("-")[0];
    const fallback = entries.find(
      ([locale]) => locale.toLowerCase().split("-")[0] === language,
    );
    if (fallback) return fallback[1];
  }
  return catalogs["en-US"] ?? ABOUT_MESSAGES;
}
