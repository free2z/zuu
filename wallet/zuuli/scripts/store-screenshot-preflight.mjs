#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CAPTURE_NPM_ENVIRONMENT,
  assertNoLocalCaptureOverrides,
  computeCaptureContractDigest,
  computeCaptureSourceDigest,
} from "./store-screenshot-contract.mjs";

const expectedSource = process.env.ZUULI_STORE_EXPECTED_SOURCE_DIGEST ?? "";
const expectedContract = process.env.ZUULI_STORE_EXPECTED_CONTRACT_DIGEST ?? "";

if (!/^[0-9a-f]{64}$/.test(expectedSource) || !/^[0-9a-f]{64}$/.test(expectedContract)) {
  throw new Error("capture preflight requires exact host input digests");
}

const root = resolve(import.meta.dirname, "..");
await assertNoLocalCaptureOverrides(root);
if (process.env.ZUULI_STORE_CAPTURE_CONTAINER === "1") {
  for (const [name, value] of Object.entries(CAPTURE_NPM_ENVIRONMENT)) {
    if (process.env[name] !== value) throw new Error(`capture worker requires canonical ${name}`);
  }
  for (const name of ["NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG"]) {
    if ((await readFile(process.env[name])).length !== 0) throw new Error(`capture worker requires an empty ${name}`);
  }
}
const [source, contract] = await Promise.all([
  computeCaptureSourceDigest(root),
  computeCaptureContractDigest(root),
]);
if (source !== expectedSource || contract !== expectedContract) {
  throw new Error("capture inputs differ from the host-verified preflight");
}
process.stdout.write("capture input preflight passed\n");
