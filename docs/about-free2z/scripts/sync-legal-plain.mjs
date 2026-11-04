// Copy the allow-listed docs/legal documents (src/legal-plain/allowlist.js)
// into legal-plain-generated/ for the `plain` docs instance
// (docusaurus.config.js). A second instance cannot read docs/legal in place:
// the main instance's MDX loader already claims that directory, and webpack
// would compile each file twice. Regenerated on every build and start, and
// gitignored, so it can never drift from the source.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const allowed = createRequire(import.meta.url)("../src/legal-plain/allowlist.js");
const source = join(root, "docs", "legal");
const target = join(root, "legal-plain-generated");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const name of allowed) {
  const from = join(source, name);
  if (!existsSync(from)) throw new Error(`allow-listed legal document missing: ${from}`);
  cpSync(from, join(target, name));
}
console.log(`sync-legal-plain: ${allowed.length} documents -> ${target}`);
