import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, ALLOWLIST } from "./npm-audit-allowlist.mjs";

const BR = "GHSA-vfj7-8cjw-p6xm";
const adv = (name, id, severity = "high") => ({ name, severity, title: "t", url: `https://github.com/advisories/${id}` });
const report = (...vias) => ({ vulnerabilities: { braces: { severity: "high", via: vias }, micromatch: { severity: "high", via: ["braces"] } } });
const before = new Date("2026-10-05T00:00:00Z");

test("braces advisory waived while live", () => {
  const r = evaluate(report(adv("braces", BR)), ALLOWLIST, before);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.waived, [BR]);
});
test("any other high advisory fails", () => {
  const r = evaluate(report(adv("braces", BR), adv("lodash", "GHSA-aaaa-bbbb-cccc")), ALLOWLIST, before);
  assert.equal(r.problems.length, 1);
});
test("same id on a different package is not waived", () => {
  assert.equal(evaluate(report(adv("evil", BR)), ALLOWLIST, before).problems.length, 1);
});
test("critical severity of another advisory fails; moderate ignored", () => {
  assert.equal(evaluate(report(adv("x", "GHSA-aaaa-bbbb-cccc", "critical")), ALLOWLIST, before).problems.length, 1);
  assert.equal(evaluate(report(adv("x", "GHSA-aaaa-bbbb-cccc", "moderate")), ALLOWLIST, before).problems.length, 0);
});
test("expired entry fails even if advisory present", () => {
  const r = evaluate(report(adv("braces", BR)), ALLOWLIST, new Date("2026-11-04T00:00:00Z"));
  assert.ok(r.problems.some((p) => /EXPIRED/.test(p)));
  assert.ok(r.problems.some((p) => /braces/.test(p)));
});
test("expired entry fails even with a clean report", () => {
  const r = evaluate({ vulnerabilities: {} }, ALLOWLIST, new Date("2026-11-04T00:00:00Z"));
  assert.ok(r.problems.some((p) => /EXPIRED/.test(p)));
});
test("malformed report is not a pass", () => {
  assert.ok(evaluate({}, ALLOWLIST, before).unparseable);
});
test("allowlist is exactly one entry with issue and 30-day expiry", () => {
  assert.equal(ALLOWLIST.length, 1);
  assert.match(ALLOWLIST[0].issue, /issues\/1130$/);
});
