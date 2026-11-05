import { readFileSync } from "node:fs";
import {
  load,
  flatten,
  hash,
  PILOT_LOCALES,
  sensitive,
} from "./catalog-governance.mjs";

const data = load();
const queue = [];
for (const locale of PILOT_LOCALES) {
  const read = (path) =>
    JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
  const messages = flatten(read(`src/lib/locales/pilot/${locale}.json`));
  const metadata = read(`tests/pilot/${locale}.metadata.json`);
  for (const key of Object.keys(data.source).sort()) {
    const record = metadata[key];
    const translation = messages[key] ?? null;
    const reason =
      !record || translation === null
        ? "missing"
        : record.sourceHash !== hash(data.source[key]) ||
            record.translationHash !== hash(translation)
          ? "stale"
          : "draft";
    queue.push({
      locale,
      key,
      sourceHash: hash(data.source[key]),
      reason,
      sensitive: sensitive(key),
    });
  }
}
process.stdout.write(JSON.stringify(queue, null, 2) + "\n");
