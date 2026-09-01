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

const CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const DEFAULT_IGNORABLE_CHARACTERS = /\p{Default_Ignorable_Code_Point}/gu;
const COMBINING_OVERLAYS = /[\u0334-\u0338]/gu;
const COMBINING_MARKS = /\p{Mark}/gu;
const UNPAIRED_SURROGATES = /[\uD800-\uDFFF]/gu;
const ALLOWED_EMAIL =
  /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,63}/giu;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:seed|mnemonic|recovery\s+phrase|spending\s+key|viewing\s+key|password|passphrase|secret|private\s+key|auth(?:entication|orization)?(?:\s+token)?|access[\s_-]*token|session(?:\s+(?:id|token))?|oauth(?:\s+token)?|bearer|jwt|cookie|totp|otp|memo|balance|device(?:\s+(?:id|identifier|name))?|clipboard)\b\s*(?:(?:=|:|is)\s*)?[^\n]+/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9._-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16}|sk_(?:live|test)_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{20,})\b/gu,
  /\b(?:sk-proj-[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{6,})?\b/gu,
  /\botpauth:\/\/\S+/giu,
  /\b(?:secret-extended-key-(?:main|test)|zxviews|zxviewtestsapling|uview(?:test|regtest)?|uivk(?:test|regtest)?|usk(?:test|regtest)?|spendingkey|viewingkey)1[0-9a-z]{20,}\b/giu,
  /\b(?:(?:u|utest|uregtest)1[0-9a-z]{40,}|zs1[0-9a-z]{40,}|ztestsapling1[0-9a-z]{40,}|t[13][1-9A-HJ-NP-Za-km-z]{25,34})\b/giu,
  /\bz[ct][1-9A-HJ-NP-Za-km-z]{80,100}\b/gu,
  /\b(?:tm|t2)[1-9A-HJ-NP-Za-km-z]{25,40}\b/gu,
  /\b(?:[59][1-9A-HJ-NP-Za-km-z]{50}|[KLc][1-9A-HJ-NP-Za-km-z]{51})\b/gu,
  /\b[a-f0-9]{32,64}\b/giu,
  /\b0x[a-f0-9]{64}\b/giu,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
  /\b(?:sent\s+from|device\s+name)\s+[^\n]+/giu,
  /\b(?:iPhone|iPad|iPod|MacBook|Pixel|Galaxy)\b[^\n]*/giu,
  /\b\d[\d,.]*\s*(?:ZEC|zatoshi(?:s)?|2Zs?)\b/giu,
  /\b(?:ZEC|zatoshi(?:s)?|2Zs?)\s*\d[\d,.]*\b/giu,
  /\b(?:payment\s+for|copied\s+text|pasted\s+text)\b[^\n]*/giu,
  /\bpasteboard\b\s*(?:=|:|is\b)\s*[^\n]+/giu,
  /\b(?:IMEI|Android\s+ID)\b\s*(?:(?:=|:|is)\s*)?[A-Fa-f0-9]{14,16}\b/giu,
  /\b(?:serial\s+(?:number|no\.?)|device\s+serial)\b\s*(?:(?:=|:|is)\s*)?(?=[A-Za-z0-9-]{6,}\b)(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]+\b/giu,
];

const NETWORK_PATTERNS: readonly RegExp[] = [
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu,
  /\b(?:[a-f0-9]{0,4}:){2,}[a-f0-9]{0,4}\b/giu,
  /\b(?:https?|wss?):\/\/[^\s]+/giu,
  /\blocalhost(?::\d+)?\b/giu,
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:[/?#][^\s]*)?/giu,
  /(?:[\p{Letter}\p{Number}](?:[\p{Letter}\p{Number}-]{0,61}[\p{Letter}\p{Number}])?\.)+[\p{Letter}]{2,63}/gu,
  /\b(?:host(?:name)?|ip(?:\s+address)?|ssid|network)\s*(?:=|:|is\b)\s*[^\n]+/giu,
];

const PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s('"`])\/(?:[^\s/]+\/)*[^\s]+/gmu,
  /(?:^|\s)(?:Library\/Application Support|Documents|Desktop|Downloads|Pictures|Movies|Music)\/[^\n]+/gimu,
  /(?:^|\s)(?:\.{0,2}\/)?(?:src|lib|app|etc|opt|Users|home|private|var|tmp|data|storage|sdcard)\/[^\s]+/gimu,
  /(?:^|\s)(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/])[^\n]+/gmu,
  /\b(?:file|filename|path)\s*(?:=|:|is\b)\s*[^\n]+/giu,
  /\b(?:rust_backtrace|backtrace|traceback|stack\s+trace|TauriInvokeError|JavaScriptError)\b[^\n]*/giu,
  /\b[^\s/\\]+\.[A-Za-z][A-Za-z0-9]{0,11}(?::\d+(?::\d+)?)?\b/gu,
  /(?:^|\s)\.[A-Za-z_][A-Za-z0-9_-]*(?=\s|$)/gmu,
];

const SECRET_LABEL_SKELETON =
  /\b(?:p[a4]ss[\s_-]*w[o0]rd|pass[\s_-]*phrase|passwort|senha|contrasena|mot[\s_-]*de[\s_-]*passe|auth(?:entication|orization)?|[o0]auth|sess[i1][o0]n|bearer|c[o0]{2}kie|t[o0]tp|mnemonic|seed|spend[i1]ng[\s_-]*key|v[i1]ew[i1]ng[\s_-]*key|private[\s_-]*key|access[\s_-]*t[o0]ken)\b/giu;

function hasSuspiciousMixedScriptToken(value: string): boolean {
  for (const match of value.matchAll(/[\p{Letter}\p{Mark}]+/gu)) {
    const token = match[0];
    if (
      /\p{Script=Latin}/u.test(token) &&
      /(?:\p{Script=Cyrillic}|\p{Script=Greek})/u.test(token)
    ) {
      return true;
    }
  }
  return false;
}

const SECURITY_CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  а: "a",
  α: "a",
  е: "e",
  ε: "e",
  і: "i",
  ι: "i",
  о: "o",
  ο: "o",
  р: "p",
  ρ: "p",
  с: "c",
  ѕ: "s",
  ԝ: "w",
  г: "r",
  ԁ: "d",
});

function hasConfusableSensitiveLabel(value: string): boolean {
  for (const match of value.matchAll(/[\p{Letter}\p{Mark}]+/gu)) {
    const token = normalizeForInspection(match[0]).toLowerCase();
    const skeleton = [...token]
      .map((character) => SECURITY_CONFUSABLES[character] ?? character)
      .join("");
    if (skeleton === token) continue;
    SECRET_LABEL_SKELETON.lastIndex = 0;
    if (SECRET_LABEL_SKELETON.test(skeleton)) return true;
  }
  return false;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function hasTotpShapedValue(value: string): boolean {
  return [...value.matchAll(/\b[A-Z2-7]{16,64}={0,6}\b/giu)].some(
    ([candidate]) => {
      const upperCandidate = candidate.toUpperCase();
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const sequential = [...upperCandidate].every(
        (character, index) =>
          index === 0 ||
          alphabet.indexOf(character) ===
            (alphabet.indexOf(upperCandidate[index - 1]) + 1) % alphabet.length,
      );
      return (
        !sequential &&
        (/[2-7]/u.test(upperCandidate) || shannonEntropy(upperCandidate) >= 3.5)
      );
    },
  );
}

function normalizeForInspection(value: string): string {
  return value
    .normalize("NFKD")
    .replace(DEFAULT_IGNORABLE_CHARACTERS, "")
    .replace(COMBINING_MARKS, "")
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
  if (
    containsEnglishBip39Candidate(inspected) ||
    hasSuspiciousMixedScriptToken(value) ||
    hasConfusableSensitiveLabel(value) ||
    hasTotpShapedValue(inspected)
  ) {
    return true;
  }
  SECRET_LABEL_SKELETON.lastIndex = 0;
  if (SECRET_LABEL_SKELETON.test(inspected)) return true;
  return [...SECRET_PATTERNS, ...NETWORK_PATTERNS, ...PATH_PATTERNS].some(
    (pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(inspected);
    },
  );
}

function decodeCommonEscapes(value: string): string {
  let decoded = value;
  const namedEntities: Readonly<Record<string, string>> = Object.freeze({
    amp: "&",
    colon: ":",
    equals: "=",
    num: "#",
    sol: "/",
  });
  for (;;) {
    const next = decoded
      .replace(
        /&#(?:x([0-9a-f]+)|(\d+));/giu,
        (entity, hexadecimal, decimal) => {
          const codePoint = Number.parseInt(
            hexadecimal ?? decimal,
            hexadecimal ? 16 : 10,
          );
          return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : entity;
        },
      )
      .replace(
        /&(amp|colon|equals|num|sol);/giu,
        (_entity, name: string) => namedEntities[name.toLowerCase()] ?? _entity,
      )
      .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (escape, hexadecimal) => {
        const codePoint = Number.parseInt(hexadecimal, 16);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : escape;
      })
      .replace(/\\u([0-9a-f]{4})/giu, (_escape, hexadecimal) =>
        String.fromCharCode(Number.parseInt(hexadecimal, 16)),
      )
      .replace(/\\x([0-9a-f]{2})/giu, (_escape, hexadecimal) =>
        String.fromCharCode(Number.parseInt(hexadecimal, 16)),
      );
    if (next === decoded) return decoded;
    decoded = next;
  }
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

const PRIVATE_ENTROPY_BYTE_LENGTHS = Object.freeze([
  16, 20, 24, 28, 32, 48, 64,
]);

function isPrivateEntropyByteLength(byteLength: number): boolean {
  return PRIVATE_ENTROPY_BYTE_LENGTHS.includes(byteLength);
}

function hasPercentEncodedPrivateEntropy(value: string): boolean {
  return [...value.matchAll(/(?:%[0-9a-f]{2})+/giu)].some((match) =>
    isPrivateEntropyByteLength(match[0].length / 3),
  );
}

function hasEscapedPrivateEntropy(value: string): boolean {
  return [...value.matchAll(/(?:\\x[0-9a-f]{2}|\\u00[0-9a-f]{2})+/giu)].some(
    (match) =>
      isPrivateEntropyByteLength(
        [...match[0].matchAll(/\\(?:x[0-9a-f]{2}|u00[0-9a-f]{2})/giu)].length,
      ),
  );
}

function hasNumericEntityPrivateEntropy(value: string): boolean {
  let canonical = value;
  for (;;) {
    const next = canonical.replace(/&amp;/giu, "&");
    if (next === canonical) break;
    canonical = next;
  }
  let consecutiveByteCount = 0;
  let previousEnd = -1;
  const flush = () => {
    const privateLength = isPrivateEntropyByteLength(consecutiveByteCount);
    consecutiveByteCount = 0;
    return privateLength;
  };
  for (const match of canonical.matchAll(/&#(?:x([0-9a-f]+)|(\d+));/giu)) {
    if (match.index !== previousEnd && flush()) return true;
    const hexadecimal = match[1] !== undefined;
    const digits = match[1] ?? match[2];
    const significant = digits.replace(/^0+/u, "") || "0";
    const value =
      significant.length <= (hexadecimal ? 2 : 3)
        ? Number.parseInt(significant, hexadecimal ? 16 : 10)
        : Number.NaN;
    if (value >= 0 && value <= 0xff) {
      consecutiveByteCount += 1;
    } else if (flush()) {
      return true;
    }
    previousEnd = (match.index ?? 0) + match[0].length;
  }
  return flush();
}

function decodeBase64Bytes(
  value: string,
  compactWhitespace = false,
): Uint8Array | undefined {
  const compact = compactWhitespace ? value.replace(/\s+/gu, "") : value;
  if (
    !/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(compact) ||
    compact.length > FEEDBACK_BODY_LIMIT
  ) {
    return undefined;
  }
  try {
    const canonical = compact.replace(/-/g, "+").replace(/_/g, "/");
    const padded = canonical.padEnd(Math.ceil(canonical.length / 4) * 4, "=");
    const binary = atob(padded);
    const roundTrip = btoa(binary).replace(/=+$/u, "");
    if (roundTrip !== canonical.replace(/=+$/u, "")) return undefined;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function hasBase64EncodedPrivateEntropy(
  value: string,
  compactWhitespace = false,
): boolean {
  const bytes = decodeBase64Bytes(value, compactWhitespace);
  // Any canonical encoding at a standard seed/private-key byte length is
  // indistinguishable from private entropy. Printability and UTF-8 validity
  // are attacker-controlled, so the boundary fails shut on length alone.
  return bytes !== undefined && isPrivateEntropyByteLength(bytes.byteLength);
}

function decodeBase64(
  value: string,
  compactWhitespace = false,
): string | undefined {
  const bytes = decodeBase64Bytes(value, compactWhitespace);
  if (bytes === undefined) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function decodedValueContainsSensitiveContent(value: string): boolean {
  const compact = value.replace(/\s+/gu, "");
  // Whitespace is discarded only when it interrupts a structurally complete
  // percent-encoded value. Base64 wrapping is handled separately with segment
  // evidence; compacting arbitrary prose creates attacker-controlled/private-
  // entropy-length false positives.
  const pending =
    compact !== value &&
    (/^(?:%[0-9a-f]{2})+$/iu.test(compact) ||
      /^(?:\\x[0-9a-f]{2}|\\u00[0-9a-f]{2})+$/iu.test(compact))
      ? [value, compact]
      : [value];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === undefined || seen.has(candidate)) continue;
    seen.add(candidate);

    if (
      hasPercentEncodedPrivateEntropy(candidate) ||
      hasEscapedPrivateEntropy(candidate) ||
      hasNumericEntityPrivateEntropy(candidate)
    ) {
      return true;
    }

    const percentDecoded = recursivelyDecodePercent(candidate);
    if (percentDecoded !== candidate) {
      if (hasSensitiveContent(percentDecoded)) return true;
      pending.push(percentDecoded);
    }

    const escapeDecoded = decodeCommonEscapes(candidate);
    if (escapeDecoded !== candidate) {
      if (hasSensitiveContent(escapeDecoded)) return true;
      pending.push(escapeDecoded);
    }

    if (hasBase64EncodedPrivateEntropy(candidate)) return true;
    const base64Decoded = decodeBase64(candidate);
    if (
      base64Decoded !== undefined &&
      base64Decoded.length < candidate.length
    ) {
      if (hasSensitiveContent(base64Decoded)) return true;
      pending.push(base64Decoded);
    }

    // A complete Base64 value may be wrapped by Markdown punctuation or an
    // application's field syntax. Inspect maximal encoded substrings without
    // compacting arbitrary prose or slicing a longer opaque token.
    for (const encoded of candidate.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/gu)) {
      if (encoded[0] === candidate) continue;
      if (decodedValueContainsSensitiveContent(encoded[0])) return true;
    }
  }
  return false;
}

function scrubEncodedTokens(
  value: string,
  redactedValue: string,
): { value: string; changed: boolean } {
  if (decodedValueContainsSensitiveContent(value)) {
    return { value: redactedValue, changed: true };
  }
  let changed = false;
  let next = value.replace(/\S{8,}/gu, (token) => {
    if (decodedValueContainsSensitiveContent(token)) {
      changed = true;
      return redactedValue;
    }
    return token;
  });

  // Inspect whitespace-wrapped structural byte encodings as one value. The
  // grammar, rather than arbitrary prose whitespace, authorizes compaction.
  next = next.replace(
    /(?:(?:%[0-9a-f]{2})[ \t\r\n]+){1,}(?:%[0-9a-f]{2})/giu,
    (candidate) => {
      const compact = candidate.replace(/\s+/gu, "");
      if (!decodedValueContainsSensitiveContent(compact)) return candidate;
      changed = true;
      return redactedValue;
    },
  );
  next = next.replace(
    /(?:(?:\\x[0-9a-f]{2}|\\u00[0-9a-f]{2})[ \t\r\n]+){1,}(?:\\x[0-9a-f]{2}|\\u00[0-9a-f]{2})/giu,
    (candidate) => {
      const compact = candidate.replace(/\s+/gu, "");
      if (!decodedValueContainsSensitiveContent(compact)) return candidate;
      changed = true;
      return redactedValue;
    },
  );
  next = next.replace(
    /(?:(?:&(?:amp;)*#(?:x[0-9a-f]+|\d+);)[ \t\r\n]+){1,}(?:&(?:amp;)*#(?:x[0-9a-f]+|\d+);)/giu,
    (candidate) => {
      const compact = candidate.replace(/\s+/gu, "");
      if (!decodedValueContainsSensitiveContent(compact)) return candidate;
      changed = true;
      return redactedValue;
    },
  );

  // Base64 is routinely wrapped by mail clients and text areas. Inspect a
  // whitespace-separated run as one encoded value and remove the exact run if
  // any finite decode chain exposes prohibited content.
  next = next.replace(
    /(?:[A-Za-z0-9+/_-]{4,}={0,2}[ \t\r\n]+){1,}[A-Za-z0-9+/_-]{4,}={0,2}/gu,
    (candidate) => {
      const decoded = decodeBase64(candidate, true);
      const segments = candidate.trim().split(/\s+/gu);
      const wrappedWidth = segments[0]?.replace(/=+$/u, "").length ?? 0;
      const canonicallyWrapped =
        wrappedWidth >= 4 &&
        segments
          .slice(0, -1)
          .every(
            (segment) => segment.replace(/=+$/u, "").length === wrappedWidth,
          ) &&
        (segments[segments.length - 1]?.replace(/=+$/u, "").length ?? 0) <=
          wrappedWidth;
      const containsSensitiveText =
        decoded !== undefined &&
        (hasSensitiveContent(decoded) ||
          decodedValueContainsSensitiveContent(decoded));
      if (
        !containsSensitiveText &&
        !(canonicallyWrapped && hasBase64EncodedPrivateEntropy(candidate, true))
      ) {
        return candidate;
      }
      changed = true;
      return redactedValue;
    },
  );
  // Partial removal from a nested/wrapped encoding could leave undiscovered
  // fragments. Once any encoded representation is sensitive, fail closed for
  // the complete field rather than attempting source-span reconstruction.
  return { value: changed ? redactedValue : next, changed };
}

export function scrubFeedbackText(
  value: string,
  redactedValue: string,
): {
  text: string;
  findings: readonly ScrubFinding[];
} {
  const findings = new Set<ScrubFinding>();
  let text = value.normalize("NFKC").replace(/\r\n?/gu, "\n");
  const allowedEmails: string[] = [];
  text = text.replace(ALLOWED_EMAIL, (email) => {
    const index = allowedEmails.push(email) - 1;
    return `zuuliAllowedEmail${index}Placeholder`;
  });
  const withoutInvisible = text
    .replace(DEFAULT_IGNORABLE_CHARACTERS, "")
    .replace(COMBINING_OVERLAYS, "");
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
  if (
    containsEnglishBip39Candidate(text) ||
    hasTotpShapedValue(text) ||
    hasSuspiciousMixedScriptToken(text) ||
    hasConfusableSensitiveLabel(text) ||
    hasSensitiveContent(text)
  ) {
    findings.add("secret-or-wallet-data");
  }

  // Any partial removal risks leaving a second-pass-safe residual (for
  // example, the directory portion of a path). A field with any finding is
  // therefore replaced atomically; a second review is stable by construction.
  if (findings.size > 0)
    return { text: redactedValue, findings: [...findings] };
  text = text.replace(
    /zuuliAllowedEmail(\d+)Placeholder/gu,
    (_match, index) => allowedEmails[Number(index)] ?? redactedValue,
  );
  return { text, findings: [] };
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
  const findings = new Set([...subject.findings, ...body.findings]);
  if (findings.size > 0) {
    return {
      draft: { subject: redactedValue, body: redactedValue },
      findings: [...findings],
    };
  }
  const combined = scrubFeedbackText(
    `${subject.text}\n${body.text}`,
    redactedValue,
  );
  for (const finding of combined.findings) findings.add(finding);
  const compactCombinedIsEncodedSecret = decodedValueContainsSensitiveContent(
    `${subject.text}${body.text}`,
  );
  if (compactCombinedIsEncodedSecret) findings.add("encoded-sensitive-value");
  if (combined.findings.length > 0 || compactCombinedIsEncodedSecret) {
    return {
      draft: { subject: redactedValue, body: redactedValue },
      findings: [...findings],
    };
  }
  return {
    draft: { subject: subject.text, body: body.text },
    findings: [...findings],
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
import { containsEnglishBip39Candidate } from "./bip39";
