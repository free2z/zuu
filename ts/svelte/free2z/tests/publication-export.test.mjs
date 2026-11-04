import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(ROOT, "..", "src", "lib", "locales");
const SVELTE_PAGE = path.join(
  ROOT,
  "..",
  "src",
  "routes",
  "[username]",
  "dashboard",
  "pages",
  "+page.svelte",
);
const DIALOG_COMPONENT = path.join(
  ROOT,
  "..",
  "src",
  "lib",
  "components",
  "dashboard",
  "ExportPublicationDialog.svelte",
);

test("all four locales include full publication export translation keys and labels", () => {
  const locales = ["en", "es", "fr", "pt-BR"];
  for (const loc of locales) {
    const filePath = path.join(LOCALES_DIR, `${loc}.json`);
    assert.ok(fs.existsSync(filePath), `Missing locale file: ${loc}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

    assert.ok(data.dashboard, `Missing dashboard in ${loc}.json`);
    assert.ok(data.dashboard.pages, `Missing dashboard.pages in ${loc}.json`);

    const pages = data.dashboard.pages;
    assert.ok(pages.exportArticles, `Missing exportArticles in ${loc}.json`);
    assert.ok(pages.exportDialog, `Missing exportDialog in ${loc}.json`);
    assert.ok(
      pages.exportDialog.title,
      `Missing exportDialog.title in ${loc}.json`,
    );
    assert.ok(
      pages.exportDialog.description,
      `Missing exportDialog.description in ${loc}.json`,
    );
    assert.ok(
      pages.exportDialog.confirm,
      `Missing exportDialog.confirm in ${loc}.json`,
    );
    assert.ok(
      pages.exportDialog.cancel,
      `Missing exportDialog.cancel in ${loc}.json`,
    );

    const status = pages.exportStatus;
    assert.ok(status, `Missing exportStatus in ${loc}.json`);
    assert.ok(status.queued, `Missing exportStatus.queued in ${loc}.json`);
    assert.ok(status.running, `Missing exportStatus.running in ${loc}.json`);
    assert.ok(status.ready, `Missing exportStatus.ready in ${loc}.json`);
    assert.ok(status.download, `Missing exportStatus.download in ${loc}.json`);
    assert.ok(status.failed, `Missing exportStatus.failed in ${loc}.json`);
    assert.ok(status.expired, `Missing exportStatus.expired in ${loc}.json`);
    assert.ok(status.retry, `Missing exportStatus.retry in ${loc}.json`);
    assert.ok(
      status.newExport,
      `Missing exportStatus.newExport in ${loc}.json`,
    );
    assert.ok(
      status.createUpdated,
      `Missing exportStatus.createUpdated in ${loc}.json`,
    );
    assert.ok(
      status.expiresIn,
      `Missing exportStatus.expiresIn in ${loc}.json`,
    );
    assert.ok(
      status.warningsTitle,
      `Missing exportStatus.warningsTitle in ${loc}.json`,
    );
    assert.ok(status.loading, `Missing exportStatus.loading in ${loc}.json`);
    assert.ok(
      status.inProgressNotice,
      `Missing exportStatus.inProgressNotice in ${loc}.json`,
    );
    assert.ok(
      status.articlesLabel,
      `Missing exportStatus.articlesLabel in ${loc}.json`,
    );
    assert.ok(
      status.assetsLabel,
      `Missing exportStatus.assetsLabel in ${loc}.json`,
    );
    assert.ok(
      status.sizeLabel,
      `Missing exportStatus.sizeLabel in ${loc}.json`,
    );
    assert.ok(
      status.fileLabel,
      `Missing exportStatus.fileLabel in ${loc}.json`,
    );
  }
});

test("My Pages dashboard preserves existing actions and adds touch-visible Export articles button", () => {
  assert.ok(fs.existsSync(SVELTE_PAGE), "Missing +page.svelte");
  const content = fs.readFileSync(SVELTE_PAGE, "utf8");

  // Verify action group structure
  assert.match(
    content,
    /dashboard\.pages\.exportArticles/,
    "Missing Export articles action key in +page.svelte",
  );
  assert.match(
    content,
    /dashboard\.pages\.goLive/,
    "Go live button must be preserved in +page.svelte",
  );
  assert.match(
    content,
    /dashboard\.pages\.createNew/,
    "Create New Page button must be preserved in +page.svelte",
  );

  // Verify ExportPublicationDialog import and mount
  assert.match(
    content,
    /import\s+ExportPublicationDialog\s+from/,
    "ExportPublicationDialog must be imported in +page.svelte",
  );
  assert.match(
    content,
    /<ExportPublicationDialog\s+bind:open={exportDialogOpen}\s*\/>/,
    "ExportPublicationDialog must be mounted at bottom of +page.svelte",
  );
});

test("ExportPublicationDialog handles reactive i18n, polling, download trigger, and all job states", () => {
  assert.ok(
    fs.existsSync(DIALOG_COMPONENT),
    "Missing ExportPublicationDialog.svelte",
  );
  const content = fs.readFileSync(DIALOG_COMPONENT, "utf8");

  // Reactive store usage
  assert.match(
    content,
    /import\s+{\s*tStore\s+as\s+t\s*}\s+from\s+"\$lib\/i18n"/,
    "Must use reactive tStore as t",
  );

  // Dialog states
  assert.match(content, /queued/, "Must handle queued state");
  assert.match(content, /running/, "Must handle running state");
  assert.match(content, /ready/, "Must handle ready state");
  assert.match(content, /failed/, "Must handle failed state");
  assert.match(content, /expired/, "Must handle expired state");

  // Download trigger and metrics
  assert.match(
    content,
    /\/api\/exports\/publications\/\$\{job\.id\}\/download\//,
    "Must link to authorized download endpoint",
  );
  assert.match(content, /article_count/, "Must display article count");
  assert.match(content, /asset_count/, "Must display asset count");
  assert.match(content, /file_size/, "Must display formatted file size");
  assert.match(content, /warnings/, "Must display warning alerts if present");

  // Polling lifecycle: the retry/backoff/give-up policy lives in
  // $lib/publication-export-poll (unit-tested in publication-export-poll.test.mjs);
  // the dialog must use it rather than a bare setInterval that dies silently.
  assert.match(
    content,
    /createExportPoller/,
    "Must poll active jobs through the retrying poller",
  );
  assert.doesNotMatch(
    content,
    /setInterval/,
    "A bare setInterval poll stops on one failure and spins forever (#2051)",
  );
  assert.match(content, /onDestroy/, "Must clean up timers in onDestroy");
});

test("ExportPublicationDialog distinguishes 'no export yet' from 'failed to load' and shows a give-up state (#2051)", () => {
  const content = fs.readFileSync(DIALOG_COMPONENT, "utf8");
  assert.match(
    content,
    /classifyLatestJobError\(\s*err\s*\)/,
    "The latest-job lookup must classify its error, not swallow every failure as 'none'",
  );
  assert.match(content, /dashboard\.pages\.exportStatus\.loadFailed/);
  assert.match(content, /dashboard\.pages\.exportStatus\.pollFailed/);
  assert.match(content, /dashboard\.pages\.exportStatus\.checkAgain/);
  assert.match(
    content,
    /withDeadline\(\s*\(signal\)\s*=>\s*publicationExportsList\(/,
    "The first lookup must be bounded, or a stalled request leaves 'Loading…' forever",
  );
  assert.match(
    content,
    /onDestroy\(\(\)\s*=>\s*{[^}]*cancelLookup\(\)/,
    "Unmount must cancel an in-flight first lookup, or its reply starts an invisible poller",
  );
  assert.match(
    content,
    /!latestLoadFailed\s*&&/,
    "'Start export' must be hidden when we could not tell whether a job exists",
  );
  for (const loc of ["en", "es", "fr", "pt-BR"]) {
    const data = JSON.parse(
      fs.readFileSync(path.join(LOCALES_DIR, `${loc}.json`), "utf8"),
    );
    const status = data.dashboard.pages.exportStatus;
    for (const key of [
      "loadFailed",
      "pollFailed",
      "pollRetrying",
      "checkAgain",
    ]) {
      assert.ok(status[key], `Missing exportStatus.${key} in ${loc}.json`);
    }
  }
});
