export const SUPPORTED_BIP39_WORD_COUNTS = [12, 15, 18, 21, 24] as const;

const SUPPORTED_BIP39_WORD_COUNT_SET = new Set<number>(
  SUPPORTED_BIP39_WORD_COUNTS,
);

export function isSupportedBip39WordCount(wordCount: number): boolean {
  return SUPPORTED_BIP39_WORD_COUNT_SET.has(wordCount);
}
