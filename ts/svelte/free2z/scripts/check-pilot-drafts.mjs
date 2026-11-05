import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  load,
  flatten,
  hash,
  importPilot,
  sensitive,
  PILOT_LOCALES,
} from "./catalog-governance.mjs";

const read = (path) =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const data = load();
const draftInput = read("tests/pilot/drafts.json");
for (const [index, locale] of PILOT_LOCALES.entries()) {
  const catalog = flatten(read(`src/lib/locales/pilot/${locale}.json`));
  const metadata = read(`tests/pilot/${locale}.metadata.json`);
  const keys = Object.keys(catalog).sort();
  assert.deepEqual(
    keys,
    Object.keys(draftInput).sort(),
    `${locale}: draft inventory`,
  );
  assert.deepEqual(
    keys,
    Object.keys(metadata).sort(),
    `${locale}: metadata inventory`,
  );
  const rows = keys.map((key) => {
    const record = metadata[key];
    assert.equal(
      catalog[key],
      draftInput[key][index],
      `${locale}:${key}: input differs`,
    );
    assert.equal(
      record.translationHash,
      hash(catalog[key]),
      `${locale}:${key}: changed translation`,
    );
    assert.equal(record.status, "draft", `${locale}:${key}: must remain draft`);
    assert.equal(
      record.provenance,
      "Local model-produced draft; human review pending",
    );
    return {
      locale,
      key,
      sourceHash: record.sourceHash,
      translation: catalog[key],
      metadata: record,
    };
  });
  const validated = importPilot(data, locale, rows);
  assert.deepEqual(
    validated.messages,
    Object.fromEntries(rows.map((row) => [row.key, row.translation])),
  );
  console.log(
    `${locale}: ${keys.length} draft, ${Object.keys(data.source).length - keys.length} fallback, 0 reviewed, ${keys.filter(sensitive).length} sensitive pending`,
  );
}
