import { expect, test, type Page, type Locator } from "@playwright/test";

import { devSourceModuleLoader } from "./dev-source-module";

/**
 * Free-form tags in the editor.
 *
 * The backend field is `django-taggit` — an open vocabulary. The editor used
 * to front it with a twenty-item `<Select>`, so a creator could neither add a
 * tag outside that list nor remove one. These tests exercise the real editor
 * against a stubbed API and assert on the bytes that leave the browser,
 * because "the tag is on screen" and "the tag is in the PUT" are different
 * claims and only the second one survives a reload.
 *
 * The first test is the regression the issue is really about: an article
 * carrying tags no picker knows must come back unharmed from a save that had
 * nothing to do with tags.
 *
 * Against `main` these fail at the first assertion for the same reason: there
 * is no text input in the publish sheet at all, only a listbox of twenty.
 */

const CREATOR = { id: 8103, username: "tagsmith", full_name: "Tag Smith" };

const ARTICLE_ID = "tagged-fixture";

/** Tags a closed twenty-item picker could never have rendered. */
const UNKNOWN_TAGS = ["zebra husbandry", "café-culture"];

const SUGGESTIONS = [
  { name: "zcash", count: 42 },
  { name: "privacy", count: 17 },
];

function article() {
  return {
    id: 1,
    free2zaddr: ARTICLE_ID,
    vanity: "tagged-fixture",
    title: "An article with tags nobody hardcoded",
    description: "",
    canonical_url: "",
    content: "Body.",
    tags: [...UNKNOWN_TAGS, "ART"],
    category: "",
    is_published: true,
    is_subscriber_only: false,
    publish_at: null,
    p2paddr: "",
    featured_image: null,
    creator: CREATOR,
    source_language: "en",
    actual_language: "en",
    requested_language: "en",
    available_languages: ["en"],
    variant_is_published: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

type Sent = { pathname: string; method: string; body: any };

/**
 * `/edit` is `ssr = false`, so every call it makes is client-side and the
 * Playwright mock-API server never sees them. Interception is the only way to
 * both feed the editor an article and read back what it saves.
 */
async function stubApi(page: Page) {
  const sent: Sent[] = [];

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname, searchParams } = new URL(request.url());
      const method = request.method();

      if (method !== "GET") {
        let body: any = null;
        try {
          body = JSON.parse(request.postData() || "null");
        } catch {
          body = request.postData();
        }
        sent.push({ pathname, method, body });
      }

      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
        return;
      }
      if (pathname === "/api/tagging/autocomplete") {
        const query = (searchParams.get("query") || "").toLowerCase();
        await route.fulfill({
          json: SUGGESTIONS.filter((tag) => tag.name.includes(query)),
        });
        return;
      }
      if (pathname === `/api/zpage/${ARTICLE_ID}/`) {
        // A write echoes what it was sent, the way the API does. Returning the
        // pristine fixture instead makes the editor rehydrate from a response
        // that contradicts the request, which is a bug in the test rather than
        // in the app — and one that hides real ones behind a save loop.
        const body = method === "GET" ? null : sent[sent.length - 1]?.body;
        await route.fulfill({ json: { ...article(), ...(body || {}) } });
        return;
      }
      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  return sent;
}

async function openPublishSheet(page: Page) {
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(page.locator("textarea.writing-area-textarea")).toBeVisible({
    timeout: 30_000,
  });
  // The sheet is behind the topbar's publish action, which reads "Update"
  // once the article is published.
  await page
    .getByRole("button", { name: /^(update|publish)$/i })
    .first()
    .click();
  const input = page.getByTestId("tag-input");
  await expect(input).toBeVisible();
  return input;
}

/** The `tags` array of the most recent write, whatever route it went to. */
function lastSavedTags(sent: Sent[]): string[] | undefined {
  for (let index = sent.length - 1; index >= 0; index -= 1) {
    const body = sent[index].body;
    if (body && Array.isArray(body.tags)) return body.tags;
  }
  return undefined;
}

test.describe.configure({ timeout: 90_000 });

// Resolve colors through the browser (including CSS variables and modern color
// syntax), then composite every ancestor background from the canvas inward.
async function measureContrast(label: Locator) {
  return label.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const over = (front: number[], back: number[]) =>
      front
        .slice(0, 3)
        .map(
          (value, i) =>
            value * (front[3] / 255) + back[i] * (1 - front[3] / 255),
        );
    const chain: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement)
      chain.push(node);
    let background = [255, 255, 255]; // Browser canvas below the root.
    for (const node of chain.reverse())
      background = over(
        rgba(getComputedStyle(node).backgroundColor),
        background,
      );
    const color = getComputedStyle(element).color;
    const foreground = over(rgba(color), background);
    const luminance = (rgb: number[]) =>
      rgb
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        })
        .reduce(
          (sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i],
          0,
        );
    const [light, dark] = [luminance(foreground), luminance(background)].sort(
      (a, b) => b - a,
    );
    return {
      color,
      background: background.map(Math.round),
      ratio: (light + 0.05) / (dark + 0.05),
    };
  });
}

async function assertReadable(label: Locator, state: string) {
  const colors = await measureContrast(label);
  console.info(`[contrast] ${state}: ${JSON.stringify(colors)}`);
  expect(colors.ratio, state).toBeGreaterThanOrEqual(4.5);
  return colors;
}

// Wait for the actual computed colors to stop changing after hover/selection.
async function settleColors(page: Page) {
  await page.waitForTimeout(350); // Tailwind transition-colors is 150ms.
}

async function decoration(element: Locator) {
  return element.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      shadow: style.boxShadow,
      outline: style.outlineStyle,
      width: style.outlineWidth,
    };
  });
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1280]) {
    test(`disabled tag contrast ${theme} ${width}px`, async ({ page }) => {
      await page.addInitScript(
        (mode) => localStorage.setItem("mode-watcher-mode", mode),
        theme,
      );
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/search");
      await page.evaluate(
        async ({ loader, dark }) => {
          const runtime = "/tests/browser/svelte-runtime.ts";
          const [{ default: TagInput }, { mount }] = await Promise.all([
            new Function(loader)(),
            import(/* @vite-ignore */ runtime),
          ]);
          document.documentElement.classList.toggle("dark", dark);
          const target = document.createElement("div");
          target.id = "disabled-tags";
          document.body.append(target);
          mount(TagInput, {
            target,
            props: { tags: ["zcash"], disabled: true },
          });
        },
        {
          loader: devSourceModuleLoader("/src/lib/components/TagInput.svelte"),
          dark: theme === "dark",
        },
      );
      const harness = page.locator("#disabled-tags");
      const input = harness.getByRole("combobox");
      const button = harness.getByRole("button", { name: "Remove tag zcash" });
      await expect(input).toBeDisabled();
      await expect(button).toBeDisabled();
      const container = input.locator("..");
      expect(
        await container.evaluate((el) => getComputedStyle(el).borderTopStyle),
      ).toBe("dashed");
      expect(
        await container.evaluate((el) => getComputedStyle(el).cursor),
      ).toBe("not-allowed");
      await input.evaluate((el: HTMLInputElement) => el.focus());
      await expect(input).not.toBeFocused();
      await expect(harness.getByRole("listbox")).toHaveCount(0);
      const label = button.locator("..").locator("span").first();
      await assertReadable(label, `${theme}/${width} disabled tag`);
      await button.hover({ force: true });
      await settleColors(page);
      await assertReadable(label, `${theme}/${width} disabled tag hover`);
      expect(
        await page.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        ),
      ).toBe(theme === "dark");
    });
    test(`tag suggestion contrast ${theme} ${width}px`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await stubApi(page);
      await page.addInitScript(
        (mode) => localStorage.setItem("mode-watcher-mode", mode),
        theme,
      );
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      const input = await openPublishSheet(page);
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
      expect(
        await page.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        ),
      ).toBe(theme === "dark");
      const container = input.locator("..");
      const chipButton = page.getByRole("button", {
        name: "Remove tag ART",
        exact: true,
      });
      const chip = chipButton.locator("..").locator("span").first();
      await input.evaluate((el: HTMLInputElement) => el.blur());
      await settleColors(page);
      const unfocused = await decoration(container);
      // Use keyboard navigation from a known preceding control, before typing.
      await chipButton.focus();
      await page.keyboard.press("Tab");
      await expect(input).toBeFocused();
      await settleColors(page);
      const focused = await decoration(container);
      expect(focused).not.toEqual(unfocused);
      expect(
        focused.shadow !== "none" ||
          (focused.outline !== "none" && parseFloat(focused.width) > 0),
      ).toBe(true);
      const state = `${theme}/${width}`;
      await assertReadable(chip, `${state} tag`);
      await chipButton.hover();
      await settleColors(page);
      await assertReadable(chip, `${state} tag hover`);
      // The last remove button receives real keyboard focus too.
      await page.keyboard.press("Shift+Tab");
      await expect(chipButton).toBeFocused();
      const chipFocus = await decoration(chipButton);
      expect(chipFocus.outline).not.toBe("none");
      expect(parseFloat(chipFocus.width)).toBeGreaterThan(0);
      await assertReadable(chip, `${state} tag focus`);
      await page.keyboard.press("Tab");
      await input.fill("zc");
      const option = page.getByRole("option", { name: /zcash/ });
      await expect(option).toBeVisible();
      await expect(option).toHaveAttribute("aria-selected", "false");
      const name = option.locator("span").nth(0);
      const count = option.locator("span").nth(1);
      const normal = await assertReadable(name, `${state} default label`);
      await assertReadable(count, `${state} default count`);
      await input.press("ArrowDown");
      await expect(option).toHaveAttribute("aria-selected", "true");
      await settleColors(page);
      const selected = await assertReadable(name, `${state} selected label`);
      expect(selected.background).not.toEqual(normal.background);
      await assertReadable(count, `${state} selected count`);
      // Hover an unselected row: selection must not mask hover defects.
      await input.press("ArrowDown");
      await expect(option).toHaveAttribute("aria-selected", "false");
      await option.hover();
      await settleColors(page);
      await assertReadable(name, `${state} hover label`);
      await assertReadable(count, `${state} hover count`);
      const bounds = await option.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(pageErrors).toEqual([]);
    });
  }
}

test("tags the UI never had a picker for are visible and survive a save", async ({
  page,
}) => {
  const sent = await stubApi(page);
  const input = await openPublishSheet(page);

  // Visible first: a tag you cannot see is one you cannot knowingly keep.
  for (const tag of UNKNOWN_TAGS) {
    await expect(
      page.getByRole("button", { name: `Remove tag ${tag}` }),
    ).toBeVisible();
  }

  // An edit that has nothing to do with tags.
  await input.fill("");
  await page
    .getByLabel(/subtitle|description/i)
    .first()
    .fill("A subtitle.");

  await expect
    .poll(() => lastSavedTags(sent), { timeout: 30_000 })
    .toEqual([...UNKNOWN_TAGS, "ART"]);
});

test("a creator can add a tag that is in no predefined list", async ({
  page,
}) => {
  const sent = await stubApi(page);
  const input = await openPublishSheet(page);

  await input.fill("quantum knitting");
  await input.press("Enter");

  await expect
    .poll(() => lastSavedTags(sent), { timeout: 30_000 })
    .toEqual([...UNKNOWN_TAGS, "ART", "quantum knitting"]);
});

test("a comma commits a tag, so pasting a list works", async ({ page }) => {
  const sent = await stubApi(page);
  const input = await openPublishSheet(page);

  await input.fill("halo2 recursion,");

  await expect
    .poll(() => lastSavedTags(sent), { timeout: 30_000 })
    .toEqual([...UNKNOWN_TAGS, "ART", "halo2 recursion"]);
});

test("pasting a long list keeps every tag, not the first 100 characters", async ({
  page,
}) => {
  // The input carries no `maxlength`: 100 characters is a limit on ONE tag,
  // and an aggregate DOM limit would have the browser chop a paste before any
  // of this code ran — tail tags gone, last one truncated, both saved.
  const sent = await stubApi(page);
  const input = await openPublishSheet(page);

  const pasted = [
    "distributed systems reading notes",
    "shielded pool accounting",
    "recursive proof composition",
    "long tail discovery",
  ];
  expect(pasted.join(", ").length).toBeGreaterThan(100);

  await input.fill(`${pasted.join(", ")},`);

  await expect
    .poll(() => lastSavedTags(sent), { timeout: 30_000 })
    .toEqual([...UNKNOWN_TAGS, "ART", ...pasted]);
});

test("a tag can be removed, which the closed picker could not do either", async ({
  page,
}) => {
  const sent = await stubApi(page);
  await openPublishSheet(page);

  await page.getByRole("button", { name: "Remove tag café-culture" }).click();

  await expect
    .poll(() => lastSavedTags(sent), { timeout: 30_000 })
    .toEqual(["zebra husbandry", "ART"]);
});

test("a typed tag adopts the spelling the platform already uses", async ({
  page,
}) => {
  // The free half of normalization: no AI, no destructive case-folding of what
  // the creator typed, and `zcash` stops fraying into `ZCASh` on its own.
  const sent = await stubApi(page);
  const input = await openPublishSheet(page);

  await input.fill("ZCASh");
  // Wait for the corpus to arrive, the way a creator does by pausing: the
  // suggestion lookup is debounced, and a snap can only use what it has.
  await expect(page.getByRole("option", { name: /zcash/ })).toBeVisible();
  await input.press("Enter");

  await expect
    .poll(() => lastSavedTags(sent), { timeout: 30_000 })
    .toEqual([...UNKNOWN_TAGS, "ART", "zcash"]);
});
