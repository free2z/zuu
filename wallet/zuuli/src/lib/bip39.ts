import { BIP39_ENGLISH_WORD_INDEX } from "./bip39-english";

const SUPPORTED_WORD_COUNTS = [12, 15, 18, 21, 24] as const;
const SUPPORTED_WORD_COUNT_SET = new Set<number>(SUPPORTED_WORD_COUNTS);

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
  0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
  0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
  0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, distance: number): number {
  return (value >>> distance) | (value << (32 - distance));
}

// Synchronous because final feedback validation must finish before any copy or
// external-app call. This small SHA-256 implementation only validates BIP-39's
// 16–32 byte entropy; it is not used for wallet key material or derivation.
function sha256(input: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  new DataView(padded.buffer).setUint32(
    paddedLength - 4,
    input.length * 8,
    false,
  );

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);
  const view = new DataView(padded.buffer);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = schedule[index - 15];
      const previous2 = schedule[index - 2];
      const sigma0 =
        rotateRight(previous15, 7) ^
        rotateRight(previous15, 18) ^
        (previous15 >>> 3);
      const sigma1 =
        rotateRight(previous2, 17) ^
        rotateRight(previous2, 19) ^
        (previous2 >>> 10);
      schedule[index] =
        (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h + sum1 + choice + SHA256_CONSTANTS[index] + schedule[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  state.forEach((value, index) => digestView.setUint32(index * 4, value, false));
  return digest;
}

function wordIndices(words: readonly string[]): number[] | undefined {
  const indices = words.map((word) => BIP39_ENGLISH_WORD_INDEX.get(word));
  return indices.every((index): index is number => index !== undefined)
    ? indices
    : undefined;
}

export function isValidEnglishBip39Mnemonic(words: readonly string[]): boolean {
  if (!SUPPORTED_WORD_COUNT_SET.has(words.length)) return false;
  const indices = wordIndices(words);
  if (indices === undefined) return false;
  const bits = indices.map((index) => index.toString(2).padStart(11, "0")).join("");
  const entropyBitLength = (words.length * 11 * 32) / 33;
  const checksumBitLength = bits.length - entropyBitLength;
  const entropy = new Uint8Array(entropyBitLength / 8);
  for (let index = 0; index < entropy.length; index += 1) {
    entropy[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  }
  const expected = sha256(entropy)[0]
    .toString(2)
    .padStart(8, "0")
    .slice(0, checksumBitLength);
  return bits.slice(entropyBitLength) === expected;
}

export function containsEnglishBip39Candidate(value: string): boolean {
  const words = [...value.normalize("NFKD").toLowerCase().matchAll(/[a-z]+/gu)].map(
    (match) => match[0],
  );
  for (const count of [...SUPPORTED_WORD_COUNTS].reverse()) {
    for (let start = 0; start + count <= words.length; start += 1) {
      const candidate = words.slice(start, start + count);
      // A checksum-valid phrase is certainly private. A supported-length
      // all-dictionary phrase is also removed because one mistyped checksum
      // bit does not make recovery words safe to disclose.
      if (wordIndices(candidate) !== undefined) {
        return true;
      }
    }
  }
  return false;
}
