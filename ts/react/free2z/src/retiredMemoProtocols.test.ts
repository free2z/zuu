//the classic bundle must not build a retired Free2Z memo protocol.
//
// `{"act": "page_fund"}` / `{"act": "page_comment"}` (and their de-* inverses)
// were instructions to a Free2Z wallet -- "boost/comment with Zcash". They are
// retired: those actions are 2Z actions, and ZEC sent to Free2Z is only
// ever for buying 2Z (`act: "buy_2z"`, TuzisDialog). `credit_pages_unified`
// stays in the credit loop only as a compatibility window, and it may be
// retired only once no deployed UI can generate these memos
// (docs/zcash/wallet-pipeline.md, "The ZEC product boundary ").
//
// The classic bundle is still deployed (the `@classic_fallback` shell), so a
// component that reintroduced one of these QRs would have a supporter pay real
// ZEC to Free2Z for nothing. Nothing renders every classic component in a
// test, so this checks the source the bundle is built from.
import * as fs from "fs";
import * as path from "path";

const RETIRED = ["page_fund", "page_comment", "page_defund", "page_decomment"];

// `act: "page_comment"`, `"act": 'page_fund'`, `act:"page_defund"`... --
// the key/value shape of a memo object literal, not the bare word, so prose
// comments explaining the retirement stay allowed.
const MEMO_ACT = new RegExp(
  String.raw`["']?act["']?\s*:\s*["'\`](${RETIRED.join("|")})["'\`]`,
);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.(tsx?|jsx?)$/.test(entry.name)) return [];
    if (/\.test\.(tsx?|jsx?)$/.test(entry.name)) return [];
    return [full];
  });
}

it("scans a non-trivial classic source tree", () => {
  // Guards against the scan silently covering nothing (wrong root, renamed
  // directory) and the assertion below passing vacuously.
  const files = sourceFiles(__dirname).map((f) => path.relative(__dirname, f));
  expect(files.length).toBeGreaterThan(50);
  expect(files).toContain(path.join("components", "PageRenderer.tsx"));
  expect(files).toContain(path.join("components", "TuzisDialog.tsx"));
});

it("the memo pattern matches the retired shape and not the live buy_2z one", () => {
  expect(MEMO_ACT.test('act: "page_comment",')).toBe(true);
  expect(MEMO_ACT.test(`"act": 'page_fund'`)).toBe(true);
  expect(MEMO_ACT.test('act: "buy_2z",')).toBe(false);
  expect(MEMO_ACT.test("a `page_fund` memo. That protocol is retired")).toBe(
    false,
  );
});

it("no classic component builds a retired page_* memo", () => {
  const offenders = sourceFiles(__dirname)
    .filter((file) => MEMO_ACT.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(__dirname, file));
  expect(offenders).toEqual([]);
});
