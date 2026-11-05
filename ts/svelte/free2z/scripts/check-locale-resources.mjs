import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LOCALE_REGISTRY } from "../src/lib/locale.js";
/** @param {readonly any[]} registry @param {readonly string[]} catalogs @param {readonly string[]} rtk */
export function validateResources(registry, catalogs, rtk) {
  const errors = [];
  const codes = new Set();
  for (const entry of registry) {
    if (codes.has(entry.code)) errors.push(`${entry.code}: duplicate locale`);
    codes.add(entry.code);
    if (typeof entry.loadCatalog !== "function")
      errors.push(`${entry.code}: missing catalog loader`);
    if (entry.availability === "stable" || entry.availability === "beta") {
      if (
        typeof entry.loadCatalog === "function" &&
        !entry.loadCatalog.toString().includes(`./locales/${entry.code}.json`)
      )
        errors.push(`${entry.code}: wrong catalog loader`);
      if (
        entry.code !== "en" &&
        typeof entry.loadRtk === "function" &&
        !entry.loadRtk.toString().includes(`./locales/rtk/${entry.code}.json`)
      )
        errors.push(`${entry.code}: wrong RTK loader`);
      if (!catalogs.includes(`${entry.code}.json`))
        errors.push(`${entry.code}: missing catalog`);
      if (
        entry.code !== "en" &&
        (typeof entry.loadRtk !== "function" ||
          !rtk.includes(`${entry.code}.json`))
      )
        errors.push(`${entry.code}: missing RTK loader or catalog`);
      if (entry.code !== "en" && !entry.fallback)
        errors.push(`${entry.code}: missing fallback policy`);
    }
  }
  for (const file of catalogs)
    if (!codes.has(file.replace(/\.json$/, "")))
      errors.push(`${file}: orphan catalog`);
  for (const file of rtk)
    if (
      !registry.some(
        (entry) =>
          entry.code === file.replace(/\.json$/, "") &&
          typeof entry.loadRtk === "function",
      )
    )
      errors.push(`${file}: orphan RTK catalog`);
  return errors;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const list = (path) =>
    readdirSync(new URL(path, import.meta.url)).filter((name) =>
      name.endsWith(".json"),
    );
  const errors = validateResources(
    LOCALE_REGISTRY,
    list("../src/lib/locales/"),
    list("../src/lib/locales/rtk/"),
  );
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Locale registry, loaders and catalog resources agree.");
}
