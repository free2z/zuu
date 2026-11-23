import { readFile, writeFile } from "node:fs/promises";
import { parse } from "yaml";
const source = new URL(
  "../../../../py/free2z/dj/free2z/openapi/f2z.yaml",
  import.meta.url,
);
const target = new URL("../schema.json", import.meta.url);
const expected =
  JSON.stringify(parse(await readFile(source, "utf8")), null, 2) + "\n";
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== expected)
    throw new Error("Bundled API schema differs: run npm run schema:update");
} else await writeFile(target, expected);
