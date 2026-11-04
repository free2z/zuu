import { expect, test, type Locator, type Page } from "@playwright/test";
import { browserAppOrigin } from "./ports";

/**
 * The Converse composer's writing tools, in a real browser at the
 * suite's default PHONE viewport (390x844) — the + button and image upload
 * have to work with a thumb.
 *
 * The tools are the zPage editor's own parts (`markdownTextarea.svelte.ts`,
 * `inlineUploads.ts`), put together for a short public post. The pure logic
 * is unit-tested in `tests/inline-uploads.test.mjs` and
 * `tests/textarea-commands.test.mjs`; what only a browser can prove is the
 * wiring: that the menu opens and inserts into THIS textarea, that a picked
 * file becomes markdown, that the Post button and Cmd/Ctrl+Enter both refuse
 * while a placeholder token is in the body, and that the request that finally
 * goes out carries the image and never the token.
 *
 * NEGATIVE CONTROLS: see the PR for  — each assertion group below was
 * run against a deliberately broken build and went red.
 */

const TEST_CREATOR = {
  id: 1863,
  username: "converse-tools-user",
  full_name: "Converse Tools User",
};

const UPLOADED_URL = "/uploadz/public/converse-tools-user/photo.png";

/** A 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const MEMBERS_IMAGE = {
  id: 7101,
  title: "Backstage",
  name: "backstage.png",
  mime_type: "image/png",
  access: "members",
  url: "/uploadz/backstage.png",
  thumbnail: "/uploadz/backstage.webp",
};

const PUBLIC_IMAGE = {
  id: 7102,
  title: "Open sky",
  name: "open-sky.png",
  mime_type: "image/png",
  access: "public",
  url: "/uploadz/public/open-sky.png",
  thumbnail: "/uploadz/public/open-sky.webp",
};

type CreatedPost = { content: string; tuzis: unknown; parent: unknown };

/** A feed card, attached to whatever `content_url` says its thread root is. */
function seedPost(
  uuid: string,
  content: string,
  contentUrl: string | null | undefined,
  threadAccess = contentUrl === null ? "public" : "private",
  threadAccessOwnerId: number | null = null,
) {
  return {
    uuid,
    parent: null,
    headline: "",
    content,
    tuzis: 1,
    num_children: "0",
    tags: [],
    content_url: contentUrl,
    thread_access: threadAccess,
    thread_access_owner_id: threadAccessOwnerId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    author: { username: "someone-else", avatar_image: null },
  };
}

async function installMocks(page: Page, seed: unknown[] = []) {
  const created: CreatedPost[] = [];
  const feed: unknown[] = [...seed];
  const uploads: string[] = [];

  await page.addInitScript((creator) => {
    localStorage.setItem(
      "auth",
      JSON.stringify({ isAuthenticated: true, creator, loading: false }),
    );
  }, TEST_CREATOR);

  // ORDER MATTERS: Playwright tries the most recently registered matching
  // handler first, so the catch-all goes down FIRST.
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    // `**/api/**` also matches the dev server's own module URLs.
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (pathname === "/api/auth/user/") return json(TEST_CREATOR);

    if (pathname === "/api/uploads/limits/") {
      return json({
        tuzis: 0,
        max_bytes: 5 * 1024 * 1024,
        tiers: [{ min_tuzis: 0, max_bytes: 5 * 1024 * 1024 }],
      });
    }

    if (pathname === "/api/myuploads/") {
      return json({ count: 1, next: null, results: [MEMBERS_IMAGE] });
    }
    if (pathname === `/api/myuploads/${MEMBERS_IMAGE.id}/`) {
      return json(MEMBERS_IMAGE);
    }

    if (pathname === "/api/comments/" && request.method() === "POST") {
      const body = JSON.parse(request.postData() || "{}") as CreatedPost;
      created.push(body);
      const post = {
        uuid: `created-${created.length}`,
        parent: null,
        headline: "",
        content: body.content,
        tuzis: body.tuzis,
        num_children: "0",
        tags: [],
        content_url: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        author: { username: TEST_CREATOR.username, avatar_image: null },
      };
      feed.unshift(post);
      return json(post, 201);
    }
    if (pathname === "/api/comments/") {
      return json({ count: feed.length, next: null, results: feed });
    }
    if (pathname.startsWith("/api/comments/") && request.method() === "GET") {
      const uuid = pathname.split("/").filter(Boolean).at(-1);
      const comment = feed.find(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "uuid" in entry &&
          entry.uuid === uuid,
      );
      return json(comment ?? { thread_access: "private" });
    }

    return json({ count: 0, next: null, results: [] });
  });

  // Held until the test releases it, so "upload in flight" is a state the
  // test can sit in for as long as it likes.
  let releaseUpload = () => {};
  const uploadReleased = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  await page.route("**/uploads/single-public", async (route) => {
    uploads.push(route.request().method());
    await uploadReleased;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ id: 99, url: UPLOADED_URL }),
    });
  });

  return { created, uploads, releaseUpload: () => releaseUpload() };
}

/**
 * Warm the dev server once, in its own context, before the first test.
 *
 * On a cold server the first `/converse` load compiles the whole Svelte module
 * graph, and opening the image picker then makes Vite re-optimize its
 * dependencies and force a reload. Together that can exceed a 30s test budget
 * before the first assertion runs (it did, in review round 1). Same pattern
 * as notification-socket-offline.spec.ts: pay that cost here, under its own
 * explicit budget, so every test starts against the app a warm suite sees.
 */
test.use({ viewport: { width: 1280, height: 900 } });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = await context.newPage();
    await installMocks(page);
    const appOrigin = browserAppOrigin();
    const body = page.locator("#converse-content");
    await page.goto(`${appOrigin}/converse`);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await expect(body).toBeVisible({ timeout: 20_000 });
        break;
      } catch {
        await page.reload();
      }
    }
    // Pull in the picker's module graph too — that is what triggers the
    // re-optimisation reload.
    await page.getByTestId("converse-image-trigger").click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 20_000 });
  } finally {
    await context.close();
  }
});

/**
 * `/converse`, with a reload allowance: the first spec to open the image
 * picker makes the dev server re-optimize its dependency graph, and the next
 * navigation can come back with an empty body (see
 * editor-media-access-gate.spec.ts, which measured it).
 */
/**
 * Wait for a programmatic insert to finish placing the caret.
 *
 * Every insert (menu command, list continuation) writes the text at once and
 * moves the caret in a deferred `setTimeout`. The next Playwright action can
 * land before that callback, and the late caret move then collapses a
 * selection the test just made, or points a typed "/query" at the wrong
 * offset. Both happened intermittently under `--repeat-each` (round 1).
 */
async function caretSettled(body: Locator, start: number, end = start) {
  await expect
    .poll(() =>
      body.evaluate((el: HTMLTextAreaElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    )
    .toEqual([start, end]);
  //...and past the 0ms callback that put it there.
  await body.page().waitForTimeout(80);
}

async function gotoConverse(page: Page) {
  const body = page.locator("#converse-content");
  await page.goto("/converse");
  if ((page.viewportSize()?.width ?? 0) < 640) {
    await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
    await page.getByRole("button", { name: "New conversation" }).click();
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await expect(body).toBeVisible({ timeout: 10_000 });
      return body;
    } catch {
      await page.reload();
    }
  }

  await expect(body).toBeVisible();
  return body;
}

test("slash menu, + palette and list continuation insert into the post", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page);
  const body = await gotoConverse(page);

  // The + control is on screen at phone width and big enough to hit.
  const plus = page.getByTestId("converse-insert-trigger");
  await expect(plus).toBeVisible();
  const box = await plus.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.width).toBeGreaterThanOrEqual(32);

  await plus.click();
  const menu = page.getByRole("listbox", { name: "Insert content" });
  await expect(menu).toBeVisible();
  await expect(plus).toHaveAttribute("aria-expanded", "true");
  // The short-post subset: image first, and no long-form structure.
  await expect(menu.getByRole("option").first()).toContainText("Image");
  await expect(menu.getByRole("option", { name: /Heading/ })).toHaveCount(0);
  await expect(menu.getByRole("option", { name: /Table/ })).toHaveCount(0);

  await menu.getByRole("option", { name: /^Quote/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(body).toHaveValue("> ");
  await caretSettled(body, 2);

  // The typed "/" menu replaces its query.
  await body.fill("");
  await body.pressSequentially("/bol");
  const typedMenu = page.getByRole("listbox", { name: "Commands" });
  await expect(typedMenu).toBeVisible();
  await expect(typedMenu.getByRole("option")).toHaveCount(1);
  await body.press("Enter");
  await expect(body).toHaveValue("**bold text**");
  await caretSettled(body, 2, 11);

  // List continuation on Enter.
  await body.fill("");
  await body.pressSequentially("- one");
  await body.press("Enter");
  await expect(body).toHaveValue("- one\n- ");
  await caretSettled(body, 8);

  // A selection raises the formatting toolbar, entirely on screen at phone
  // width (it used to be clamped with a half-width 18px short of the real
  // one, so its first button was cut off), and it formats the selection.
  await body.fill("make me bold");
  await body.selectText();
  const bold = page.getByRole("button", { name: "Bold", exact: true });
  await expect(bold).toBeVisible();
  const bar = await bold.locator("xpath=..").boundingBox();
  expect(bar).not.toBeNull();
  expect(bar!.x).toBeGreaterThanOrEqual(0);
  expect(bar!.x + bar!.width).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 390, height: 400 });
  await expect
    .poll(async () => (await bold.locator("xpath=..").boundingBox())!.y)
    .toBeLessThan(bar!.y);
  await expect
    .poll(async () => {
      const box = await bold.locator("xpath=..").boundingBox();
      return box!.y + box!.height - (await body.boundingBox())!.y;
    })
    .toBeLessThanOrEqual(1);
  const resizedBar = await bold.locator("xpath=..").boundingBox();
  expect(resizedBar!.y).toBeGreaterThanOrEqual(8);
  expect(resizedBar!.y + resizedBar!.height).toBeLessThanOrEqual(392);
  await expect(body).toHaveValue("make me bold");
  // No Heading action in a short post: it replaced the whole selection with
  // "# " (codex review).
  await expect(
    page.getByRole("button", { name: "Heading", exact: true }),
  ).toHaveCount(0);
  await bold.click();
  await expect(body).toHaveValue("**make me bold**");
  await page.setViewportSize({ width: 390, height: 844 });

  // Enter that confirms an IME candidate belongs to the IME, even inside a
  // list: not a list continuation, not a menu choice.
  await body.fill("- 日本");
  const handled = await body.evaluate((el) => {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(handled).toBe(false);
  await page.waitForTimeout(100);
  await expect(body).toHaveValue("- 日本");
});

test("writing menus stay reachable above a mobile keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.defineProperties(viewport, {
      height: { get: () => (window as any).__keyboardHeight ?? innerHeight },
      offsetTop: { get: () => (window as any).__keyboardOffset ?? 0 },
    });
    Object.defineProperty(window, "visualViewport", { get: () => viewport });
    (window as any).__keyboardViewport = viewport;
  });
  await installMocks(page);
  const body = await gotoConverse(page);
  await body.fill("Keep this draft ");
  await body.press("End");
  await page.getByTestId("converse-insert-trigger").click();
  const palette = page.getByRole("listbox", { name: "Insert content" });
  await expect(palette).toBeVisible();
  const originalHeight = (await palette.boundingBox())!.height;
  expect(originalHeight).toBeGreaterThan(300);

  await page.evaluate(() => {
    (window as any).__keyboardHeight = 400;
    (window as any).__keyboardViewport.dispatchEvent(new Event("resize"));
  });
  expect(await page.evaluate(() => innerHeight)).toBe(700);

  async function expectInsideViewport(
    menu: Locator,
    top: number,
    bottom: number,
  ) {
    await expect
      .poll(async () => (await menu.boundingBox())!.y)
      .toBeGreaterThanOrEqual(top + 8);
    await expect
      .poll(async () => {
        const box = await menu.boundingBox();
        return box!.y + box!.height;
      })
      .toBeLessThanOrEqual(bottom - 8);
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(312);
  }

  await expectInsideViewport(palette, 0, 400);
  expect((await palette.boundingBox())!.height).toBeLessThan(originalHeight);
  const commands = palette.locator(".slash-menu-items");
  expect(
    await commands.evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
  const lastCommand = palette.getByRole("option", { name: /^Inline math/ });
  await lastCommand.scrollIntoViewIfNeeded();
  expect(await commands.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await lastCommand.click();
  await expect(body).toHaveValue("Keep this draft $$x^2$$");
  await expect(palette).toHaveCount(0);

  await page.route(
    (url) => url.pathname === "/api/creator/",
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          results: Array.from({ length: 12 }, (_, i) => ({
            id: i + 1,
            username: `alice${i}`,
            full_name: `Alice ${i}`,
          })),
        }),
      }),
  );
  await body.fill("Keep this draft ");
  await body.press("End");
  await body.pressSequentially("@ali", { delay: 80 });
  const results = page.locator(".mention-menu-items");
  const mentions = results.locator("xpath=..");
  const lastMention = results.getByRole("button", { name: /@alice11/ });
  await expect(lastMention).toBeAttached();
  await expectInsideViewport(mentions, 0, 400);
  await page.evaluate(() => {
    (window as any).__keyboardOffset = 30;
    (window as any).__keyboardViewport.dispatchEvent(new Event("scroll"));
  });
  await expectInsideViewport(mentions, 30, 430);
  expect(
    await results.evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
  await lastMention.scrollIntoViewIfNeeded();
  expect(await results.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await lastMention.click();
  await expect(body).toHaveValue(/Keep this draft .*alice11/);
  await expect(results).toHaveCount(0);
  await expect(body).toBeFocused();
});

test("preview immediately retires writing tools and retains the draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page);
  const body = await gotoConverse(page);

  async function previewAndEdit(draft: string) {
    // Inspect the first rendered preview state: a delayed blur must not leave
    // writing commands active over a textarea that has already disappeared.
    const state = await page
      .getByRole("button", { name: "Preview", exact: true })
      .evaluate(async (button) => {
        (button as HTMLButtonElement).click();
        await Promise.resolve();
        return {
          textarea: document.querySelectorAll("#converse-content").length,
          menus: document.querySelectorAll('[role="listbox"]').length,
          mentions: document.querySelectorAll(".mention-menu-items").length,
          formatting: document.querySelectorAll('button[aria-label="Bold"]')
            .length,
        };
      });
    expect(state).toEqual({
      textarea: 0,
      menus: 0,
      mentions: 0,
      formatting: 0,
    });
    const edit = page.getByRole("button", { name: "Edit", exact: true });
    await expect(edit).toHaveAttribute("aria-pressed", "true");
    await expect(edit).toBeFocused();
    await edit.click();
    await expect(body).toHaveValue(draft);
    await expect(page.getByRole("listbox")).toHaveCount(0);
  }

  await body.fill("read this draft");
  await page.getByTestId("converse-insert-trigger").click();
  await expect(
    page.getByRole("listbox", { name: "Insert content" }),
  ).toBeVisible();
  await previewAndEdit("read this draft");

  await body.fill("/bol");
  await expect(page.getByRole("listbox", { name: "Commands" })).toBeVisible();
  await previewAndEdit("/bol");

  await body.fill("selected text");
  await body.selectText();
  await expect(
    page.getByRole("button", { name: "Bold", exact: true }),
  ).toBeVisible();
  // Returning to Edit before the old blur settles must preserve the new
  // selection toolbar beyond the controller’s 200ms dismissal delay.
  await page.waitForTimeout(250);
  await expect(
    page.getByRole("button", { name: "Bold", exact: true }),
  ).toBeVisible();
  await previewAndEdit("selected text");

  let searchStarted = false;
  let releaseSearch!: () => void;
  const searchReleased = new Promise<void>(
    (resolve) => (releaseSearch = resolve),
  );
  await page.route(
    (url) => url.pathname === "/api/creator/",
    async (route) => {
      searchStarted = true;
      await searchReleased;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ results: [{ id: 1, username: "alice" }] }),
      });
    },
  );
  await body.fill("");
  await body.pressSequentially("@ali", { delay: 80 });
  await expect.poll(() => searchStarted).toBe(true);
  await expect(page.locator(".mention-menu-items")).toBeVisible();
  const response = page.waitForResponse(
    (res) => new URL(res.url()).pathname === "/api/creator/",
  );
  await previewAndEdit("@ali");
  releaseSearch();
  await response;
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.locator(".mention-menu-items")).toHaveCount(0);
  await expect(body).toHaveValue("@ali");
});

test("an uploaded image lands as markdown, and nothing posts until it has", async ({
  page,
}) => {
  const { created, uploads, releaseUpload } = await installMocks(page);
  const body = await gotoConverse(page);
  const post = page.getByRole("button", { name: "Post", exact: true });

  await body.fill("look at this ");

  // The image button opens the same picker the zPage editor uses.
  await page.getByTestId("converse-image-trigger").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await dialog.getByRole("button", { name: "Insert Selected" }).click();
  await expect(dialog).toHaveCount(0);

  // In flight: the placeholder is in, the upload has been sent, and the
  // composer says so.
  await expect(body).toHaveValue(
    /^look at this !\[Uploading image…\]\(upload-[a-z0-9-]+\)$/,
  );
  await expect.poll(() => uploads.length, { timeout: 10_000 }).toBe(1);
  await expect(page.getByTestId("converse-upload-status")).toBeVisible();

  // Blocked, both ways in.
  await expect(post).toBeDisabled();
  await body.press("ControlOrMeta+Enter");
  await expect(
    page
      .getByTestId("payment-outcome-error")
      .getByText("Wait for your files to finish uploading."),
  ).toBeVisible();
  expect(created).toHaveLength(0);

  releaseUpload();

  await expect(body).toHaveValue(`look at this ![photo](${UPLOADED_URL})`);
  await expect(page.getByTestId("converse-upload-status")).toHaveCount(0);
  await expect(post).toBeEnabled();

  await post.click();
  await expect.poll(() => created.length, { timeout: 10_000 }).toBe(1);
  expect(created[0].content).toBe(`look at this ![photo](${UPLOADED_URL})`);
  expect(created[0].content).not.toContain("upload-");
  await expect(body).toHaveValue("");

  // The reply composer on the new post is the same component, tools and all,
  // with its own menu id.
  const card = page.locator('[data-testid="converse-feed"] > article').first();
  await expect(card).toContainText("look at this");
  await card.getByRole("button", { name: "Reply" }).click();
  const reply = page.getByTestId("converse-reply-composer");
  await expect(reply).toBeVisible();
  const replyPlus = reply.getByTestId("converse-insert-trigger");
  await expect(replyPlus).toBeVisible();
  await replyPlus.click();
  const replyMenuId = await replyPlus.getAttribute("aria-controls");
  expect(replyMenuId).toMatch(/^converse-command-menu-/);
  expect(replyMenuId).not.toBe(
    await page
      .getByTestId("converse-insert-trigger")
      .first()
      .getAttribute("aria-controls"),
  );
  await expect(page.locator(`[id="${replyMenuId}"]`)).toBeVisible();
});

test("deleting an in-flight upload's placeholder unblocks the post at once", async ({
  page,
}) => {
  const { created, uploads } = await installMocks(page);
  const body = await gotoConverse(page);
  const post = page.getByRole("button", { name: "Post", exact: true });

  await body.fill("text only ");
  await page.getByTestId("converse-image-trigger").click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await dialog.getByRole("button", { name: "Insert Selected" }).click();
  await expect.poll(() => uploads.length, { timeout: 10_000 }).toBe(1);
  await expect(post).toBeDisabled();

  // The upload request is never released: the writer changes their mind.
  await body.fill("text only");
  await expect(post).toBeEnabled();
  await post.click();
  await expect.poll(() => created.length, { timeout: 10_000 }).toBe(1);
  expect(created[0].content).toBe("text only");
});

test("the action row fits a 320px phone with the counter showing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await installMocks(page);
  const body = await gotoConverse(page);

  await body.fill("x".repeat(850));
  await expect(page.getByTestId("converse-character-counter")).toBeVisible();
  for (const control of [
    page.getByLabel("Back with"),
    page.getByTestId("converse-insert-trigger"),
    page.getByTestId("converse-image-trigger"),
    page.getByTestId("converse-video-trigger"),
    page.getByRole("button", { name: "Preview" }),
    page.getByRole("button", { name: "Post", exact: true }),
  ]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(box!.y + box!.height).toBeLessThanOrEqual(700);
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const toolsBox = await page
    .getByTestId("converse-insert-trigger")
    .boundingBox();
  const postBox = await page
    .getByRole("button", { name: "Post", exact: true })
    .boundingBox();
  const amountBox = await page.getByLabel("Back with").boundingBox();
  // Media tools occupy their own row; the charge stays beside Post.
  expect(postBox!.y).toBeGreaterThanOrEqual(toolsBox!.y + toolsBox!.height);
  expect(Math.abs(postBox!.y - amountBox!.y)).toBeLessThanOrEqual(1);
});

test("a members-only image is gated to PUBLIC, never inserted as is", async ({
  page,
}) => {
  const { created } = await installMocks(page);
  const body = await gotoConverse(page);

  await page.getByTestId("converse-image-trigger").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The rule the picker is actually enforcing. Asserted directly because a
  // body-slot picker on a non-subscriber page ALSO demands public, so the
  // gate below would pass with the `post` wiring removed (review round 1).
  await expect(dialog).toHaveAttribute("data-media-access-slot", "post");
  await expect(dialog).toHaveAttribute("data-subscriber-only", "false");
  await dialog.getByRole("tab", { name: "Your Cloud" }).click();
  await dialog.getByRole("button", { name: /Backstage/ }).click();

  // On a subscribers-only zPage a members image is fine. A post has no
  // subscriber tier: the gate asks for PUBLIC, and nothing is inserted.
  const gate = dialog.locator('[data-media-access-gate="public"]');
  await expect(gate).toBeVisible();
  await expect(body).toHaveValue("");

  await gate.locator('[data-media-access-gate-action="cancel"]').click();
  await expect(gate).toHaveCount(0);
  await expect(body).toHaveValue("");
  expect(created).toHaveLength(0);
});

const ZPAGE_THREAD_URL = "/paywalled-creator/members-only-page";
const ZPAGE_PUBLIC_THREAD_URL = "/public-creator/public-page";
const ZPAGE_DRAFT_THREAD_URL = "/draft-creator/draft-page";
const AI_THREAD_URL = "/ai/conversation/42";

/** Paste one PNG into the focused composer the way a clipboard would. */
async function pasteImage(page: Page, selector: string) {
  await page.evaluate(
    async ({ data, selector }) => {
      const textarea = document.querySelector(selector) as HTMLTextAreaElement;
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "shot.png", { type: "image/png" }));
      textarea.focus();
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        }),
      );
    },
    { data: PNG.toString("base64"), selector },
  );
}

/**
 * The image picker is READY when its tab list is in the accessibility tree —
 * not when the dialog element carries `data-media-access-slot`.
 *
 * That attribute is on `Dialog.Content`; the tabs are its children, and a
 * dialog that is opening or closing can own the element while its contents are
 * not (yet, or no longer) in the accessibility tree. Asserting a tab's
 * `data-state` straight after the dialog attribute therefore used `dialog` as a
 * PROXY for "the picker is mounted", which it is not — and a contended CI
 * runner lost that race twice, in two different places: at the tab
 * (`getByRole('tab', { name: 'Your Cloud' })`, `element(s) not found`, run
 * 35382435125) and then a step EARLIER at the dialog itself (run 35405999210).
 *
 * So: wait on the tab list, scope every lookup to the dialog so a lingering
 * previous picker cannot answer for this one, and let the readiness failure
 * name the picker instead of the attribute that happens to land first. The
 * global `expect` timeout is deliberately untouched — raising it would hide the
 * same class of race everywhere else ('s lesson).
 */
async function expectPickerOpen(
  page: Page,
  expected: {
    slot: string;
    subscriberOnly?: boolean;
    cloudTab?: "active" | "inactive";
    deviceTab?: boolean;
  },
) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-media-access-slot", expected.slot);
  if (expected.subscriberOnly !== undefined) {
    await expect(dialog).toHaveAttribute(
      "data-subscriber-only",
      expected.subscriberOnly ? "true" : "false",
    );
  }
  // The readiness signal itself: the picker's tab list, and both of its tabs
  // under the accessible names the assertions use.
  await expect(dialog.getByRole("tablist")).toBeVisible();
  if (expected.deviceTab === false) {
    await expect(dialog.getByRole("tab", { name: "Device" })).toHaveCount(0);
  } else {
    await expect(dialog.getByRole("tab", { name: "Device" })).toBeVisible();
  }
  const cloudTab = dialog.getByRole("tab", { name: "Your Cloud" });
  await expect(cloudTab).toBeVisible();
  if (expected.cloudTab) {
    await expect(cloudTab).toHaveAttribute("data-state", expected.cloudTab);
  }
  return dialog;
}

/**
 * Close the picker and WAIT for it to be gone, before touching the composer
 * again.
 *
 * `Escape` is asynchronous: the content unmounts and focus is restored to the
 * trigger on a later task. This spec used to press Escape and immediately type
 * the next slash command into the textarea, so the reopen raced the close — and
 * when the close won, focus had already left the textarea, the `/image` + Enter
 * went to the restored trigger instead, and NO dialog ever opened for the next
 * assertion to find. That is the second CI failure above, and it is why the fix
 * is a wait and not a longer timeout.
 */
async function closePicker(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test("a reply takes its images rule from the thread root", async ({ page }) => {
  // A reply inherits its parent's attachment, and is exactly as visible as
  // it. Only a standalone thread (`content_url: null`) is public; a zPage
  // thread may be subscriber-only or a draft, an AI thread may be private,
  // and the API now reports the tier explicitly, so the composer can choose
  // the matching body policy without guessing.
  const { created, uploads } = await installMocks(page, [
    seedPost("root-standalone", "standalone root", null),
    seedPost(
      "root-zpage-public",
      "public zpage thread comment",
      ZPAGE_PUBLIC_THREAD_URL,
      "public",
    ),
    seedPost(
      "root-zpage-members",
      "members zpage thread comment",
      ZPAGE_THREAD_URL,
      "members",
      TEST_CREATOR.id,
    ),
    seedPost(
      "root-zpage-draft",
      "draft zpage thread comment",
      ZPAGE_DRAFT_THREAD_URL,
      "private",
    ),
    seedPost("root-ai", "ai thread comment", AI_THREAD_URL),
    seedPost(
      "root-missing-url",
      "missing attachment metadata",
      undefined,
      "public",
    ),
    seedPost("root-empty-url", "empty attachment metadata", "", "public"),
    seedPost(
      "root-other-owner",
      "members page owned by someone else",
      ZPAGE_THREAD_URL,
      "members",
      987654,
    ),
  ]);
  await gotoConverse(page);

  const card = (text: string) =>
    page.locator('[data-testid="converse-feed"] > article', { hasText: text });

  // Standalone: the full toolset, and a picker enforcing `post`.
  await card("standalone root").getByRole("button", { name: "Reply" }).click();
  let reply = page.getByTestId("converse-reply-composer");
  await expect(reply.getByTestId("converse-image-trigger")).toBeVisible();
  await expect(reply.getByTestId("converse-images-disabled")).toHaveCount(0);
  await reply.getByTestId("converse-image-trigger").click();
  await expectPickerOpen(page, { slot: "post" });
  await closePicker(page);
  await card("standalone root").getByRole("button", { name: "Cancel" }).click();
  await expect(reply).toHaveCount(0);

  for (const [text, subscriberOnly] of [
    ["public zpage thread comment", false],
    ["members zpage thread comment", true],
  ] as const) {
    await card(text).getByRole("button", { name: "Reply" }).click();
    reply = page.getByTestId("converse-reply-composer");
    await expect(reply.getByTestId("converse-image-trigger")).toBeVisible();
    await expect(reply.getByTestId("converse-images-disabled")).toHaveCount(0);
    await reply.getByTestId("converse-image-trigger").click();
    await expectPickerOpen(page, {
      slot: "body",
      subscriberOnly,
      cloudTab: subscriberOnly ? "active" : "inactive",
      deviceTab: !subscriberOnly,
    });
    if (subscriberOnly) {
      await reply.locator("textarea").fill("private local note ");
      await pasteImage(
        page,
        '[data-testid="converse-reply-composer"] textarea',
      );
      await expect(
        page
          .getByText(
            "Local images can't be added to subscriber-only replies. Choose a saved members image.",
          )
          .last(),
      ).toBeVisible();
      await expect(reply.locator("textarea")).toHaveValue(
        "private local note ",
      );
      // The only local uploader is /uploads/single-public. Members replies
      // refuse before that request, so private bytes never become public.
      expect(uploads).toHaveLength(0);

      // A members-tier cloud image is valid in a subscriber-only body and is
      // inserted by reference; it must not be downgraded to public.
      await page
        .getByRole("dialog")
        .getByRole("tab", { name: "Your Cloud" })
        .click();
      await page.getByRole("button", { name: /Backstage/ }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(reply.locator("textarea")).toHaveValue(
        /\/uploadz\/backstage\.png/,
      );

      // The + menu and slash command must open the picker on the cloud tab;
      // members replies can choose saved media but cannot upload local bytes.
      await reply.getByTestId("converse-insert-trigger").click();
      await page
        .getByRole("listbox", { name: "Insert content" })
        .getByRole("option", { name: /^Image/ })
        .click();
      await expectPickerOpen(page, {
        slot: "body",
        cloudTab: "active",
        deviceTab: false,
      });
      // Wait for the close before typing the next command: the reopen used to
      // race it, and lost.
      await closePicker(page);

      await reply.locator("textarea").fill("/image");
      await reply.locator("textarea").press("Enter");
      await expectPickerOpen(page, {
        slot: "body",
        cloudTab: "active",
        deviceTab: false,
      });
      await closePicker(page);
    } else {
      // The members branch above closed its own last picker; the public
      // iteration's is still open.
      await closePicker(page);
    }
    await card(text).getByRole("button", { name: "Cancel" }).click();
    await expect(reply).toHaveCount(0);
  }

  for (const text of ["draft zpage thread comment", "ai thread comment"]) {
    await card(text).getByRole("button", { name: "Reply" }).click();
    reply = page.getByTestId("converse-reply-composer");
    await expect(reply).toBeVisible();

    // Private and unknown-audience threads have no image button or picker.
    await expect(reply.getByTestId("converse-image-trigger")).toHaveCount(0);
    await expect(reply.getByTestId("converse-images-disabled")).toHaveText(
      "Images can only be added to public Converse threads.",
    );
    //...and no Image command in the + palette.
    const plus = reply.getByTestId("converse-insert-trigger");
    await plus.click();
    const menu = page.getByRole("listbox", { name: "Insert content" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option", { name: /^Link/ })).toBeVisible();
    await expect(menu.getByRole("option", { name: /^Image/ })).toHaveCount(0);
    await plus.click();
    await expect(menu).toHaveCount(0);

    // A pasted screenshot is refused on the spot: nothing uploads, nothing is
    // inserted.
    const textarea = reply.locator("textarea");
    await textarea.fill("secret notes ");
    await pasteImage(page, '[data-testid="converse-reply-composer"] textarea');
    await expect(
      page
        .getByText("Images can only be added to public Converse threads.")
        .last(),
    ).toBeVisible();
    await expect(textarea).toHaveValue("secret notes ");
    expect(uploads).toHaveLength(0);

    await card(text).getByRole("button", { name: "Cancel" }).click();
    await expect(reply).toHaveCount(0);
  }

  for (const text of [
    "missing attachment metadata",
    "empty attachment metadata",
  ]) {
    await card(text).getByRole("button", { name: "Reply" }).click();
    reply = page.getByTestId("converse-reply-composer");
    await expect(reply.getByTestId("converse-image-trigger")).toHaveCount(0);
    await expect(reply.getByTestId("converse-images-disabled")).toBeVisible();
    await card(text).getByRole("button", { name: "Cancel" }).click();
    await expect(reply).toHaveCount(0);
  }

  // The commenter owns the cloud image, but the zPage audience belongs to a
  // different creator. A members image requires explicit consent to promote
  // it to public; cancelling leaves the reply unchanged.
  await card("members page owned by someone else")
    .getByRole("button", { name: "Reply" })
    .click();
  reply = page.getByTestId("converse-reply-composer");
  await reply.getByTestId("converse-image-trigger").click();
  const otherOwnerDialog = page.getByRole("dialog");
  await expect(otherOwnerDialog).toHaveAttribute(
    "data-media-access-slot",
    "body",
  );
  await expect(otherOwnerDialog).toHaveAttribute(
    "data-subscriber-only",
    "false",
  );
  await otherOwnerDialog.getByRole("tab", { name: "Your Cloud" }).click();
  await otherOwnerDialog.getByRole("button", { name: /Backstage/ }).click();
  await expect(
    otherOwnerDialog.locator('[data-media-access-gate="public"]'),
  ).toBeVisible();
  await expect(reply.locator("textarea")).toHaveValue("");
  expect(uploads).toHaveLength(0);
  await otherOwnerDialog
    .locator('[data-media-access-gate-action="cancel"]')
    .click();
  await expect(
    otherOwnerDialog.locator('[data-media-access-gate="public"]'),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await card("members page owned by someone else")
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(reply).toHaveCount(0);

  expect(created).toHaveLength(0);
});

test("a reply refreshes its thread tier before uploading a pasted image", async ({
  page,
}) => {
  const root = seedPost(
    "root-tier-changed",
    "thread starts public",
    ZPAGE_PUBLIC_THREAD_URL,
    "public",
    TEST_CREATOR.id,
  );
  const { uploads } = await installMocks(page, [root]);
  await gotoConverse(page);

  const card = page.locator('[data-testid="converse-feed"] > article', {
    hasText: "thread starts public",
  });
  await card.getByRole("button", { name: "Reply" }).click();
  const reply = page.getByTestId("converse-reply-composer");
  const textarea = reply.locator("textarea");
  await textarea.fill("do not publish this image ");

  // Simulate the owner changing the zPage tier in another tab while this
  // composer is still open. The feed object's initial tier is now stale;
  // GET /api/comments/{uuid}/ returns the current members tier.
  root.thread_access = "members";
  await pasteImage(page, '[data-testid="converse-reply-composer"] textarea');

  await expect(
    page
      .getByText(
        "Local images can't be added to subscriber-only replies. Choose a saved members image.",
      )
      .last(),
  ).toBeVisible();
  await expect(textarea).toHaveValue("do not publish this image ");
  expect(uploads).toHaveLength(0);

  // An already-open picker is restricted on refresh too: opening the image
  // flow after the tier flip presents only the saved-image Cloud tab.
  await reply.getByTestId("converse-image-trigger").click();
  const dialog = await expectPickerOpen(page, {
    slot: "body",
    subscriberOnly: true,
    cloudTab: "active",
    deviceTab: false,
  });
  await closePicker(page);
  await expect(dialog).toHaveCount(0);
});

test("a pending access check blocks submission until an upload starts", async ({
  page,
}) => {
  const root = seedPost(
    "root-delayed-check",
    "public thread",
    ZPAGE_PUBLIC_THREAD_URL,
    "public",
    TEST_CREATOR.id,
  );
  const { uploads, releaseUpload } = await installMocks(page, [root]);
  let releaseTierRead = () => {};
  let announceTierRead = () => {};
  const tierReadStarted = new Promise<void>((resolve) => {
    announceTierRead = resolve;
  });
  const tierReadReleased = new Promise<void>((resolve) => {
    releaseTierRead = resolve;
  });
  await page.route("**/api/comments/root-delayed-check/", async (route) => {
    announceTierRead();
    await tierReadReleased;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(root),
    });
  });

  await gotoConverse(page);
  const card = page.locator('[data-testid="converse-feed"] > article', {
    hasText: "public thread",
  });
  await card.getByRole("button", { name: "Reply" }).click();
  const reply = page.getByTestId("converse-reply-composer");
  const textarea = reply.locator("textarea");
  await textarea.fill("charge this reply only with the image ");
  const post = reply.getByRole("button", { name: "Reply", exact: true });

  await pasteImage(page, '[data-testid="converse-reply-composer"] textarea');
  await tierReadStarted;
  await expect(post).toBeDisabled();
  await expect(textarea).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("converse-upload-status")).toContainText(
    "Checking media access",
  );

  releaseTierRead();
  await expect.poll(() => uploads.length).toBe(1);
  await expect(post).toBeDisabled();
  releaseUpload();
  await expect(textarea).toHaveValue(
    /\/uploadz\/public\/converse-tools-user\/photo\.png/,
  );
  await expect(post).toBeEnabled();
});

test("a failed cloud-image access check can be retried in the picker", async ({
  page,
}) => {
  const root = seedPost(
    "root-retry-check",
    "public thread",
    ZPAGE_PUBLIC_THREAD_URL,
    "public",
    TEST_CREATOR.id,
  );
  await installMocks(page, [root]);
  let accessChecks = 0;
  await page.route("**/api/comments/root-retry-check/", async (route) => {
    accessChecks += 1;
    if (accessChecks === 1) {
      await route.fulfill({ status: 503, body: "try again" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(root),
    });
  });
  await page.route(
    (url) => new URL(url).pathname === "/api/myuploads/",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ count: 1, next: null, results: [PUBLIC_IMAGE] }),
      }),
  );
  await page.route("**/api/myuploads/7102/", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(PUBLIC_IMAGE),
    }),
  );

  await gotoConverse(page);
  const card = page.locator('[data-testid="converse-feed"] > article', {
    hasText: "public thread",
  });
  await card.getByRole("button", { name: "Reply" }).click();
  const reply = page.getByTestId("converse-reply-composer");
  await reply.getByTestId("converse-image-trigger").click();
  const dialog = await expectPickerOpen(page, {
    slot: "body",
    subscriberOnly: false,
  });
  await dialog.getByRole("tab", { name: "Your Cloud" }).click();
  await page.getByRole("button", { name: /Open sky/ }).click();

  await expect(
    page.getByText(
      "Could not check who can open that image. Please try again.",
    ),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(reply.locator("textarea")).toHaveValue("");
  await page.getByRole("button", { name: /Open sky/ }).click();
  await expect(reply.locator("textarea")).toHaveValue(
    /\/uploadz\/public\/open-sky\.png/,
  );
  await expect(dialog).toHaveCount(0);
  // Failed choose-time refresh, then the retry's choose-time refresh and its
  // insert-time preflight.
  expect(accessChecks).toBe(3);
});

test("a stalled access preflight times out and leaves the reply recoverable", async ({
  page,
}) => {
  const root = seedPost(
    "root-stalled-check",
    "public thread",
    ZPAGE_PUBLIC_THREAD_URL,
    "public",
    TEST_CREATOR.id,
  );
  const { uploads } = await installMocks(page, [root]);
  let releaseTierRead = () => {};
  let announceTierRead = () => {};
  const tierReadStarted = new Promise<void>((resolve) => {
    announceTierRead = resolve;
  });
  const tierReadReleased = new Promise<void>((resolve) => {
    releaseTierRead = resolve;
  });
  await page.route("**/api/comments/root-stalled-check/", async (route) => {
    announceTierRead();
    await tierReadReleased;
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(root),
      });
    } catch {
      // The app's request deadline has cancelled the stalled request.
    }
  });

  await gotoConverse(page);
  const card = page.locator('[data-testid="converse-feed"] > article', {
    hasText: "public thread",
  });
  await card.getByRole("button", { name: "Reply" }).click();
  const reply = page.getByTestId("converse-reply-composer");
  const textarea = reply.locator("textarea");
  await textarea.fill("keep my reply available ");
  const post = reply.getByRole("button", { name: "Reply", exact: true });

  await pasteImage(page, '[data-testid="converse-reply-composer"] textarea');
  await tierReadStarted;
  await expect(post).toBeDisabled();
  await expect(
    page.getByText(
      "Could not check who can open that image. Please try again.",
    ),
  ).toBeVisible({ timeout: 10_000 });
  await expect(post).toBeEnabled();
  await expect(textarea).toHaveValue("keep my reply available ");
  expect(uploads).toHaveLength(0);
  await expect(reply.getByTestId("converse-image-trigger")).toBeVisible();
  releaseTierRead();
});

test("closing a reply cancels its obsolete access preflight", async ({
  page,
}) => {
  const root = seedPost(
    "root-cancel-check",
    "public thread",
    ZPAGE_PUBLIC_THREAD_URL,
    "public",
    TEST_CREATOR.id,
  );
  await installMocks(page, [root]);
  let releaseTierRead = () => {};
  let announceTierRead = () => {};
  const tierReadStarted = new Promise<void>((resolve) => {
    announceTierRead = resolve;
  });
  const tierReadReleased = new Promise<void>((resolve) => {
    releaseTierRead = resolve;
  });
  await page.route("**/api/comments/root-cancel-check/", async (route) => {
    announceTierRead();
    await tierReadReleased;
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(root),
      });
    } catch {
      // The composer has aborted this obsolete request.
    }
  });

  await gotoConverse(page);
  const card = page.locator('[data-testid="converse-feed"] > article', {
    hasText: "public thread",
  });
  await card.getByRole("button", { name: "Reply" }).click();
  const reply = page.getByTestId("converse-reply-composer");
  await reply.locator("textarea").fill("draft stays unposted ");
  await pasteImage(page, '[data-testid="converse-reply-composer"] textarea');
  await tierReadStarted;

  const requestCancelled = page.waitForEvent(
    "requestfailed",
    (request) =>
      new URL(request.url()).pathname === "/api/comments/root-cancel-check/",
  );
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(reply).toHaveCount(0);
  await expect(requestCancelled).resolves.toBeTruthy();
  releaseTierRead();
  await expect(
    page.getByText(
      "Could not check who can open that image. Please try again.",
    ),
  ).toHaveCount(0);
});

test("placeholder-shaped text blocks nothing; a mangled in-flight placeholder is never posted", async ({
  page,
}) => {
  const { created, uploads, releaseUpload } = await installMocks(page);
  const body = await gotoConverse(page);
  const post = page.getByRole("button", { name: "Post", exact: true });

  // Typed or pasted, with no upload behind it: the writer's own text.
  await body.fill("see ![Uploading image…](upload-abc-1)");
  await expect(post).toBeEnabled();

  // Now a real upload, whose placeholder the writer mangles mid-flight.
  await body.fill("look ");
  await page.getByTestId("converse-image-trigger").click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await dialog.getByRole("button", { name: "Insert Selected" }).click();
  await expect.poll(() => uploads.length, { timeout: 10_000 }).toBe(1);
  const withPlaceholder = await body.inputValue();
  expect(withPlaceholder).toMatch(/!\[Uploading image…\]\(upload-/);
  await body.fill(withPlaceholder.replace("![", "["));

  // Still ours, still in flight: still blocked, both ways in.
  await expect(post).toBeDisabled();
  await body.press("ControlOrMeta+Enter");
  await expect(
    page
      .getByTestId("payment-outcome-error")
      .getByText("Wait for your files to finish uploading."),
  ).toBeVisible();
  expect(created).toHaveLength(0);

  // Settled: the pipeline could not find the mangled placeholder, so the
  // text stays, but it is stripped from what goes out.
  releaseUpload();
  await expect(post).toBeEnabled();
  await expect(body).toHaveValue(/^look \[Uploading image…\]\(upload-/);
  await post.click();
  await expect.poll(() => created.length, { timeout: 10_000 }).toBe(1);
  expect(created[0].content).toBe("look");
});

/** Start one held upload from the picker; return the placeholder text. */
async function startHeldUpload(page: Page, uploads: string[]) {
  const body = page.locator("#converse-content");
  const before = uploads.length;
  await page.getByTestId("converse-image-trigger").click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await dialog.getByRole("button", { name: "Insert Selected" }).click();
  await expect.poll(() => uploads.length, { timeout: 10_000 }).toBe(before + 1);
  const value = await body.inputValue();
  const token = value.match(/\((upload-[a-z0-9-]+)\)/)?.[1];
  expect(token).toBeTruthy();
  return token!;
}

test("an edited placeholder the composer cannot take apart is refused, never posted", async ({
  page,
}) => {
  const { created, uploads, releaseUpload } = await installMocks(page);
  const body = await gotoConverse(page);
  const post = page.getByRole("button", { name: "Post", exact: true });

  await body.fill("hello ");
  const token = await startHeldUpload(page, uploads);

  // Uppercasing the token does not sneak past the in-flight gate.
  await body.fill(`hello ![Uploading image…](${token.toUpperCase()})`);
  await expect(post).toBeDisabled();

  // An edit that no clean strip can undo.
  await body.fill(`hello [Uploading image…]( ${token.toUpperCase()} x)`);
  await expect(post).toBeDisabled();
  releaseUpload();
  await expect(post).toBeEnabled();

  await post.click();
  await expect(
    page
      .getByTestId("payment-outcome-error")
      .getByText(
        "An image placeholder in your post was edited. Remove it and try again.",
      ),
  ).toBeVisible();
  await page.waitForTimeout(300);
  expect(created).toHaveLength(0);
  // The writer's text is left as it was, for them to fix.
  await expect(body).toHaveValue(
    `hello [Uploading image…]( ${token.toUpperCase()} x)`,
  );
});

test("a post that is nothing but a dead placeholder says so instead of doing nothing", async ({
  page,
}) => {
  const { created, uploads, releaseUpload } = await installMocks(page);
  const body = await gotoConverse(page);
  const post = page.getByRole("button", { name: "Post", exact: true });

  const token = await startHeldUpload(page, uploads);
  // Mangled mid-upload, so the image can never land in it.
  await body.fill(`[Uploading image…](${token})`);
  releaseUpload();
  await expect(post).toBeEnabled();

  await post.click();
  await expect(
    page
      .getByTestId("payment-outcome-error")
      .getByText(
        "Nothing to post: the only thing in it was an image that did not upload.",
      ),
  ).toBeVisible();
  await page.waitForTimeout(300);
  expect(created).toHaveLength(0);
});

/**
 * The tier refresh has to happen before the picker decides what a saved image
 * NEEDS, not only before the final insert. Otherwise a composer opened on a
 * public thread that has since gone subscribers-only offers to make the
 * owner's paid `members` image PUBLIC (the stale slot's answer), and the
 * insert-time refresh only runs after that PATCH has already published it.
 */
test("a saved image's required tier is judged against the refreshed thread tier", async ({
  page,
}) => {
  const root = seedPost(
    "root-picker-tier",
    "owner thread starts public",
    ZPAGE_PUBLIC_THREAD_URL,
    "public",
    TEST_CREATOR.id,
  );
  await installMocks(page, [root]);
  const patches: string[] = [];
  await page.route(`**/api/myuploads/${MEMBERS_IMAGE.id}/`, async (route) => {
    if (route.request().method() === "PATCH") {
      patches.push(route.request().postData() || "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...MEMBERS_IMAGE,
          access: "public",
          url: "/uploadz/public/backstage.png",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MEMBERS_IMAGE),
    });
  });

  await gotoConverse(page);
  const card = page.locator('[data-testid="converse-feed"] > article', {
    hasText: "owner thread starts public",
  });
  await card.getByRole("button", { name: "Reply" }).click();
  const reply = page.getByTestId("converse-reply-composer");
  const textarea = reply.locator("textarea");

  // Flip the page to subscribers-only "in another tab" before choosing.
  root.thread_access = "members";
  await reply.getByTestId("converse-image-trigger").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Your Cloud" }).click();
  await dialog.getByRole("button", { name: /Backstage/ }).click();

  await expect(textarea).toHaveValue(/\/uploadz\/backstage\.png/);
  await expect(page.locator('[data-media-access-gate="public"]')).toHaveCount(
    0,
  );
  expect(patches).toHaveLength(0);
});

test("confirming a promotion re-checks the thread tier before it PATCHes", async ({
  page,
}) => {
  const root = seedPost(
    "root-gate-tier",
    "owner thread gate",
    ZPAGE_PUBLIC_THREAD_URL,
    "public",
    TEST_CREATOR.id,
  );
  await installMocks(page, [root]);
  const patches: string[] = [];
  await page.route(`**/api/myuploads/${MEMBERS_IMAGE.id}/`, async (route) => {
    if (route.request().method() === "PATCH") {
      patches.push(route.request().postData() || "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...MEMBERS_IMAGE,
          access: "public",
          url: "/uploadz/public/backstage.png",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MEMBERS_IMAGE),
    });
  });

  await gotoConverse(page);
  const card = page.locator('[data-testid="converse-feed"] > article', {
    hasText: "owner thread gate",
  });
  await card.getByRole("button", { name: "Reply" }).click();
  const reply = page.getByTestId("converse-reply-composer");
  const textarea = reply.locator("textarea");
  await reply.getByTestId("converse-image-trigger").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Your Cloud" }).click();
  await dialog.getByRole("button", { name: /Backstage/ }).click();

  // Correct for a public thread: a members image needs to become public.
  await expect(
    dialog.locator('[data-media-access-gate="public"]'),
  ).toBeVisible();

  // The page goes subscribers-only while the consent dialog is open.
  root.thread_access = "members";
  await dialog.locator('[data-media-access-gate-action="promote"]').click();

  await expect(textarea).toHaveValue(/\/uploadz\/backstage\.png/);
  expect(patches).toHaveLength(0);
});

test("a failed access check keeps the picker's device selection for a retry", async ({
  page,
}) => {
  const root = seedPost(
    "root-device-retry",
    "public device thread",
    ZPAGE_PUBLIC_THREAD_URL,
    "public",
    TEST_CREATOR.id,
  );
  const { uploads } = await installMocks(page, [root]);
  let accessChecks = 0;
  await page.route("**/api/comments/root-device-retry/", async (route) => {
    accessChecks += 1;
    if (accessChecks === 1) {
      await route.fulfill({ status: 503, body: "try again" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(root),
    });
  });

  await gotoConverse(page);
  const card = page.locator('[data-testid="converse-feed"] > article', {
    hasText: "public device thread",
  });
  await card.getByRole("button", { name: "Reply" }).click();
  const reply = page.getByTestId("converse-reply-composer");
  await reply.getByTestId("converse-image-trigger").click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await dialog.getByRole("button", { name: "Insert Selected" }).click();
  await expect(
    page.getByText(
      "Could not check who can open that image. Please try again.",
    ),
  ).toBeVisible();
  // Still open, selection intact: the retry is one click, not a re-pick.
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Insert Selected" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => uploads.length).toBe(1);
});

test("text typed during the access check does not split the pasted placeholder", async ({
  page,
}) => {
  const root = seedPost(
    "root-offset-check",
    "public offset thread",
    ZPAGE_PUBLIC_THREAD_URL,
    "public",
    TEST_CREATOR.id,
  );
  await installMocks(page, [root]);
  let releaseTierRead = () => {};
  const tierReadReleased = new Promise<void>((resolve) => {
    releaseTierRead = resolve;
  });
  let announceTierRead = () => {};
  const tierReadStarted = new Promise<void>((resolve) => {
    announceTierRead = resolve;
  });
  await page.route("**/api/comments/root-offset-check/", async (route) => {
    announceTierRead();
    await tierReadReleased;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(root),
    });
  });

  await gotoConverse(page);
  const card = page.locator('[data-testid="converse-feed"] > article', {
    hasText: "public offset thread",
  });
  await card.getByRole("button", { name: "Reply" }).click();
  const textarea = page
    .getByTestId("converse-reply-composer")
    .locator("textarea");
  await textarea.fill("WORD");
  await textarea.press("End");
  // Paste at the very end, then type in front of it while the check waits.
  await pasteImage(page, '[data-testid="converse-reply-composer"] textarea');
  await tierReadStarted;
  // `Home` does not move the caret in Chromium on macOS; set it directly.
  await textarea.evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(0, 0),
  );
  await textarea.pressSequentially("ab ");
  releaseTierRead();

  await expect(textarea).toHaveValue(
    /^ab WORD!\[Uploading image…\]\(upload-[a-z0-9-]+\)$/,
  );
});

const VIDEO = {
  id: 7201,
  title: "Studio clip",
  name: "studio.mp4",
  mime_type: "video/mp4",
  access: "public",
  url: "/uploadz/public/studio.mp4",
  thumbnail: null,
};

test("video picker uploads a clip, blocks posting until settled and publishes a native embed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { created } = await installMocks(page);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let uploads = 0;
  await page.route("**/uploads/single-public", async (route) => {
    uploads++;
    await pending;
    await route.fulfill({ status: 201, json: VIDEO });
  });
  const body = await gotoConverse(page);
  await body.fill("A clip: ");
  await page.getByTestId("converse-video-trigger").click();
  const dialog = page.getByRole("dialog", { name: "Add Video", exact: true });
  await expect(
    dialog.getByRole("heading", { name: "Add Video" }),
  ).toBeVisible();
  await expect
    .poll(() => dialog.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("1");
  const selectVideo = dialog.getByRole("button", {
    name: "Select Videos",
    exact: true,
  });
  await expect(selectVideo).toBeVisible();
  await expect
    .poll(() =>
      selectVideo.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        );
        return hit !== null && el.contains(hit);
      }),
    )
    .toBe(true);
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "unsupported.avi",
    mimeType: "video/x-msvideo",
    buffer: Buffer.from("unsupported"),
  });
  await expect(
    dialog.getByRole("button", { name: "Insert Selected" }),
  ).toHaveCount(0);

  await dialog.locator('input[type="file"]').setInputFiles({
    name: "Lesson #1?.mp4",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("fixture video bytes"),
  });
  await dialog.getByRole("button", { name: "Insert Selected" }).click();
  await expect(body).toHaveValue(/Uploading video.*upload-/);
  await expect.poll(() => uploads).toBe(1);
  await expect(
    page.getByRole("button", { name: "Post", exact: true }),
  ).toBeDisabled();
  finish();
  await expect(body).toHaveValue(`A clip: \n\n::embed[${VIDEO.url}]\n\n`);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator(`video source[src="${VIDEO.url}"]`)).toHaveCount(1);
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await expect.poll(() => created.length).toBe(1);
  expect(created[0].content).toBe(`A clip: \n\n::embed[${VIDEO.url}]`);
});

test("video cloud selection checks current MIME and access before inserting", async ({
  page,
}) => {
  const { created } = await installMocks(page);
  let current = { ...VIDEO, access: "members" };
  let patches = 0;
  await page.route("**/api/myuploads/?*", (route) => {
    expect(new URL(route.request().url()).searchParams.get("mime_type")).toBe(
      "video/",
    );
    return route.fulfill({
      json: { results: [VIDEO, PUBLIC_IMAGE], next: null },
    });
  });
  await page.route(`**/api/myuploads/${VIDEO.id}/`, (route) => {
    if (route.request().method() === "PATCH") patches++;
    return route.fulfill({ json: current });
  });
  const body = await gotoConverse(page);
  await body.fill("/video");
  await page.getByRole("option", { name: /Add Video/ }).click();
  const dialog = page.getByRole("dialog", { name: "Add Video", exact: true });
  await dialog.getByRole("tab", { name: "Your Cloud" }).click();
  await expect(dialog.getByRole("button", { name: /Open sky/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: /Studio clip/ }).click();
  await expect(
    dialog.locator('[data-media-access-gate="public"]'),
  ).toBeVisible();
  expect(patches).toBe(0);
  await dialog.locator('[data-media-access-gate-action="cancel"]').click();
  current = { ...VIDEO, mime_type: "image/png" };
  await dialog.getByRole("button", { name: /Studio clip/ }).click();
  await expect(body).toHaveValue("");
  await expect(dialog).toBeVisible();
  current = VIDEO;
  await dialog.getByRole("button", { name: /Studio clip/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(body).toHaveValue(`\n\n::embed[${VIDEO.url}]\n\n`);
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await expect.poll(() => created.length).toBe(1);
  expect(created[0].content).toBe(`::embed[${VIDEO.url}]`);
  expect(patches).toBe(0);
});

test("members replies offer saved video only and can insert accessible members video", async ({
  page,
}) => {
  await installMocks(page, [
    seedPost(
      "video-members",
      "members video thread",
      ZPAGE_THREAD_URL,
      "members",
      TEST_CREATOR.id,
    ),
  ]);
  const membersVideo = { ...VIDEO, access: "members" };
  await page.route("**/api/myuploads/?*", (route) =>
    route.fulfill({ json: { results: [membersVideo], next: null } }),
  );
  await page.route(`**/api/myuploads/${VIDEO.id}/`, (route) => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: membersVideo });
  });
  await gotoConverse(page);
  const card = page.locator('[data-testid="converse-feed"] > article', {
    hasText: "members video thread",
  });
  await card.getByRole("button", { name: "Reply" }).click();
  const reply = page.getByTestId("converse-reply-composer");
  await reply.getByTestId("converse-video-trigger").click();
  const dialog = page.getByRole("dialog", { name: "Add Video", exact: true });
  await expect(dialog.getByRole("tab", { name: "Device" })).toHaveCount(0);
  await expect(dialog.locator('input[type="file"]')).toHaveCount(0);
  await dialog.getByRole("button", { name: /Studio clip/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(reply.locator("textarea")).toHaveValue(
    `\n\n::embed[${VIDEO.url}]\n\n`,
  );
});
