/**
 * The byte layer of the intent bridge — the TypeScript half of what
 * `rs/crates/f2z-codec` does in Rust.
 *
 * This is deliberately tiny and deliberately hand-written. It is not a general
 * TLS-presentation-language codec; it is exactly the five primitives
 * `docs/intent-bridge/PROTOCOL.md` §3 uses — `uint8`, `uint16`, `uint64`, a
 * fixed-width opaque, and a length-prefixed opaque with an 8-bit or 24-bit
 * prefix — and nothing else. A general codec would be a second encoding
 * surface to audit, in a package that ships inside every client app.
 *
 * Two properties are load-bearing and both are pinned by
 * `wallet/zuuli/src/lib/intent-bridge.test.ts` against the same hex constant
 * `rs/crates/f2z-intent/tests/wire_vectors.rs` pins:
 *
 * 1. **A reader that runs past its input refuses**, rather than reading
 *    undefined or wrapping. Every read is bounds-checked before it happens.
 * 2. **Trailing bytes are an error.** `finish()` is the only way to end a
 *    decode and it refuses anything left over — the first half of the
 *    re-encode-equality rule the wire layer completes.
 */

import { IntentErrorCode, refuse } from "./error";

/** The largest value a 24-bit length prefix can describe. */
export const MAX_U24 = 0xffffff;

/** The largest value an 8-bit length prefix can describe. */
export const MAX_U8 = 0xff;

/** Builds the canonical byte string for one structure. */
export class ByteWriter {
  private readonly chunks: number[] = [];

  /** Append a `uint8`. */
  u8(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > MAX_U8) {
      refuse(IntentErrorCode.InvalidValue);
    }
    this.chunks.push(value);
  }

  /** Append a `uint16`, big-endian. */
  u16(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      refuse(IntentErrorCode.InvalidValue);
    }
    this.chunks.push((value >>> 8) & 0xff, value & 0xff);
  }

  /** Append a `uint24`, big-endian. */
  u24(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > MAX_U24) {
      refuse(IntentErrorCode.InvalidValue);
    }
    this.chunks.push((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }

  /**
   * Append a `uint64`, big-endian.
   *
   * `bigint` and not `number`: milliseconds since the epoch fit in a double
   * today and the protocol's field does not, and a codec whose correctness
   * depends on the values staying small is a codec that breaks silently.
   */
  u64(value: bigint): void {
    if (value < 0n || value > 0xffffffffffffffffn) {
      refuse(IntentErrorCode.InvalidValue);
    }
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      this.chunks.push(Number((value >> shift) & 0xffn));
    }
  }

  /** Append raw bytes with no length prefix. */
  bytes(value: Uint8Array): void {
    for (const byte of value) this.chunks.push(byte);
  }

  /** Append `opaque <0..255>`. */
  opaque8(value: Uint8Array): void {
    if (value.length > MAX_U8) refuse(IntentErrorCode.Malformed);
    this.u8(value.length);
    this.bytes(value);
  }

  /** Append `opaque <0..2^24-1>`. */
  opaque24(value: Uint8Array): void {
    if (value.length > MAX_U24) refuse(IntentErrorCode.Malformed);
    this.u24(value.length);
    this.bytes(value);
  }

  /** The encoded bytes. */
  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

/** Reads one structure, refusing anything the format does not permit. */
export class ByteReader {
  private offset = 0;

  constructor(private readonly source: Uint8Array) {}

  private take(length: number): Uint8Array {
    // The bounds check is before the read, always. A reader that slices past
    // its input in JavaScript gets a short array rather than an error, which
    // is how a truncated frame becomes a structure with plausible-looking
    // zero fields.
    if (length < 0 || this.offset + length > this.source.length) {
      refuse(IntentErrorCode.Malformed);
    }
    const slice = this.source.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  /** Read a `uint8`. */
  u8(): number {
    return this.take(1)[0] as number;
  }

  /** Read a `uint16`, big-endian. */
  u16(): number {
    const bytes = this.take(2);
    return ((bytes[0] as number) << 8) | (bytes[1] as number);
  }

  /** Read a `uint24`, big-endian. */
  u24(): number {
    const bytes = this.take(3);
    return (
      ((bytes[0] as number) << 16) |
      ((bytes[1] as number) << 8) |
      (bytes[2] as number)
    );
  }

  /** Read a `uint64`, big-endian. */
  u64(): bigint {
    let value = 0n;
    for (const byte of this.take(8)) value = (value << 8n) | BigInt(byte);
    return value;
  }

  /** Read `length` raw bytes. A copy, so the caller cannot alias the input. */
  fixed(length: number): Uint8Array {
    return Uint8Array.from(this.take(length));
  }

  /** Read `opaque <0..255>`. */
  opaque8(): Uint8Array {
    return this.fixed(this.u8());
  }

  /** Read `opaque <0..2^24-1>`. */
  opaque24(): Uint8Array {
    return this.fixed(this.u24());
  }

  /**
   * Assert the input is fully consumed.
   *
   * Trailing bytes are a refusal, not a shrug. `WIRE.md` §3.3 names this case
   * by hand: a decoder that ignores what it did not need is a decoder that
   * disagrees with the encoder about what was signed.
   */
  finish(): void {
    if (this.offset !== this.source.length) refuse(IntentErrorCode.Malformed);
  }
}

/** Constant-time-ish byte equality. Length is public; contents are compared in full. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }
  return difference === 0;
}

/** Lowercase hexadecimal, for the wire vectors both languages pin. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Parse lowercase hexadecimal.
 *
 * @throws when the string is not an even-length hex string.
 */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    refuse(IntentErrorCode.Malformed);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}
