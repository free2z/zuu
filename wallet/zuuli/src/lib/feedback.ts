export type FeedbackChannel = "email" | "github";

export type FeedbackDraft = Readonly<{
  subject: string;
  body: string;
}>;

export type ScrubFinding =
  | "encoded-sensitive-value"
  | "network-identifier"
  | "path-or-filename"
  | "secret-or-wallet-data"
  | "unsafe-control-character";

export type ReviewedFeedbackDraft = Readonly<{
  draft: FeedbackDraft;
  findings: readonly ScrubFinding[];
}>;

export type HandoffUrlResult =
  | Readonly<{ status: "ready"; url: string }>
  | Readonly<{
      status: "too-long";
      actualCharacters: number;
      actualBytes: number;
      maximumCharacters: number;
      maximumBytes: number;
    }>;

export const FEEDBACK_SUPPORT_EMAIL = "help@free2z.com";
export const FEEDBACK_GITHUB_NEW_ISSUE_URL =
  "https://github.com/free2z/zuu/issues/new";

// A conservative common ceiling avoids relying on browser-, WebView-, mail
// client-, or OS-specific URL limits. Reports that do not fit remain intact in
// the preview and can be copied; they are never sliced to make a URL fit.
export const HANDOFF_URL_LIMIT = Object.freeze({
  characters: 1_800,
  bytes: 1_800,
});

export const FEEDBACK_DESCRIPTION_LIMIT = 4_000;
export const FEEDBACK_SUBJECT_LIMIT = 120;
export const FEEDBACK_BODY_LIMIT = 6_000;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const INVISIBLE_CHARACTERS = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\uffa0]/gu;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:seed|mnemonic|recovery\s+phrase|spending\s+key|viewing\s+key|password|passphrase|secret|private\s+key|auth(?:entication|orization)?|session|oauth|bearer|jwt|cookie|totp|otp|memo|balance|device(?:\s+(?:id|identifier|name))?|clipboard)\s*(?:=|:|is\b)\s*[^\n]+/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{6,})?\b/gu,
  /\botpauth:\/\/\S+/giu,
  /\b(?:secret-extended-key-(?:main|test)|zxviews|zxviewtestsapling|uview|usk|uvk|spendingkey|viewingkey)1[0-9a-z]{20,}\b/giu,
  /\b(?:u1[0-9a-z]{40,}|zs1[0-9a-z]{40,}|ztestsapling1[0-9a-z]{40,}|t[13][1-9A-HJ-NP-Za-km-z]{25,34})\b/gu,
  /\b[a-f0-9]{64}\b/giu,
  /\b(?:[a-z]+\s+){11}(?:[a-z]+)\b/gu,
  /\b(?:[A-Z2-7]{4}){4,}={0,6}\b/gu,
];

const NETWORK_PATTERNS: readonly RegExp[] = [
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu,
  /\b(?:[a-f0-9]{0,4}:){2,}[a-f0-9]{0,4}\b/giu,
  /\b(?:https?|wss?):\/\/[^\s]+/giu,
  /\b(?:host(?:name)?|ip(?:\s+address)?|ssid|network)\s*(?:=|:|is\b)\s*[^\n]+/giu,
];

const PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\s)(?:\/(?:Users|home|private|var|tmp|data|storage|sdcard)\/[^\s]+)/giu,
  /\b[A-Za-z]:\\[^\n]+/gu,
  /\b(?:file|filename|path)\s*(?:=|:|is\b)\s*[^\n]+/giu,
  /\b[^\s/\\]+\.(?:log|txt|json|db|sqlite|key|pem|p12|keystore|wallet)\b/giu,
];

const CONFUSABLE_ASCII: Readonly<Record<string, string>> = Object.freeze({
  "а": "a",
  "А": "A",
  "е": "e",
  "Е": "E",
  "о": "o",
  "О": "O",
  "р": "p",
  "Р": "P",
  "с": "c",
  "С": "C",
  "х": "x",
  "Х": "X",
  "і": "i",
  "І": "I",
});

function normalizeForInspection(value: string): string {
  return [...value.normalize("NFKC")]
    .map((character) => CONFUSABLE_ASCII[character] ?? character)
    .join("")
    .replace(INVISIBLE_CHARACTERS, "")
    .replace(CONTROL_CHARACTERS, "");
}

function replaceMatches(
  value: string,
  patterns: readonly RegExp[],
  redactedValue: string,
): { value: string; changed: boolean } {
  let next = value;
  for (const pattern of patterns) next = next.replace(pattern, redactedValue);
  return { value: next, changed: next !== value };
}

function hasSensitiveContent(value: string): boolean {
  const inspected = normalizeForInspection(value);
  return [...SECRET_PATTERNS, ...NETWORK_PATTERNS, ...PATH_PATTERNS].some(
    (pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(inspected);
    },
  );
}

function recursivelyDecodePercent(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function decodeBase64(value: string): string | undefined {
  if (!/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(value) || value.length > 1_024) {
    return undefined;
  }
  try {
    const canonical = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = canonical.padEnd(Math.ceil(canonical.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function scrubEncodedTokens(
  value: string,
  redactedValue: string,
): { value: string; changed: boolean } {
  let changed = false;
  const next = value.replace(/\S{8,}/gu, (token) => {
    const percentDecoded = recursivelyDecodePercent(token);
    const base64Decoded = decodeBase64(token);
    if (
      (percentDecoded !== token && hasSensitiveContent(percentDecoded)) ||
      (base64Decoded !== undefined && hasSensitiveContent(base64Decoded))
    ) {
      changed = true;
      return redactedValue;
    }
    return token;
  });
  return { value: next, changed };
}

export function scrubFeedbackText(value: string, redactedValue: string): {
  text: string;
  findings: readonly ScrubFinding[];
} {
  const findings = new Set<ScrubFinding>();
  let text = value.normalize("NFKC").replace(/\r\n?/gu, "\n");
  const withoutInvisible = text.replace(INVISIBLE_CHARACTERS, "");
  const withoutControls = withoutInvisible.replace(CONTROL_CHARACTERS, "");
  if (withoutControls !== text) findings.add("unsafe-control-character");
  text = withoutControls;

  const encoded = scrubEncodedTokens(text, redactedValue);
  if (encoded.changed) findings.add("encoded-sensitive-value");
  text = encoded.value;

  const secrets = replaceMatches(text, SECRET_PATTERNS, redactedValue);
  if (secrets.changed) findings.add("secret-or-wallet-data");
  text = secrets.value;

  const network = replaceMatches(text, NETWORK_PATTERNS, redactedValue);
  if (network.changed) findings.add("network-identifier");
  text = network.value;

  const paths = replaceMatches(text, PATH_PATTERNS, redactedValue);
  if (paths.changed) findings.add("path-or-filename");
  text = paths.value;

  // A confusable or otherwise normalized representation can match even when
  // replacing that normalized spelling in the original would be ambiguous.
  // Fail closed by removing the whole remaining field instead of guessing a
  // source span and risking partial disclosure.
  if (hasSensitiveContent(text)) {
    findings.add("secret-or-wallet-data");
    text = redactedValue;
  }

  return { text, findings: [...findings] };
}

/**
 * Diagnostics intentionally have no source parameter and no shipping capture
 * path. Arbitrary exceptions, causes, traces and logs therefore cannot cross
 * the privacy boundary. The UI reports diagnostics as unavailable until a
 * future separately reviewed allowlist can prove a safe schema end to end.
 */
export function captureFeedbackDiagnostics(): null {
  return null;
}

export function createFeedbackDraft(
  description: string,
  minimalBuildBlock: string,
  subject: string,
  redactedValue: string,
): ReviewedFeedbackDraft {
  const body = `${description.trim()}\n\n---\n${minimalBuildBlock.trim()}`;
  return reviewFeedbackDraft({ subject, body }, redactedValue);
}

export function reviewFeedbackDraft(
  draft: FeedbackDraft,
  redactedValue: string,
): ReviewedFeedbackDraft {
  const subject = scrubFeedbackText(
    draft.subject.slice(0, FEEDBACK_SUBJECT_LIMIT),
    redactedValue,
  );
  const body = scrubFeedbackText(
    draft.body.slice(0, FEEDBACK_BODY_LIMIT),
    redactedValue,
  );
  return {
    draft: { subject: subject.text, body: body.text },
    findings: [...new Set([...subject.findings, ...body.findings])],
  };
}

export function feedbackDraftText(
  draft: FeedbackDraft,
  subjectPrefix: string,
): string {
  return `${subjectPrefix}: ${draft.subject}\n\n${draft.body}`;
}

export function buildFeedbackHandoffUrl(
  channel: FeedbackChannel,
  draft: FeedbackDraft,
): HandoffUrlResult {
  const parameters = new URLSearchParams();
  let base: string;
  if (channel === "email") {
    base = `mailto:${FEEDBACK_SUPPORT_EMAIL}`;
    parameters.set("subject", draft.subject);
    parameters.set("body", draft.body);
  } else {
    base = FEEDBACK_GITHUB_NEW_ISSUE_URL;
    parameters.set("title", draft.subject);
    parameters.set("body", draft.body);
  }
  const url = `${base}?${parameters.toString()}`;
  const actualCharacters = url.length;
  const actualBytes = new TextEncoder().encode(url).byteLength;
  if (
    actualCharacters > HANDOFF_URL_LIMIT.characters ||
    actualBytes > HANDOFF_URL_LIMIT.bytes
  ) {
    return {
      status: "too-long",
      actualCharacters,
      actualBytes,
      maximumCharacters: HANDOFF_URL_LIMIT.characters,
      maximumBytes: HANDOFF_URL_LIMIT.bytes,
    };
  }
  return { status: "ready", url };
}
