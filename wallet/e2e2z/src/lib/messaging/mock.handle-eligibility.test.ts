// `evaluateHandle`'s doc comment (mock.ts §11.3) already states the rule: the
// raw-ASCII check runs before `toLowerCase()`, because `toLowerCase()` can
// turn a non-ASCII string into an ASCII one. U+212A KELVIN SIGN is the
// concrete case that ordering exists for — `"K".toLowerCase()` is `"k"`,
// so a check that lower-cased first and then tested for ASCII would let it
// through as a plain ASCII handle. Nothing exercised that ordering as a
// regression test before this file, so a future edit could restore the
// case-fold-then-check order without any test failing.
import { describe, expect, it } from "vitest";
import fixtureFile from "./handle-eligibility.fixtures.json";
import { evaluateHandle } from "./mock";

describe("handle eligibility uses raw ASCII before case mapping", () => {
  it("rejects Unicode characters that a Unicode lowercase could map to ASCII", () => {
    expect(evaluateHandle("K")).toEqual({
      eligible: false,
      candidate: null,
      reason: "non-ascii",
    });
  });

  it("maps ASCII uppercase only after the raw ASCII check", () => {
    expect(evaluateHandle("Alice_1")).toEqual({
      eligible: true,
      candidate: "alice_1",
      reason: null,
    });
  });
});

// `docs/e2ee/WIRE.md` §14.1: "A conforming implementation of this section MUST
// maintain a mutation-sensitive test that checks the Rust and TypeScript
// implementations against one shared table of (input → expected
// HandleEligibility) fixtures ... so that an edit to either implementation
// which drifts from the other, or from this table, fails a test rather than
// shipping unnoticed." Rust and TypeScript cannot literally share a test
// file, so the fixture table is the thing kept in one place:
// `./handle-eligibility.fixtures.json`, imported here as an ordinary JSON
// module (this file's TS project boundary keeps it from reaching outside
// wallet/zuuli — no `node:fs`/`node:url`, matching the pattern
// `src/i18n/locales/*.json` already uses) and read by
// `wallet/plugins/tauri-plugin-f2zmsg/src/handle.rs`'s own `#[cfg(test)]`
// module via `include_str!` at a fixed relative path into this directory.
// Neither file is the source of truth for the other; both are pinned to the
// fixture, and the fixture's own `$comment`s explain why each case is in it.
//
// This is the test #838 calls for. It also reproduces #838's own bug as one
// row in the table rather than a one-off assertion:
// `evaluateHandle("")` used to answer `"not-signed-in"`; the fixture (and
// `handle.rs::eligibility("")`) says `"punctuation"`. A future regression of
// either kind — mock drifting from Rust, or either drifting from this file —
// fails here.
interface HandleEligibilityFixtureCase {
  label: string;
  input: string | null;
  expected: {
    eligible: boolean;
    candidate: string | null;
    reason: string | null;
  };
}

const fixture = fixtureFile as unknown as {
  cases: HandleEligibilityFixtureCase[];
};

describe("evaluateHandle matches the shared Rust↔mock fixture table (WIRE.md §14.1)", () => {
  it.each(fixture.cases.map((testCase) => [testCase.label, testCase] as const))(
    "%s",
    (_label, testCase) => {
      expect(evaluateHandle(testCase.input)).toEqual(testCase.expected);
    },
  );
});
