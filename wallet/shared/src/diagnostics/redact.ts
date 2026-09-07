/**
 * The only place free-form text is allowed to become a diagnostic field.
 *
 * ## The shape of the problem
 *
 * `vocabulary.ts` closes every field a caller controls, so three strings are
 * left that nobody can close: an `Error`'s `name`, its `message`, and its
 * `stack`. Those come from the engine, from a library, or from a `throw new
 * Error(...)` somebody wrote — and a message is one template literal away from
 * carrying an address, a handle, a memo or an amount.
 *
 * ## Deny-listing is the weak form
 *
 * A regex that removes the secrets it recognises is only ever as good as its
 * last update, and it fails open: the shape it has not met survives. This
 * module inverts that. **A token is dropped unless it matches a shape known to
 * be safe**, so an unfamiliar shape fails closed and becomes
 * `[redacted:<class>]` — a label describing the shape, never the value.
 *
 * `wallet/zuuli/src/lib/feedback.ts` keeps the complementary deny-list, and it
 * is right where it sits: that scrubber reviews prose a human typed on purpose,
 * where removing everything unrecognised would remove the report. Here nothing
 * was typed on purpose, so nothing unrecognised is worth keeping.
 *
 * ## The three rules
 *
 * 1. **Token allow-list.** Words, small numbers and code identifiers survive.
 *    Anything long, anything encoded, anything with a digit in it past a few
 *    characters, anything with a path, host, `@` or non-Latin letter does not.
 *    That covers addresses, keys, tokens, ids, amounts and file paths by shape
 *    rather than by name.
 * 2. **Word-run collapse.** A recovery phrase is short lowercase dictionary
 *    words and passes rule 1 word by word. So a run of
 *    {@link WORD_RUN_LIMIT} or more consecutive bare lowercase 3–8 letter
 *    words collapses whole. Real error messages break such a run within a few
 *    words on punctuation, capitals, or a longer word; a twelve-word mnemonic
 *    never does.
 * 3. **Volume caps, and the one limit worth stating plainly.** Message
 *    plaintext and memos are prose, and prose is genuinely indistinguishable
 *    from an English error message token by token — "bring the blue folder"
 *    and "could not read the file" have the same shape, the same word lengths
 *    and the same punctuation. No token rule separates them, and a rule
 *    aggressive enough to remove one removes the other, which would leave the
 *    diagnostics screen unable to say anything.
 *
 *    So rule 3 does not claim to eliminate prose. It **bounds** it —
 *    {@link MAX_MESSAGE_TOKENS} tokens and {@link MAX_MESSAGE_CHARACTERS}
 *    characters, both set to what an error message needs and no more.
 *
 *    The control that does eliminate it is upstream and structural: nothing in
 *    this codebase interpolates a memo or a message body into an `Error`, and
 *    `record.ts` refuses to serialize a thrown object at all, so a state blob
 *    carrying a body cannot be stringified into a record either. If a call
 *    site ever writes ``new Error(`failed to send ${body}`)``, redaction is not
 *    what should stop it — review is.
 *
 * ## Where this runs
 *
 * At `record()` time, before anything is placed in the ring buffer — never at
 * export time. The buffer therefore cannot hold an unredacted value at all,
 * which removes the whole class of bug where one export path forgot to filter.
 */

/** The shape a dropped token had, which is all a reader learns about it. */
export const REDACTION_CLASSES = [
  "number",
  "handle",
  "url",
  "path",
  "address",
  "encoded",
  "word-run",
  "source",
  "name",
  "value",
] as const;

/** One of {@link REDACTION_CLASSES}. */
export type RedactionClass = (typeof REDACTION_CLASSES)[number];

/** Consecutive bare lowercase 3–8 letter words that collapse as a run. */
export const WORD_RUN_LIMIT = 8;

/** Most tokens a scrubbed message may keep. */
export const MAX_MESSAGE_TOKENS = 32;

/**
 * Most characters a scrubbed message may keep.
 *
 * Set by what an error message needs rather than by what is convenient: the
 * longest real messages in this codebase are well under this, and every
 * character of headroom above that is headroom prose can occupy. See rule 3.
 */
export const MAX_MESSAGE_CHARACTERS = 240;

/**
 * Most characters read from any single input before scrubbing begins.
 *
 * Far above what an error message is, and far below what a runaway one could
 * be. The output caps below do the shaping; this one exists only so the work
 * done to get there stays bounded.
 */
export const MAX_INPUT_CHARACTERS = 8_192;

/** Most stack frames a record keeps. */
export const MAX_STACK_FRAMES = 12;

/** Most lines of a stack searched for those frames. */
export const MAX_STACK_LINES_EXAMINED = 64;

/** Longest line searched; a real frame is far shorter than this. */
export const MAX_STACK_LINE_LENGTH = 1_024;

/** Appended when a cap truncated the text. */
export const TRUNCATION_MARK = "[…]";

/** The placeholder a dropped token becomes. */
export function redactionMark(kind: RedactionClass): string {
  return `[redacted:${kind}]`;
}

// Control characters, invisible formatting and bidi overrides are stripped
// before anything is classified: a right-to-left override inside a token can
// make a rendered report say something other than what it holds, and the repo
// already treats bidi in source and copy as a policy matter.
const DISCARDED_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/gu;

const LEADING_WRAPPERS = /^[([{"'`\u00ab\u2039\u201c\u2018]+/u;
const TRAILING_WRAPPERS =
  /[)\]}"'`\u00bb\u203a\u201d\u2019.,;:!?]+$/u;

const WORD = /^[A-Za-z][A-Za-z'\u2019-]{0,23}$/u;
const BARE_LOWERCASE_WORD = /^[a-z]{3,8}$/u;
const SMALL_NUMBER = /^\d{1,3}$/u;
const LINE_AND_COLUMN = /^\d{1,5}:\d{1,5}$/u;
const CODE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*(?:[.#][A-Za-z0-9_$]+)*$/u;
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}]{1,3}$/u;
const QUANTITY = /^[\d][\d.,]*$/u;
const BECH32_LIKE = /^[A-Za-z]{1,14}1[02-9ac-hj-np-z]{8,}$/u;
const BASE64_LIKE = /^[A-Za-z0-9+/_-]{16,}={0,2}$/u;

/** Longest token kept verbatim; anything longer is an encoded value by size. */
const MAX_TOKEN_LENGTH = 24;

/**
 * A digit is the tell. Identifiers, addresses, keys, hashes, tokens, amounts
 * and record ids all carry them; the English words an error message is made of
 * mostly do not. So a token that mixes digits into more than a few characters
 * is treated as a value rather than as prose.
 */
const MAX_LENGTH_WITH_DIGITS = 7;

function classify(core: string): RedactionClass {
  if (core.includes("@")) return "handle";
  if (core.includes("://") || core.startsWith("www.")) return "url";
  if (core.includes("/") || core.includes("\\")) return "path";
  if (BECH32_LIKE.test(core)) return "address";
  if (QUANTITY.test(core)) return "number";
  if (BASE64_LIKE.test(core)) return "encoded";
  return "value";
}

function isSafeCore(core: string): boolean {
  if (core.length === 0) return false;
  if (core.length > MAX_TOKEN_LENGTH) return false;
  if (PUNCTUATION_ONLY.test(core)) return true;
  if (BECH32_LIKE.test(core)) return false;
  if (/\d/u.test(core)) {
    // `1.5`, `0.00123` and `9,000` are quantities whatever their length, and a
    // transaction amount is exactly that shape.
    if (/[.,]/u.test(core) && QUANTITY.test(core)) return false;
    if (LINE_AND_COLUMN.test(core)) return true;
    if (SMALL_NUMBER.test(core)) return true;
    if (core.length > MAX_LENGTH_WITH_DIGITS) return false;
  }
  if (WORD.test(core)) return true;
  return CODE_IDENTIFIER.test(core);
}

interface ClassifiedToken {
  readonly text: string;
  readonly runnable: boolean;
}

function scrubToken(token: string): ClassifiedToken {
  const core = token
    .replace(LEADING_WRAPPERS, "")
    .replace(TRAILING_WRAPPERS, "");
  // Stripping the wrappers off a token that was only punctuation leaves
  // nothing. A bare comma is not a value, so it survives as itself rather than
  // becoming a redaction mark that would make the sentence unreadable.
  if (core.length === 0) {
    return PUNCTUATION_ONLY.test(token)
      ? { text: token, runnable: false }
      : { text: redactionMark(classify(token)), runnable: false };
  }
  if (!isSafeCore(core)) {
    return { text: redactionMark(classify(core)), runnable: false };
  }
  return {
    text: token,
    runnable: core === token && BARE_LOWERCASE_WORD.test(token),
  };
}

function collapseWordRuns(tokens: readonly ClassifiedToken[]): string[] {
  const output: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= WORD_RUN_LIMIT) output.push(redactionMark("word-run"));
    else output.push(...run);
    run = [];
  };
  for (const token of tokens) {
    if (token.runnable) run.push(token.text);
    else {
      flush();
      output.push(token.text);
    }
  }
  flush();
  return output;
}

function normalize(value: string): string {
  // Cut before normalizing, not after. `normalize` and the classifier both walk
  // the whole string, and this runs inside the engine's error path — a
  // pathological message must not turn capturing a crash into the crash.
  let text = value.length > MAX_INPUT_CHARACTERS
    ? value.slice(0, MAX_INPUT_CHARACTERS)
    : value;
  try {
    text = text.normalize("NFKC");
  } catch {
    // A lone surrogate makes `normalize` throw. The unnormalized text is still
    // scrubbed by the same rules, so there is nothing to recover from.
  }
  return text.replace(DISCARDED_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
}

/**
 * Reduce free-form text to the tokens proven safe to keep.
 *
 * Whitespace collapses to single spaces, so the result is always one line: a
 * ring-buffer record is a row, not a document, and a multi-line value in a
 * markdown table is a rendering bug waiting to happen.
 */
export function scrubText(value: string): string {
  const normalized = normalize(value);
  if (normalized.length === 0) return "";
  const tokens = normalized.split(" ").filter((token) => token.length > 0);
  let truncated = tokens.length > MAX_MESSAGE_TOKENS;
  const scrubbed = collapseWordRuns(
    tokens.slice(0, MAX_MESSAGE_TOKENS).map(scrubToken),
  );
  // The character cap is applied token by token rather than by slicing the
  // joined string, so a redaction mark is never cut in half into something that
  // reads like a value.
  const kept: string[] = [];
  let length = 0;
  for (const token of scrubbed) {
    const next = length === 0 ? token.length : length + 1 + token.length;
    if (next > MAX_MESSAGE_CHARACTERS) {
      truncated = true;
      break;
    }
    kept.push(token);
    length = next;
  }
  const text = kept.join(" ");
  return truncated ? `${text} ${TRUNCATION_MARK}`.trim() : text;
}

const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$.<>[\]]{0,63}$/u;

/**
 * Keep a symbol name — an `Error` subclass, a stack frame's function — only if
 * it looks like one. A name is code the build wrote, but `new Error()` lets a
 * caller set `name` to anything, so it is checked rather than trusted.
 */
export function scrubIdentifier(value: string): string {
  const trimmed = normalize(value);
  if (trimmed.length === 0) return "";
  if (!SAFE_IDENTIFIER.test(trimmed)) return redactionMark("name");
  if (/\d/u.test(trimmed) && trimmed.length > MAX_TOKEN_LENGTH) {
    return redactionMark("name");
  }
  return trimmed;
}

const SAFE_SOURCE_NAME = /^[A-Za-z0-9._-]{1,64}$/u;

/**
 * Reduce a stack frame's source to a bare file name.
 *
 * The full URL is dropped rather than kept: on desktop it is an absolute
 * `file://` path that names the account, and a `blob:` or `data:` URL can carry
 * the module's own text. A hashed bundle name identifies the build, which is
 * the part worth having.
 */
export function scrubSource(value: string): string {
  const normalized = normalize(value);
  if (normalized.length === 0) return "";
  const withoutQuery = normalized.split(/[?#]/u, 1)[0] ?? "";
  const segments = withoutQuery.split(/[/\\]/u);
  const name = segments[segments.length - 1] ?? "";
  return SAFE_SOURCE_NAME.test(name) ? name : redactionMark("source");
}

/** One line of a stack, reduced to the parts that are code rather than data. */
export interface DiagnosticFrame {
  /** The function name, scrubbed, or `""` when the engine gave none. */
  readonly fn: string;
  /** The bare source file name, scrubbed. */
  readonly source: string;
  /** 1-based line, or 0 when the engine gave none. */
  readonly line: number;
  /** 1-based column, or 0 when the engine gave none. */
  readonly column: number;
}

// V8: "    at fn (url:line:col)" or "    at url:line:col".
const V8_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/u;
// JavaScriptCore and SpiderMonkey: "fn@url:line:col". This is the shape iOS
// gives us, which is the platform #973 was reported from.
const AT_FRAME = /^(.*?)@(.+?):(\d+):(\d+)$/u;

function parseFrame(line: string): DiagnosticFrame | null {
  const match = V8_FRAME.exec(line) ?? AT_FRAME.exec(line);
  if (!match) return null;
  const [, fn, source, lineNumber, column] = match;
  return {
    fn: scrubIdentifier(fn ?? ""),
    source: scrubSource(source ?? ""),
    line: Number.parseInt(lineNumber ?? "0", 10) || 0,
    column: Number.parseInt(column ?? "0", 10) || 0,
  };
}

/**
 * Parse a stack into frames, dropping every line that is not one.
 *
 * A stack's first line repeats the message on V8 and is absent on WebKit, and
 * an unparsed line is text of unknown provenance. Both are discarded rather
 * than scrubbed and kept: the message is already a field of its own, and a line
 * that does not parse as a frame is not evidence worth the risk.
 */
export function scrubStack(stack: string): DiagnosticFrame[] {
  const frames: DiagnosticFrame[] = [];
  // Both frame patterns are lazy and would backtrack over a long line that is
  // not a frame at all. Twelve frames is what a record keeps, so the search for
  // them is bounded too rather than running the width of an arbitrary string.
  const lines = stack.split("\n", MAX_STACK_LINES_EXAMINED);
  for (const line of lines) {
    if (frames.length >= MAX_STACK_FRAMES) break;
    if (line.length > MAX_STACK_LINE_LENGTH) continue;
    const frame = parseFrame(line);
    if (frame) frames.push(frame);
  }
  return frames;
}
