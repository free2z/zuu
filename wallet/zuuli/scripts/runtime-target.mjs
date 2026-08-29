#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PRODUCTION_TARGET_MARKER =
  "zuuli-runtime-target-v1|api=https://free2z.cash|media=https://free2z.cash";
const FORBIDDEN_ARTIFACT_TEXT = [
  "VITE_F2Z_API",
  "VITE_F2Z_MEDIA",
  "VITE_F2Z_PROXY",
  "stage.free2z.cash",
  "new.free2z.cash",
  "test.free2z.cash",
];

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bindingCount(source) {
  const marker = regexEscape(PRODUCTION_TARGET_MARKER);
  const assignment = new RegExp(
    `const\\s+([A-Za-z_$][\\w$]*)=(["'])${marker}\\2;`,
    "g",
  );
  let count = 0;
  for (const match of source.matchAll(assignment)) {
    const markerName = regexEscape(match[1]);
    const getter = new RegExp(
      `function\\s+([A-Za-z_$][\\w$]*)\\(\\)\\{return\\s+[A-Za-z_$][\\w$]*\\(${markerName}\\)\\}`,
    ).exec(source.slice(match.index + match[0].length));
    if (!getter) continue;
    const getterName = regexEscape(getter[1]);
    const origins = new RegExp(
      `const\\s+([A-Za-z_$][\\w$]*)=${getterName}\\(\\),[A-Za-z_$][\\w$]*=\\1\\.api,[A-Za-z_$][\\w$]*=\\1\\.media(?:[,;])`,
    );
    if (origins.test(source.slice(match.index + match[0].length))) count += 1;
  }
  return count;
}

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await javascriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

export async function verifyProductionRuntimeTarget(distDirectory) {
  const files = await javascriptFiles(resolve(distDirectory));
  if (files.length === 0) {
    throw new Error("production runtime target: no JavaScript artifacts found");
  }

  let matches = 0;
  const forbidden = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    matches += bindingCount(source);
    for (const value of FORBIDDEN_ARTIFACT_TEXT) {
      if (source.includes(value)) forbidden.push(value);
    }
  }
  if (forbidden.length !== 0) {
    throw new Error(
      `production runtime target: compiled artifact retained forbidden staging authority: ${[
        ...new Set(forbidden),
      ].join(", ")}`,
    );
  }

  if (matches !== 1) {
    throw new Error(
      `production runtime target: expected exactly one canonical runtime binding, found ${matches}`,
    );
  }
}

async function main(argv) {
  const distArgument = argv.find((argument) => argument.startsWith("--dist="));
  if (!distArgument || argv.length !== 1) {
    throw new Error("usage: node scripts/runtime-target.mjs --dist=<directory>");
  }
  await verifyProductionRuntimeTarget(distArgument.slice("--dist=".length));
  process.stdout.write("Production runtime target verified: free2z.cash API and media.\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
