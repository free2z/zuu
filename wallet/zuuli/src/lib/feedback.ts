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
      status: "unsafe";
      draft: FeedbackDraft;
      findings: readonly ScrubFinding[];
    }>
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
const UNPAIRED_SURROGATES = /[\uD800-\uDFFF]/gu;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:seed|mnemonic|recovery\s+phrase|spending\s+key|viewing\s+key|password|passphrase|secret|private\s+key|auth(?:entication|orization)?(?:\s+token)?|access[\s_-]*token|session(?:\s+(?:id|token))?|oauth(?:\s+token)?|bearer|jwt|cookie|totp|otp|memo|balance|device(?:\s+(?:id|identifier|name))?|clipboard)\b\s*(?:(?:=|:|is)\s*)?[^\n]+/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9._-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16}|sk_(?:live|test)_[A-Za-z0-9]{16,})\b/gu,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{6,})?\b/gu,
  /\botpauth:\/\/\S+/giu,
  /\b(?:secret-extended-key-(?:main|test)|zxviews|zxviewtestsapling|uview|usk|uvk|spendingkey|viewingkey)1[0-9a-z]{20,}\b/giu,
  /\b(?:u1[0-9a-z]{40,}|zs1[0-9a-z]{40,}|ztestsapling1[0-9a-z]{40,}|t[13][1-9A-HJ-NP-Za-km-z]{25,34})\b/gu,
  /\b[a-f0-9]{32,64}\b/giu,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
  /\b(?=[^\n]{0,200},)(?:[a-z]{2,16}(?:\s*,\s*|\s+)){11}[a-z]{2,16}\b/giu,
  /\b(?=[A-Z2-7]{16,}={0,6}\b)(?=[A-Z2-7]*[2-7])[A-Z2-7]+={0,6}\b/gu,
  /\b(?=[A-Za-z0-9._~+/_=-]{20,}\b)(?=[A-Za-z0-9._~+/_=-]*[A-Za-z])(?=[A-Za-z0-9._~+/_=-]*\d)[A-Za-z0-9._~+/_=-]+\b/gu,
];

const NETWORK_PATTERNS: readonly RegExp[] = [
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu,
  /\b(?:[a-f0-9]{0,4}:){2,}[a-f0-9]{0,4}\b/giu,
  /\b(?:https?|wss?):\/\/[^\s]+/giu,
  /(?<!@)\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:[/?#][^\s]*)?/giu,
  /\b(?:host(?:name)?|ip(?:\s+address)?|ssid|network)\s*(?:=|:|is\b)\s*[^\n]+/giu,
];

const PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\s)(?:\/(?:Users|home|private|var|tmp|data|storage|sdcard)\/[^\s]+)/giu,
  /\b[A-Za-z]:\\[^\n]+/gu,
  /\b(?:file|filename|path)\s*(?:=|:|is\b)\s*[^\n]+/giu,
  /\b[^\s/\\]+\.(?:log|txt|json|db|sqlite|key|pem|p12|keystore|wallet)\b/giu,
];

const CONFUSABLE_ASCII: Readonly<Record<string, string>> = Object.freeze({
  "α": "a",
  "Α": "A",
  "ο": "o",
  "Ο": "O",
  "ρ": "p",
  "Ρ": "P",
  "ϲ": "c",
  "Ϲ": "C",
  "χ": "x",
  "Χ": "X",
  "ι": "i",
  "Ι": "I",
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
  // Every successful pass consumes at least one percent triplet, so this is
  // finite for the bounded draft without choosing an attacker-bypassable
  // nesting count.
  for (;;) {
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/giu, (segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function decodeBase64(value: string): string | undefined {
  const compact = value.replace(/\s+/gu, "");
  if (!/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(compact) || compact.length > FEEDBACK_BODY_LIMIT) {
    return undefined;
  }
  try {
    const canonical = compact.replace(/-/g, "+").replace(/_/g, "/");
    const padded = canonical.padEnd(Math.ceil(canonical.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function decodedValueContainsSensitiveContent(value: string): boolean {
  const pending = [value];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === undefined || seen.has(candidate)) continue;
    seen.add(candidate);

    const percentDecoded = recursivelyDecodePercent(candidate);
    if (percentDecoded !== candidate) {
      if (hasSensitiveContent(percentDecoded)) return true;
      pending.push(percentDecoded);
    }

    const base64Decoded = decodeBase64(candidate);
    if (base64Decoded !== undefined && base64Decoded.length < candidate.length) {
      if (hasSensitiveContent(base64Decoded)) return true;
      pending.push(base64Decoded);
    }
  }
  return false;
}

function scrubEncodedTokens(
  value: string,
  redactedValue: string,
): { value: string; changed: boolean } {
  let changed = false;
  let next = value.replace(/\S{8,}/gu, (token) => {
    if (decodedValueContainsSensitiveContent(token)) {
      changed = true;
      return redactedValue;
    }
    return token;
  });

  // Base64 is routinely wrapped by mail clients and text areas. Inspect a
  // whitespace-separated run as one encoded value and remove the exact run if
  // any finite decode chain exposes prohibited content.
  next = next.replace(
    /(?:[A-Za-z0-9+/_-]{4,}={0,2}[ \t\r\n]+){1,}[A-Za-z0-9+/_-]{4,}={0,2}/gu,
    (candidate) => {
      if (!decodedValueContainsSensitiveContent(candidate)) return candidate;
      changed = true;
      return redactedValue;
    },
  );
  // Partial removal from a nested/wrapped encoding could leave undiscovered
  // fragments. Once any encoded representation is sensitive, fail closed for
  // the complete field rather than attempting source-span reconstruction.
  return { value: changed ? redactedValue : next, changed };
}

export function scrubFeedbackText(value: string, redactedValue: string): {
  text: string;
  findings: readonly ScrubFinding[];
} {
  const findings = new Set<ScrubFinding>();
  let text = value.normalize("NFKC").replace(/\r\n?/gu, "\n");
  const withoutInvisible = text.replace(INVISIBLE_CHARACTERS, "");
  // With the Unicode flag, a valid surrogate pair is one code point and does
  // not match this range; only unpaired UTF-16 code units match. Removing them
  // before preview prevents WebIDL/URI encoders from silently substituting
  // U+FFFD at handoff.
  const withoutControls = withoutInvisible
    .replace(CONTROL_CHARACTERS, "")
    .replace(UNPAIRED_SURROGATES, redactedValue);
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
  redactedValue: string,
): HandoffUrlResult {
  // This is the final transport boundary, not merely a formatter. Runtime
  // callers cannot bypass review by constructing a FeedbackDraft directly.
  const reviewed = reviewFeedbackDraft(draft, redactedValue);
  if (
    reviewed.findings.length > 0 ||
    reviewed.draft.subject !== draft.subject ||
    reviewed.draft.body !== draft.body
  ) {
    return {
      status: "unsafe",
      draft: reviewed.draft,
      findings: reviewed.findings,
    };
  }
  const parameters = new URLSearchParams();
  let base: string;
  if (channel === "email") {
    base = `mailto:${FEEDBACK_SUPPORT_EMAIL}`;
    const encodeMailtoField = (value: string) =>
      encodeURIComponent(value).replace(
        /[!'()*]/gu,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );
    const query = `subject=${encodeMailtoField(draft.subject)}&body=${encodeMailtoField(draft.body)}`;
    const url = `${base}?${query}`;
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
