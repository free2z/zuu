#!/usr/bin/env node

// Check the checked-in shard lists against Playwright's actual enumeration.
// A typo, stale test title, overlap, or newly added unassigned test must make
// the browser gate fail before any shard can pass green with missing coverage.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? "ts/svelte/free2z");
const playwright = resolve(appDir, "node_modules/.bin/playwright");
const listDir = resolve(appDir, "tests/browser/ci-shards");
const totalShards = 8;

function enumerate(extraArgs) {
  let stdout;
  try {
    stdout = execFileSync(
      playwright,
      ["test", "--list", "--reporter=json", ...extraArgs],
      {
        cwd: appDir,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    process.stderr.write(error.stderr ?? "");
    process.stderr.write(error.stdout ?? "");
    throw error;
  }
  const report = JSON.parse(stdout.slice(stdout.indexOf("{")));
  const ids = [];

  function visit(suites) {
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          ids.push(`${spec.id}:${test.projectId}`);
        }
      }
      visit(suite.suites ?? []);
    }
  }

  visit(report.suites);
  return ids;
}

const full = enumerate([]);
if (full.length === 0 || new Set(full).size !== full.length) {
  throw new Error(
    `full Playwright enumeration is empty or duplicated (${full.length} entries)`,
  );
}

const assigned = [];
const shardCounts = [];
for (let shard = 1; shard <= totalShards; shard += 1) {
  const list = resolve(listDir, `shard-${shard}.list`);
  if (!existsSync(list)) throw new Error(`missing shard list: ${list}`);
  const ids = enumerate([`--test-list=${list}`]);
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error(
      `shard ${shard}/${totalShards} is empty or duplicates tests (${ids.length} entries)`,
    );
  }
  assigned.push(...ids);
  shardCounts.push(ids.length);
}

const expected = new Set(full);
const counts = new Map();
for (const id of assigned) counts.set(id, (counts.get(id) ?? 0) + 1);
const missing = [...expected].filter((id) => !counts.has(id));
const duplicate = [...counts].filter(([, count]) => count !== 1);
const extra = [...counts.keys()].filter((id) => !expected.has(id));
if (missing.length || duplicate.length || extra.length) {
  throw new Error(
    `shard test coverage mismatch: ${missing.length} missing, ${duplicate.length} duplicated, ${extra.length} extra; ` +
      `examples: missing=${missing.slice(0, 3).join(", ")}; duplicate=${duplicate
        .slice(0, 3)
        .map(([id]) => id)
        .join(", ")}; extra=${extra.slice(0, 3).join(", ")}`,
  );
}

process.stdout.write(
  `PASS: ${full.length} Playwright tests assigned exactly once across ${totalShards} shards ` +
    `(${shardCounts.join(", ")})\n`,
);
