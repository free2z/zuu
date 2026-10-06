#!/usr/bin/env node
// `npm audit --audit-level=high` with a SINGLE-ADVISORY, time-boxed exception list.
// Run from a package directory (the one holding package-lock.json), or pass that directory as argv[2].
// Exit 0 = nothing high/critical outside the live allowlist; 1 = finding or expired entry;
// 2 = audit could not be run/parsed (callers may retry; never a pass).
import { spawnSync } from "node:child_process";

// Each entry: exact GHSA id, hard expiry (UTC date), tracking issue, reason. Never wildcard.
export const ALLOWLIST = [
  {
    id: "GHSA-vfj7-8cjw-p6xm",
    package: "braces",
    expires: "2026-11-03", // 30 days from 2026-10-04
    issue: "https://github.com/free2z/zuu/issues/1130",
    reason: "build-time only via tailwind 3; no runtime exposure",
  },
  {
    id: "GHSA-5gmw-xhrv-c9v3",
    package: "tinypool",
    expires: "2026-11-04", // 30 days from 2026-10-05
    issue: "https://github.com/free2z/zuu/issues/1173",
    reason: "dev/test-only via vitest 3; no patched version in range (needs vitest 5)",
  },
  {
    id: "GHSA-85c8-ppgw-ccpr",
    package: "tinypool",
    expires: "2026-11-04", // 30 days from 2026-10-05
    issue: "https://github.com/free2z/zuu/issues/1174",
    reason: "dev/test-only via vitest 3; no patched version in range (needs vitest 5)",
  },
  {
    id: "GHSA-68fv-2mgg-jv7q",
    package: "source-map-js",
    expires: "2026-11-04", // 30 days from 2026-10-05
    issue: "https://github.com/free2z/zuu/issues/1176",
    reason: "build-time only (postcss/vite); patched in range but lockfile bump invalidates store-capture digests until recapture",
  },
];

const BLOCKING = new Set(["high", "critical"]);

export function evaluate(report, allowlist = ALLOWLIST, now = new Date()) {
  const problems = [];
  const live = new Map();
  for (const e of allowlist) {
    const exp = new Date(`${e.expires}T23:59:59Z`);
    if (Number.isNaN(exp.getTime())) problems.push(`allowlist entry ${e.id} has an invalid expiry`);
    else if (now > exp) problems.push(`allowlist entry ${e.id} EXPIRED on ${e.expires} (${e.issue})`);
    else live.set(e.id, e);
  }
  const vulns = report?.vulnerabilities;
  if (!vulns || typeof vulns !== "object") {
    return { problems: ["audit report has no vulnerabilities object"], waived: [], unparseable: true };
  }
  const waived = new Set();
  const seen = new Set();
  for (const [name, v] of Object.entries(vulns)) {
    for (const via of v.via ?? []) {
      // String vias are transitive links; the root advisory objects are checked below.
      if (typeof via === "string") continue;
      if (!BLOCKING.has(via.severity)) continue;
      const m = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(via.url ?? "");
      const id = m ? m[0] : null;
      const key = `${id ?? via.url ?? via.title}|${via.name ?? name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (id && live.has(id) && live.get(id).package === via.name) waived.add(id);
      else problems.push(`${via.severity} advisory in ${via.name ?? name}: ${via.title ?? ""} ${via.url ?? ""}`.trim());
    }
    // A high/critical vuln with no advisory object and no string via is unexplained: fail.
    if (BLOCKING.has(v.severity) && !(v.via ?? []).length) problems.push(`${v.severity} vulnerability in ${name} with no advisory`);
  }
  return { problems, waived: [...waived], unparseable: false };
}

function main() {
  const r = spawnSync("npm", ["audit", "--json"], { cwd: process.argv[2] || process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    console.error("npm-audit-allowlist: could not parse `npm audit --json` output", r.stderr);
    process.exit(2);
  }
  if (report.error) {
    console.error("npm-audit-allowlist: npm audit error:", JSON.stringify(report.error));
    process.exit(2);
  }
  const { problems, waived, unparseable } = evaluate(report);
  for (const id of waived) {
    const e = ALLOWLIST.find((x) => x.id === id);
    console.log(`npm-audit-allowlist: WAIVED ${id} until ${e.expires} (${e.issue}): ${e.reason}`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`npm-audit-allowlist: FAIL ${p}`);
    process.exit(unparseable ? 2 : 1);
  }
  console.log("npm-audit-allowlist: no high/critical advisories outside the allowlist");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
