/**
 * Text a wallet can render unambiguously, and nothing else.
 *
 * The exact rule `rs/crates/f2z-intent/src/text.ts`'s Rust twin enforces, and
 * it has to be exact: if the client accepts a string the wallet refuses, the
 * bridge fails at the confirmation with an error nobody can act on, and if the
 * client refuses a string the wallet accepts, the client is the weaker of the
 * two and stops being a useful guard.
 *
 * Refused: non-UTF-8, empty, over 255 bytes, untrimmed, C0/C1 controls, and
 * every Unicode bidirectional or invisible-formatting control. See the Rust
 * module for why this is a refusal rather than `#528`'s visible escaping —
 * the short version is that a `purpose` string is written by another app
 * specifically to appear inside ZUULI's confirmation.
 *
 * Not refused: confusable scripts. Stated in both implementations rather than
 * implied, because the control that stops `раypal` is the caller registry, not
 * this function.
 */

import { IntentErrorCode, refuse } from "./error";

/** The longest a bridge text field may be, in bytes. */
export const MAX_TEXT_BYTES = 255;

const FORBIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

/** Whether a code point may never appear in bridge text. */
export function isForbiddenCodePoint(point: number): boolean {
  return FORBIDDEN_RANGES.some(([low, high]) => point >= low && point <= high);
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/**
 * Decode and validate bridge text.
 *
 * @throws {@link IntentRefusal} with {@link IntentErrorCode.InvalidValue}.
 */
export function parseVisibleText(bytes: Uint8Array): string {
  if (bytes.length === 0 || bytes.length > MAX_TEXT_BYTES) {
    refuse(IntentErrorCode.InvalidValue);
  }
  let text: string;
  try {
    // `fatal: true` is the whole reason this is a TextDecoder and not
    // `String.fromCharCode`: without it, invalid UTF-8 becomes U+FFFD and a
    // malformed field silently turns into a renderable one.
    text = decoder.decode(bytes);
  } catch {
    refuse(IntentErrorCode.InvalidValue);
  }
  if (text.trim() !== text) refuse(IntentErrorCode.InvalidValue);
  for (const character of text) {
    const point = character.codePointAt(0);
    if (point === undefined || isForbiddenCodePoint(point)) {
      refuse(IntentErrorCode.InvalidValue);
    }
  }
  return text;
}

/**
 * Encode text for the wire, applying the same rule.
 *
 * @throws {@link IntentRefusal} with {@link IntentErrorCode.InvalidValue}.
 */
export function encodeVisibleText(text: string): Uint8Array {
  const bytes = encoder.encode(text);
  parseVisibleText(bytes);
  return bytes;
}

/**
 * Replace every forbidden code point with a visible `<U+XXXX>`.
 *
 * For rendering text that has already been accepted — a log line, a diagnostic
 * — so that a renderer stays safe if the parse rule is ever widened.
 */
export function escapeLayoutControls(text: string): string {
  let out = "";
  for (const character of text) {
    const point = character.codePointAt(0);
    if (point !== undefined && isForbiddenCodePoint(point)) {
      out += `<U+${point.toString(16).toUpperCase().padStart(4, "0")}>`;
    } else {
      out += character;
    }
  }
  return out;
}
