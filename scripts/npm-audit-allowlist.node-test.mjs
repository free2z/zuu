import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, ALLOWLIST } from "./npm-audit-allowlist.mjs";

const BR = "GHSA-vfj7-8cjw-p6xm";
const adv = (name, id, severity = "high") => ({ name, severity, title: "t", url: `https://github.com/advisories/${id}` });
const report = (...vias) => ({ vulnerabilities: { braces: { severity: "high", via: vias }, micromatch: { severity: "high", via: ["braces"] } } });
const before = new Date("2026-10-05T00:00:00Z");

// Retired production waiver: preserve historical expiry and package-binding
// coverage without keeping an unused exception in the live allowlist.
const historicalAllowlist = [{
  id: BR,
  package: "braces",
  expires: "2026-11-03",
  issue: "https://github.com/free2z/zuu/issues/1130",
  reason: "historical build-time waiver",
}, ...ALLOWLIST];

test("braces advisory waived while live", () => {
  const r = evaluate(report(adv("braces", BR)), historicalAllowlist, before);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.waived, [BR]);
});
test("any other high advisory fails", () => {
  const r = evaluate(report(adv("braces", BR), adv("lodash", "GHSA-aaaa-bbbb-cccc")), historicalAllowlist, before);
  assert.equal(r.problems.length, 1);
});
test("same id on a different package is not waived", () => {
  assert.equal(evaluate(report(adv("evil", BR)), historicalAllowlist, before).problems.length, 1);
});
test("critical severity of another advisory fails; moderate ignored", () => {
  assert.equal(evaluate(report(adv("x", "GHSA-aaaa-bbbb-cccc", "critical")), historicalAllowlist, before).problems.length, 1);
  assert.equal(evaluate(report(adv("x", "GHSA-aaaa-bbbb-cccc", "moderate")), historicalAllowlist, before).problems.length, 0);
});
test("expired entry fails even if advisory present", () => {
  const r = evaluate(report(adv("braces", BR)), historicalAllowlist, new Date("2026-11-04T00:00:00Z"));
  assert.ok(r.problems.some((p) => /EXPIRED/.test(p)));
  assert.ok(r.problems.some((p) => /braces/.test(p)));
});
test("expired entry fails even with a clean report", () => {
  const r = evaluate({ vulnerabilities: {} }, historicalAllowlist, new Date("2026-11-04T00:00:00Z"));
  assert.ok(r.problems.some((p) => /EXPIRED/.test(p)));
});
test("malformed report is not a pass", () => {
  assert.ok(evaluate({}, historicalAllowlist, before).unparseable);
});
test("allowlist is exactly the known entries, each with an issue and a 30-day expiry", () => {
  assert.deepEqual(
    ALLOWLIST.map((e) => [e.id, e.package, e.issue.split("/").pop()]),
    [
      ["GHSA-5gmw-xhrv-c9v3", "tinypool", "1173"],
      ["GHSA-85c8-ppgw-ccpr", "tinypool", "1174"],
      ["GHSA-68fv-2mgg-jv7q", "source-map-js", "1176"],
    ],
  );
  for (const e of ALLOWLIST) assert.equal(e.expires, "2026-11-04");
});


test("retired braces waiver cannot hide a returning advisory", () => {
  const r = evaluate(report(adv("braces", BR)), ALLOWLIST, new Date("2026-11-04T00:00:00Z"));
  assert.deepEqual(r.waived, []);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /braces/);
});
test("live allowlist accepts a clean report before remaining waivers expire", () => {
  const r = evaluate({ vulnerabilities: {} }, ALLOWLIST, new Date("2026-11-04T00:00:00Z"));
  assert.deepEqual(r.problems, []);
});
