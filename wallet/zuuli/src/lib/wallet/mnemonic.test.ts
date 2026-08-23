import { describe, expect, it } from "vitest";
import {
  isSupportedBip39WordCount,
  SUPPORTED_BIP39_WORD_COUNTS,
} from "./mnemonic";

describe("BIP39 recovery word counts", () => {
  it("accepts exactly every native-supported phrase length", () => {
    expect(SUPPORTED_BIP39_WORD_COUNTS).toEqual([12, 15, 18, 21, 24]);

    for (const wordCount of [12, 15, 18, 21, 24]) {
      expect(isSupportedBip39WordCount(wordCount)).toBe(true);
    }
    for (const wordCount of [0, 11, 13, 14, 16, 17, 19, 20, 22, 23, 25]) {
      expect(isSupportedBip39WordCount(wordCount)).toBe(false);
    }
  });
});
