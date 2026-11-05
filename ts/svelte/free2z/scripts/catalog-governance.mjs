import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IntlMessageFormat } from "intl-messageformat";
import { LOCALE_REGISTRY } from "../src/lib/locale.js";
import { ICU_MESSAGE_KEYS } from "../src/lib/icu-message.js";

const root = new URL("../", import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function flatten(object, prefix = "", result = {}) {
  for (const [name, value] of Object.entries(object)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (typeof value === "string") result[key] = value;
    else if (value && typeof value === "object" && !Array.isArray(value))
      flatten(value, key, result);
    else throw new Error(`Invalid catalog value: ${key}`);
  }
  return result;
}
const placeholders = (value) =>
  [...new Set([...value.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]))]
    .sort()
    .join(",");
function icuArguments(pattern, locale) {
  const result = new Set();
  function walk(elements) {
    for (const element of elements) {
      if (element.type >= 1 && element.type <= 6) result.add(element.value);
      if (element.options)
        for (const option of Object.values(element.options)) walk(option.value);
      if (element.children) walk(element.children);
    }
  }
  walk(
    new IntlMessageFormat(pattern, locale, undefined, {
      ignoreTag: true,
    }).getAst(),
  );
  return [...result].sort().join(",");
}
const sensitive = (key) =>
  /(^|\.)(auth|login|logout|password|payment|billing|privacy|delete|remove|unsubscribe|account)(\.|$)/i.test(
    key,
  );
function approvedIdentical(entry) {
  return (
    entry?.status === "approved" &&
    ["brand", "code", "acronym"].includes(entry.category) &&
    typeof entry.reviewer === "string" &&
    !!entry.reviewer.trim() &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(entry.reviewedAt || "") &&
    Number.isFinite(Date.parse(entry.reviewedAt)) &&
    Date.parse(entry.reviewedAt) <= Date.now()
  );
}
export function examine(source, catalogs, metadata, baseline) {
  const errors = [],
    queue = [],
    counts = {};
  const exceptions = new Map(
    baseline.map((entry) => [`${entry.locale}:${entry.key}`, entry]),
  );
  const seen = new Set();
  if (exceptions.size !== baseline.length)
    errors.push("duplicate English-identical baseline entry");
  if (baseline.filter((entry) => !approvedIdentical(entry)).length > 160)
    errors.push("English-identical unresolved baseline grew beyond 160");
  for (const [locale, messages] of Object.entries(catalogs)) {
    let present = 0,
      nonIdentical = 0,
      reviewed = 0;
    for (const [key, value] of Object.entries(messages)) {
      if (!(key in source)) {
        errors.push(`${locale}:${key}: unknown key`);
        continue;
      }
      if (!value.trim()) {
        errors.push(`${locale}:${key}: empty translation`);
        continue;
      }
      present++;
      if (value !== source[key]) nonIdentical++;
      if (ICU_MESSAGE_KEYS.includes(key)) {
        try {
          if (icuArguments(source[key], "en") !== icuArguments(value, locale))
            errors.push(`${locale}:${key}: placeholder mismatch`);
        } catch {
          errors.push(`${locale}:${key}: invalid ICU`);
        }
      }
      if (
        !ICU_MESSAGE_KEYS.includes(key) &&
        placeholders(source[key]) !== placeholders(value)
      )
        errors.push(`${locale}:${key}: placeholder mismatch`);
      let identicalApproved = false;
      if (value === source[key]) {
        const id = `${locale}:${key}`,
          exception = exceptions.get(id);
        seen.add(id);
        identicalApproved = approvedIdentical(exception);
        if (exception?.status === "approved" && !identicalApproved)
          errors.push(`${id}: invalid identical approval`);
        if (
          !exception ||
          exception.sourceHash !== hash(source[key]) ||
          exception.translationHash !== hash(value) ||
          !exception.owner ||
          !exception.reason
        )
          errors.push(`${id}: unowned English-identical translation`);
      }
      const record = metadata[locale]?.[key];
      if (record) {
        if (
          !["draft", "reviewed"].includes(record.status) ||
          !/^[a-f0-9]{64}$/.test(record.sourceHash || "") ||
          !/^[a-f0-9]{64}$/.test(record.translationHash || "") ||
          typeof record.provenance !== "string" ||
          !record.provenance.trim() ||
          (record.status === "reviewed" &&
            (typeof record.reviewer !== "string" ||
              !record.reviewer.trim() ||
              record.reviewType !== "human" ||
              !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(
                record.reviewedAt || "",
              ) ||
              !Number.isFinite(Date.parse(record.reviewedAt)) ||
              Date.parse(record.reviewedAt) > Date.now()))
        )
          errors.push(`${locale}:${key}: invalid review metadata`);
      }
      const current =
        record?.sourceHash === hash(source[key]) &&
        record?.translationHash === hash(value);
      if (
        current &&
        (value !== source[key] || identicalApproved) &&
        record?.status === "reviewed" &&
        record.reviewType === "human" &&
        record.reviewer &&
        record.reviewedAt
      )
        reviewed++;
      else
        queue.push({
          locale,
          key,
          sourceHash: hash(source[key]),
          reason: !record ? "unverified" : !current ? "stale" : "draft",
          sensitive: sensitive(key),
        });
    }
    for (const key of Object.keys(source))
      if (!(key in messages)) {
        errors.push(`${locale}:${key}: missing translation`);
        queue.push({
          locale,
          key,
          sourceHash: hash(source[key]),
          reason: "missing",
          sensitive: sensitive(key),
        });
      }
    for (const key of Object.keys(metadata[locale] || {}))
      if (!(key in messages) || !(key in source))
        errors.push(`${locale}:${key}: orphan metadata`);
    counts[locale] = {
      total: Object.keys(source).length,
      present,
      nonIdentical,
      reviewed,
    };
  }
  for (const locale of Object.keys(metadata))
    if (!(locale in catalogs)) errors.push(`${locale}: orphan locale metadata`);
  for (const [id] of exceptions)
    if (!seen.has(id))
      errors.push(`${id}: obsolete English-identical baseline`);
  queue.sort(
    (a, b) =>
      a.locale.localeCompare(b.locale, "en") ||
      a.key.localeCompare(b.key, "en"),
  );
  return { errors, queue, counts };
}
export function availabilityErrors(
  result,
  baseline,
  registry = LOCALE_REGISTRY,
) {
  return registry
    .filter(
      ({ code, availability }) => code !== "en" && availability === "stable",
    )
    .flatMap(({ code }) => {
      const count = result.counts[code];
      return !count ||
        count.reviewed !== count.total ||
        baseline.some(
          (entry) => entry.locale === code && !approvedIdentical(entry),
        )
        ? [`${code}: stable locale lacks complete human review`]
        : [];
    });
}
export function load() {
  const source = flatten(read("src/lib/locales/en.json"));
  const catalogs = Object.fromEntries(
    LOCALE_REGISTRY.filter(
      ({ code, availability }) =>
        code !== "en" && (availability === "stable" || availability === "beta"),
    ).map(({ code: locale }) => [
      locale,
      flatten(read(`src/lib/locales/${locale}.json`)),
    ]),
  );
  return {
    source,
    catalogs,
    metadata: read("tests/catalog-review-metadata.json"),
    baseline: read("tests/catalog-identical-baseline.json"),
  };
}
export const PILOT_LOCALES = Object.freeze(["ar", "pl", "ja", "hi", "de"]);
export function exportPilot(data, locale) {
  if (!PILOT_LOCALES.includes(locale))
    throw new Error("Unsupported pilot locale");
  return Object.keys(data.source)
    .sort()
    .map((key) => ({
      locale,
      key,
      source: data.source[key],
      sourceHash: hash(data.source[key]),
      translation: null,
      reason: "missing",
      sensitive: sensitive(key),
    }));
}
/** Validate a partial pilot batch without registering or shipping a locale. */
export function importPilot(data, locale, rows) {
  if (!PILOT_LOCALES.includes(locale) || !Array.isArray(rows))
    throw new Error("Invalid pilot import");
  const source = {},
    messages = {},
    metadata = {};
  for (const row of rows) {
    if (row.locale !== locale || !(row.key in data.source) || row.key in source)
      throw new Error("Unknown or duplicate pilot key");
    if (row.sourceHash !== hash(data.source[row.key]))
      throw new Error(`${locale}:${row.key}: stale source`);
    if (typeof row.translation !== "string" || !row.translation.trim())
      throw new Error(`${locale}:${row.key}: empty translation`);
    source[row.key] = data.source[row.key];
    messages[row.key] = row.translation;
    metadata[row.key] = {
      ...row.metadata,
      sourceHash: row.sourceHash,
      translationHash: hash(row.translation),
    };
  }
  const result = examine(
    source,
    { [locale]: messages },
    { [locale]: metadata },
    [],
  );
  if (result.errors.length) throw new Error(result.errors.join("\n"));
  return { locale, messages, metadata };
}
export function exportWork(data) {
  const result = examine(
    data.source,
    data.catalogs,
    data.metadata,
    data.baseline,
  );
  return result.queue.map(({ locale, key, sourceHash, reason, sensitive }) => ({
    locale,
    key,
    source: data.source[key],
    sourceHash,
    translation: data.catalogs[locale][key] ?? null,
    reason,
    sensitive,
  }));
}
/** Apply a translator-supplied batch only when every record matches the current
 * source. Review claims are explicit input, never manufactured by this tool. */
export function importWork(data, rows) {
  const next = structuredClone(data);
  const seen = new Set();
  if (!Array.isArray(rows))
    throw new Error("Expected an array of import records");
  for (const row of rows) {
    const id = `${row.locale}:${row.key}`;
    if (seen.has(id)) throw new Error(`${id}: duplicate import`);
    seen.add(id);
    if (!next.catalogs[row.locale] || !(row.key in next.source))
      throw new Error(`${id}: unknown locale or key`);
    if (row.sourceHash !== hash(next.source[row.key]))
      throw new Error(`${id}: stale source`);
    if (typeof row.translation !== "string" || !row.translation.trim())
      throw new Error(`${id}: empty translation`);
    next.catalogs[row.locale][row.key] = row.translation;
    next.metadata[row.locale] ??= {};
    next.metadata[row.locale][row.key] = {
      ...row.metadata,
      sourceHash: row.sourceHash,
      translationHash: hash(row.translation),
    };
    next.baseline = next.baseline.filter(
      (entry) =>
        !(
          entry.locale === row.locale &&
          entry.key === row.key &&
          row.translation !== next.source[row.key]
        ),
    );
  }
  const result = examine(
    next.source,
    next.catalogs,
    next.metadata,
    next.baseline,
  );
  if (result.errors.length) throw new Error(result.errors.join("\n"));
  return next;
}
function writeImported(next) {
  for (const [locale, flat] of Object.entries(next.catalogs)) {
    const nested = read(`src/lib/locales/${locale}.json`);
    for (const [key, value] of Object.entries(flat)) {
      const path = key.split(".");
      let node = nested;
      for (const part of path.slice(0, -1)) node = node[part];
      node[path.at(-1)] = value;
    }
    writeFileSync(
      new URL(`src/lib/locales/${locale}.json`, root),
      JSON.stringify(nested, null, 2) + "\n",
    );
  }
  writeFileSync(
    new URL("tests/catalog-review-metadata.json", root),
    JSON.stringify(next.metadata, null, 2) + "\n",
  );
  writeFileSync(
    new URL("tests/catalog-identical-baseline.json", root),
    JSON.stringify(next.baseline, null, 2) + "\n",
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = load(),
    result = examine(data.source, data.catalogs, data.metadata, data.baseline);
  result.errors.push(...availabilityErrors(result, data.baseline));
  if (process.argv[2] === "pilot-import") {
    if (!process.argv[3] || !process.argv[4])
      throw new Error("Expected pilot locale and JSON file");
    process.stdout.write(
      JSON.stringify(
        importPilot(
          data,
          process.argv[3],
          JSON.parse(readFileSync(process.argv[4], "utf8")),
        ),
        null,
        2,
      ) + "\n",
    );
  } else if (process.argv[2] === "import") {
    if (!process.argv[3]) throw new Error("Expected a JSON import file");
    writeImported(
      importWork(data, JSON.parse(readFileSync(process.argv[3], "utf8"))),
    );
  } else if (process.argv[2] === "export")
    process.stdout.write(
      JSON.stringify(
        process.argv[3] ? exportPilot(data, process.argv[3]) : exportWork(data),
        null,
        2,
      ) + "\n",
    );
  else {
    console.log(
      JSON.stringify(
        {
          counts: result.counts,
          workQueue: result.queue.length,
          identicalBaseline: data.baseline.length,
        },
        null,
        2,
      ),
    );
    if (result.errors.length) {
      console.error(result.errors.join("\n"));
      process.exitCode = 1;
    }
  }
}
