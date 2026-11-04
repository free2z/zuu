import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";

const safeName = (value, fallback) =>
  basename(value || fallback).replace(/[^a-zA-Z0-9._-]/g, "_") || fallback;

const isFirstAttemptDiagnostic = (result) =>
  result.retry === 0 && ["failed", "timedOut"].includes(result.status);

/**
 * Retain diagnostics before Playwright returns from its synchronous
 * `onTestEnd` dispatch. A later retry can remove the attempt output directory.
 */
export function retainFirstFailureArtifacts({ outputDir, test, result }) {
  if (!isFirstAttemptDiagnostic(result)) return [];
  if (!outputDir) throw new Error("Playwright did not provide an outputDir");

  const attachments = (result.attachments ?? []).filter(
    (attachment) => typeof attachment.path === "string" && attachment.path,
  );
  if (attachments.length === 0) return [];

  const identity = test.id || test.titlePath().join(" ");
  const id = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const destination = join(
    resolve(outputDir),
    "first-failures",
    `${id}-attempt-0`,
  );
  mkdirSync(destination, { recursive: true });

  const saved = [];
  for (const [index, attachment] of attachments.entries()) {
    const name = safeName(attachment.path, `attachment-${index}`);
    copyFileSync(attachment.path, join(destination, name));
    saved.push({ name, contentType: attachment.contentType ?? "" });
  }
  writeFileSync(
    join(destination, "manifest.json"),
    `${JSON.stringify(
      {
        test: test.titlePath(),
        status: result.status,
        retry: result.retry,
        attachments: saved,
      },
      null,
      2,
    )}\n`,
  );
  return saved.map(({ name }) => join(destination, name));
}

export function writeRetentionErrors({ outputDir, errors }) {
  const destination = join(resolve(outputDir), "first-failures");
  mkdirSync(destination, { recursive: true });
  const errorPath = join(destination, "retention-errors.json");
  writeFileSync(errorPath, `${JSON.stringify(errors, null, 2)}\n`);
  return errorPath;
}
