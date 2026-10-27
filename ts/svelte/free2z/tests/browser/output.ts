import { randomUUID } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const OUTPUT_ID_ENV = "PLAYWRIGHT_OUTPUT_ID";
export const LOCAL_OUTPUT_PREFIX = "test-results-local-";
export const LOCAL_REPORT_PREFIX = "playwright-report-local-";

const OUTPUT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,95}$/;

export interface BrowserOutputPaths {
  outputDir: string;
  reportDir: string;
  source: "ci" | "local" | "inherited";
  identifier?: string;
}

function validateIdentifier(identifier: string): string {
  if (!OUTPUT_ID_PATTERN.test(identifier)) {
    throw new Error(
      `${OUTPUT_ID_ENV}=${JSON.stringify(identifier)} is not a valid ` +
        `Playwright output identifier. It must contain only lowercase letters, ` +
        `digits and hyphens, and be at most 96 characters.`,
    );
  }
  return identifier;
}

export function localBrowserOutputPaths(
  identifier: string,
): BrowserOutputPaths {
  const validIdentifier = validateIdentifier(identifier);
  return {
    outputDir: `./${LOCAL_OUTPUT_PREFIX}${validIdentifier}`,
    reportDir: `./${LOCAL_REPORT_PREFIX}${validIdentifier}`,
    source: "local",
    identifier: validIdentifier,
  };
}

/**
 * Resolve the two Playwright artifact directories once per invocation.
 *
 * The runner loads this config before it starts workers, and workers load it
 * again. Publishing the generated identifier into the environment makes those
 * reloads adopt the same directories instead of creating a second pair. A
 * separate Playwright invocation gets a separate Node process and therefore a
 * separate UUID, even when both invocations run in one worktree.
 */
export function resolveBrowserOutputPaths(
  env: NodeJS.ProcessEnv = process.env,
  options: { identifier?: string } = {},
): BrowserOutputPaths {
  if (env.CI) {
    return {
      outputDir: "./test-results",
      reportDir: "./playwright-report",
      source: "ci",
    };
  }

  const inheritedIdentifier = env[OUTPUT_ID_ENV];
  if (inheritedIdentifier !== undefined) {
    const paths = localBrowserOutputPaths(inheritedIdentifier);
    return { ...paths, source: "inherited" };
  }

  const identifier = validateIdentifier(
    options.identifier ?? `pid-${process.pid}-${randomUUID()}`,
  );
  env[OUTPUT_ID_ENV] = identifier;
  return localBrowserOutputPaths(identifier);
}

/**
 * Remove only this successful local invocation's Playwright result directory.
 * Failed runs keep their traces for diagnosis, and CI artifacts remain at the
 * fixed paths uploaded by the workflow.
 */
export async function cleanupSuccessfulLocalOutput(options: {
  status: string;
  env?: NodeJS.ProcessEnv;
  configuredOutputDir: string;
  cwd?: string;
}): Promise<boolean> {
  const env = options.env ?? process.env;
  const identifier = env[OUTPUT_ID_ENV];
  if (options.status !== "passed" || env.CI || identifier === undefined) {
    return false;
  }

  const expectedDir = localBrowserOutputPaths(identifier).outputDir;
  const root = resolve(options.cwd ?? process.cwd());
  const target = resolve(root, expectedDir);
  if (
    dirname(target) !== root ||
    resolve(options.configuredOutputDir) !== target
  ) {
    return false;
  }

  try {
    const details = await lstat(target);
    if (!details.isDirectory() || details.isSymbolicLink()) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  await rm(target, { recursive: true });
  return true;
}

/**
 * The reporter's entry point. Playwright resolves `outputDir` against the
 * CONFIG file's directory, not the shell's cwd, so the expected path must be
 * resolved the same way: run from the repo root with
 * `-c ts/svelte/free2z/playwright.config.ts`, a cwd-relative guard never
 * matches and every successful run's output is silently kept (codex review of
 * ).
 */
export async function cleanupAfterLocalRun(options: {
  status: string;
  configFile: string | undefined;
  configuredOutputDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  return cleanupSuccessfulLocalOutput({
    status: options.status,
    env: options.env,
    configuredOutputDir: options.configuredOutputDir,
    cwd: options.configFile ? dirname(options.configFile) : undefined,
  });
}
