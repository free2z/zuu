import { expect, test, type Page } from "@playwright/test";

const STORAGE_KEY = "zuuli.article-drafts.v1";
const STORAGE_PREFIX = "zuuli.article-drafts.v2.";

async function readVisibleDrafts(page: Page) {
  return page.evaluate(
    ({ rootKey, prefix }) => {
      const drafts = new Map<string, Record<string, unknown>>();
      const identity = (account: string, id: string) => `${account}\u0000${id}`;
      const rawRoot = localStorage.getItem(rootKey);
      if (rawRoot) {
        for (const draft of JSON.parse(rawRoot).drafts ?? []) {
          drafts.set(identity(draft.account, draft.id), draft);
        }
      }
      const heads = new Map<
        string,
        { claimId: string; deleted: boolean }
      >();
      const claims: Array<{
        claimId: string;
        account: string;
        draftId: string;
        draft: Record<string, unknown> | null;
      }> = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const record = JSON.parse(raw);
        if (record.kind === "head") heads.set(key, record);
        if (record.kind === "claim") claims.push(record);
      }
      for (const [key, head] of heads) {
        const encodedAndId = key.slice(`${prefix}head:`.length);
        const separator = encodedAndId.lastIndexOf(":");
        const account = decodeURIComponent(encodedAndId.slice(0, separator));
        const id = encodedAndId.slice(separator + 1);
        drafts.delete(identity(account, id));
        const backing = claims.find((claim) => claim.claimId === head.claimId);
        if (!head.deleted && backing?.draft) {
          drafts.set(identity(account, id), backing.draft);
        }
      }
      for (const claim of claims) {
        if (!claim.draft) continue;
        const source = heads.get(
          `${prefix}head:${encodeURIComponent(claim.account)}:${claim.draftId}`,
        );
        const rescue = heads.get(
          `${prefix}head:${encodeURIComponent(claim.account)}:${claim.claimId}`,
        );
        if (source?.claimId !== claim.claimId && !rescue) {
          drafts.set(identity(claim.account, claim.claimId), {
            ...claim.draft,
            id: claim.claimId,
            revision: 1,
          });
        }
      }
      return [...drafts.values()];
    },
    { rootKey: STORAGE_KEY, prefix: STORAGE_PREFIX },
  );
}

async function useSignedInSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
  });
}

async function openComposer(page: Page) {
  await useSignedInSession(page);
  await page.goto("/articles/new");
  await expect(page).toHaveURL(/\/articles\/new\?draft=[a-zA-Z0-9_-]+$/);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeVisible();
}

test("a pending local draft survives in-app navigation and reload", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await openComposer(page);
  const draftUrl = page.url();
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  const content = page.getByLabel("Content (Markdown)");

  await title.fill("Crash-safe local draft");
  await content.fill("First paragraph");
  await expect(page.getByRole("status")).toContainText("Saved locally");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);

  // Leave during the debounce window. The internal-link guard flushes the
  // latest keystroke synchronously before React unmounts the composer.
  await content.fill("First paragraph\n\nLast-second sentence");
  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto(draftUrl);
  await expect(page.getByText("Local draft restored")).toBeVisible();
  await expect(title).toHaveValue("Crash-safe local draft");
  await expect(content).toHaveValue("First paragraph\n\nLast-second sentence");

  await page.reload();
  await expect(page.getByText("Local draft restored")).toBeVisible();
  await expect(title).toHaveValue("Crash-safe local draft");
  await expect(content).toHaveValue("First paragraph\n\nLast-second sentence");

  // Hard reload during the debounce window exercises the close/reload flush.
  await page.getByRole("textbox", { name: "Subtitle" }).fill("Saved on close");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Subtitle" })).toHaveValue(
    "Saved on close",
  );
});

test("publishing clears only that draft and leaves another account-scoped id", async ({
  page,
}) => {
  await openComposer(page);
  const firstUrl = page.url();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Keep me");
  await page.getByLabel("Content (Markdown)").fill("This draft stays local.");
  await expect(page.getByRole("status")).toContainText("Saved locally");

  await page.getByRole("button", { name: "Start a new draft" }).click();
  await expect(page).not.toHaveURL(firstUrl);
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Publish me");
  await page.getByLabel("Content (Markdown)").fill("This draft becomes an article.");
  await expect(page.getByRole("status")).toContainText("Saved locally");

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page).toHaveURL(/\/articles\/(?!new(?:\?|$))[^/?]+$/);
  await expect(page.getByRole("heading", { name: "Publish me" })).toBeVisible();

  const remaining = await readVisibleDrafts(page);
  expect(remaining).toHaveLength(1);
  expect(remaining[0].title).toBe("Keep me");

  await page.goto(firstUrl);
  await expect(page.getByText("Local draft restored")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(
    "Keep me",
  );
});

test("discard explicitly removes the current local draft", async ({ page }) => {
  await openComposer(page);
  const draftId = new URL(page.url()).searchParams.get("draft");
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Discard me");
  await page.getByLabel("Content (Markdown)").fill("Temporary words.");
  await expect(page.getByRole("status")).toContainText("Saved locally");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Discard this draft" }).click();
  await expect(page).toHaveURL(/\/articles$/);

  const ids = (await readVisibleDrafts(page)).map((draft) => draft.id);
  expect(ids).not.toContain(draftId);
});

test("publishing locks the submitted snapshot against in-flight edits", async ({
  page,
}) => {
  await openComposer(page);
  const draftUrl = page.url();
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  const content = page.getByLabel("Content (Markdown)");
  await title.fill("Published snapshot");
  await content.fill("The exact body sent to publication.");
  await expect(page.getByRole("status")).toContainText("Saved locally");

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(title).toBeDisabled();
  await expect(content).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start a new draft" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Discard this draft" })).toBeDisabled();

  // Even a script bypassing the disabled attribute cannot mutate the snapshot
  // while the asynchronous publish request is in flight.
  await content.evaluate((element) => element.removeAttribute("disabled"));
  await content.fill("Edit injected while publishing and expected to be ignored");

  await expect(page).toHaveURL(/\/articles\/(?!new(?:\?|$))[^/?]+$/);
  await expect(page.getByRole("heading", { name: "Published snapshot" })).toBeVisible();
  await expect(page.getByText("The exact body sent to publication.")).toBeVisible();
  await expect(
    page.getByText("Edit injected while publishing and expected to be ignored"),
  ).toHaveCount(0);

  await page.goto(draftUrl);
  await expect(page.getByText("Local draft restored")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(
    "",
  );
});

test("publish success preserves a newer revision saved by another tab", async ({
  page,
  context,
}) => {
  await openComposer(page);
  const draftUrl = page.url();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Published revision");
  await page.getByLabel("Content (Markdown)").fill("Revision one.");
  await expect(page.getByRole("status")).toContainText("Saved locally");

  const newerTab = await context.newPage();
  await newerTab.goto(draftUrl);
  await expect(newerTab.getByText("Local draft restored")).toBeVisible();

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeDisabled();
  await newerTab
    .getByLabel("Content (Markdown)")
    .fill("Newer second-tab revision that must survive");
  // Navigating immediately forces the second tab's pending edit through the
  // same synchronous persistence boundary before the first tab's mock reply.
  await newerTab.getByRole("link", { name: "Home", exact: true }).first().click();
  await expect(newerTab).toHaveURL(/\/$/);

  await expect(page).toHaveURL(/\/articles\/(?!new(?:\?|$))[^/?]+$/);
  const stored = await readVisibleDrafts(page);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    revision: 2,
    content: "Newer second-tab revision that must survive",
  });

  await page.goto(draftUrl);
  await expect(page.getByText("Local draft restored")).toBeVisible();
  await expect(page.getByLabel("Content (Markdown)")).toHaveValue(
    "Newer second-tab revision that must survive",
  );
  await newerTab.close();
});

test("failed persistence blocks draft switching and browser back", async ({ page }) => {
  await page.addInitScript(({ storageKey, storagePrefix }) => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        drafts: [
          {
            id: "draft-first",
            account: "demo-creator",
            revision: 1,
            updatedAt: 10,
            title: "First stored draft",
            subtitle: "",
            category: "",
            tags: [],
            content: "First body",
          },
          {
            id: "draft-second",
            account: "demo-creator",
            revision: 1,
            updatedAt: 20,
            title: "Second stored draft",
            subtitle: "",
            category: "",
            tags: [],
            content: "Second body",
          },
        ],
      }),
    );
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === storageKey || key.startsWith(storagePrefix)) {
        throw new DOMException("Draft writes blocked", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  }, { storageKey: STORAGE_KEY, storagePrefix: STORAGE_PREFIX });
  await page.goto("/articles");
  await page.getByRole("link", { name: "Write a new article" }).click();
  await expect(page.getByText("Local draft restored")).toBeVisible();
  const draftUrl = page.url();
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  await title.fill("Unsaved edit retained in memory");
  await expect(page.getByRole("status")).toContainText("Autosave unavailable");

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Choose a local draft" }).click();
  await page.getByRole("menuitem").filter({ hasText: "First stored draft" }).click();
  await expect(page).toHaveURL(draftUrl);
  await expect(title).toHaveValue("Unsaved edit retained in memory");

  const backDialog = page.waitForEvent("dialog");
  await page.evaluate(() => window.history.back());
  const dialog = await backDialog;
  expect(dialog.message()).toContain("could not be saved locally");
  await dialog.dismiss();
  await expect(page).toHaveURL(draftUrl);
  await expect(title).toHaveValue("Unsaved edit retained in memory");
});

test("failed persistence requires confirmation before explicit sign out", async ({ page }) => {
  await openComposer(page);
  const draftUrl = page.url();
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  await title.fill("Stored revision");
  await page.getByLabel("Content (Markdown)").fill("Revision one is durable.");
  await expect(page.getByRole("status")).toContainText("Saved locally");

  await page.evaluate(({ storageKey, storagePrefix }) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === storageKey || key.startsWith(storagePrefix)) {
        throw new DOMException("Draft writes blocked", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  }, { storageKey: STORAGE_KEY, storagePrefix: STORAGE_PREFIX });
  await title.fill("Unsaved update before sign out");
  await expect(page.getByRole("status")).toContainText("Autosave unavailable");

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(draftUrl);
  await expect(title).toHaveValue("Unsaved update before sign out");
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("zuuli.knox.token"))).toBe(
    "mock-knox-token",
  );

  // Accepting the same explicit warning authorizes the otherwise lossy account
  // transition and preserves the older durable revision for later recovery.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByText("Log in to publish", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("zuuli.knox.token"))).toBeNull();
  const stored = await readVisibleDrafts(page);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ revision: 1, title: "Stored revision" });
});

test("corrupt current-version storage remains byte-for-byte untouched", async ({ page }) => {
  const malformed = '{"version":1,"drafts":[';
  await page.addInitScript(
    ({ key, raw }) => {
      localStorage.setItem("zuuli.knox.token", "mock-knox-token");
      localStorage.setItem(key, raw);
    },
    { key: STORAGE_KEY, raw: malformed },
  );
  await page.goto("/articles/new");
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Do not overwrite");
  await expect(page.getByRole("status")).toContainText("Autosave unavailable");
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe(
    malformed,
  );
  expect(
    await page.evaluate(
      (prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)),
      STORAGE_PREFIX,
    ),
  ).toEqual([]);
});
