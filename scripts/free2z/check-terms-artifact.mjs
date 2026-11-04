import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const artifactPath = resolve("docsbuild/legal/index.html");

function assertTermsArtifact(path) {
  const html = readFileSync(path, "utf8");
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!title || !/terms of service agreement/i.test(title)) {
    throw new Error("generated Terms artifact has no Terms title");
  }
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (
    !main ||
    !/<article\b[^>]*>/i.test(main) ||
    !/<h1\b[^>]*>[\s\S]*?terms of service agreement[\s\S]*?<\/h1>/i.test(main)
  ) {
    throw new Error("generated Terms artifact has no legal article markup");
  }
  const canonicalTag = html
    .match(/<link\b[^>]*>/gi)
    ?.find((tag) => /\brel=["']canonical["']/i.test(tag));
  const canonical = canonicalTag?.match(/\bhref=["']([^"']+)/i)?.[1];
  if (!canonical || new URL(canonical, "https://example.test").pathname !== "/docs/legal/") {
    throw new Error("generated Terms artifact has no /docs/legal/ canonical route");
  }
}

assertTermsArtifact(artifactPath);

// Keep the guard meaningful: missing and incorrect output must fail
// the same checker rather than silently becoming a no-op.
const negativeRoot = mkdtempSync(join(tmpdir(), "free2z-docs-"));
try {
  let missingFailed = false;
  try {
    assertTermsArtifact(join(negativeRoot, "missing.html"));
  } catch {
    missingFailed = true;
  }
  if (!missingFailed) throw new Error("missing-artifact control passed");

  const incorrect = join(negativeRoot, "incorrect.html");
  writeFileSync(
    incorrect,
    '<title>Other page</title><main><article><h1>Other page</h1></article></main>',
  );
  let incorrectFailed = false;
  try {
    assertTermsArtifact(incorrect);
  } catch {
    incorrectFailed = true;
  }
  if (!incorrectFailed) throw new Error("incorrect-artifact control passed");
} finally {
  rmSync(negativeRoot, { recursive: true, force: true });
}
