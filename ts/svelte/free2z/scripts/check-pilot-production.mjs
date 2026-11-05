import { readFileSync } from "node:fs";
const manifest = JSON.parse(
  readFileSync(".svelte-kit/output/client/.vite/manifest.json", "utf8"),
);
const leaked = Object.keys(manifest).filter((key) =>
  key.startsWith("src/lib/locales/pilot/"),
);
if (leaked.length)
  throw new Error(
    `Pilot drafts included in production client manifest: ${leaked.join(", ")}`,
  );
const sentinels = JSON.parse(readFileSync("tests/pilot/drafts.json", "utf8"))[
  "settings.account.deleteAccountDescription"
];
for (const path of new Set(
  Object.values(manifest)
    .map((entry) => entry.file)
    .filter((path) => path?.endsWith(".js")),
)) {
  const contents = readFileSync(`.svelte-kit/output/client/${path}`, "utf8");
  if (sentinels.some((value) => contents.includes(value)))
    throw new Error(`Pilot draft embedded in production asset ${path}`);
}
console.log(
  "No test-only pilot catalog or draft sentinel in production client assets.",
);
