import { expect, test, type Page } from "@playwright/test";
import { browserMockApiOrigin } from "./ports";
test.describe.configure({ timeout: 90000 });
const initial = "Before selected after";
async function setup(page: Page, ext: string, mime: string, access = "public") {
  const owner = {
    id: 1274,
    username: "caption-owner",
    full_name: "Media Owner",
  };
  const url = `/uploadz/public/media-owner/fixture.${ext}`;
  let item = {
    id: 7,
    url: access === "public" ? url : `/uploadz/media-owner/fixture.${ext}`,
    name: `fixture.${ext}`,
    mime_type: mime,
    access,
  };
  let content = initial;
  let published = false;
  const saves: string[] = [];
  const patches: unknown[] = [];
  const article = () => ({
    id: 1274,
    free2zaddr: "media-fixture",
    title: "Media insertion",
    description: "",
    content,
    creator: owner,
    tags: [],
    category: "TECHNOLOGY",
    is_published: published,
    variant_is_published: published,
    vanity: "media-fixture",
    is_subscriber_only: false,
    source_language: "en",
    requested_language: "en",
    actual_language: "en",
    available_languages: ["en"],
    updated_at: "2026-10-01T00:00:00Z",
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/user/") return route.fulfill({ json: owner });
      if (path === "/api/zpage/media-fixture/") {
        if (route.request().method() === "PUT") {
          const payload = route.request().postDataJSON();
          content = payload.content;
          published = Boolean(payload.is_published);
          saves.push(content);
          await fetch(`${browserMockApiOrigin()}/__caption-fixture`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...article(),
              featured_image: {},
              comments: [],
              total: "0",
              f2z_score: "0",
              get_url: "/caption-owner/media-fixture",
            }),
          });
        }
        return route.fulfill({ json: article() });
      }
      if (path === "/api/zpage/media-fixture/variants/en/")
        return route.fulfill({
          json: article(),
          headers: { ETag: '"fixture-v1"' },
        });
      if (path.endsWith("/variants/"))
        return route.fulfill({
          json: [{ language: "en", origin: "source", is_published: false }],
        });
      if (path === "/api/uploads/limits/")
        return route.fulfill({ json: { max_bytes: 5000000, tiers: [] } });
      if (path === "/api/myuploads/7/") {
        if (route.request().method() === "PATCH") {
          patches.push(route.request().postDataJSON());
          item = { ...item, access: "public", url };
        }
        return route.fulfill({ json: item });
      }
      if (path === "/api/myuploads/")
        return route.fulfill({
          json: {
            results: [
              item,
              {
                ...item,
                id: 8,
                name: "wrong.png",
                mime_type: "image/png",
                url: "/uploadz/public/media-owner/wrong.png",
              },
            ],
            next: null,
          },
        });
      return route.fulfill({ json: { results: [], count: 0 } });
    },
  );
  await page.route("**/uploads/single-public", (route) =>
    route.fulfill({ status: 201, json: { ...item, access: "public" } }),
  );
  await page.goto("/edit?id=media-fixture");
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toHaveValue(initial, { timeout: 60000 });
  return { body, url, saves, patches, isPublished: () => published };
}
async function chooseAction(page: Page, name: string) {
  await page
    .locator("textarea.writing-area-textarea")
    .evaluate((element: HTMLTextAreaElement) => {
      element.focus();
      element.setSelectionRange(7, 15);
      element.dispatchEvent(new Event("select", { bubbles: true }));
    });
  await page.getByTestId("editor-insert-trigger").click();
  await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
async function contained(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width + 1,
  );
}
for (const width of [390, 1280])
  for (const [kind, ext, mime] of [
    ["Document", "pdf", "application/pdf"],
    ["Video", "mp4", "video/mp4"],
  ])
    for (const source of ["device", "cloud"]) {
      test(`${kind} ${source} replaces selection and saves real preview at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        const { body, url, saves } = await setup(page, ext, mime);
        if (width === 1280)
          await page
            .getByRole("button", { name: "Split", exact: true })
            .last()
            .click();
        await chooseAction(page, kind);
        await contained(page, '[role="dialog"]');
        if (source === "device") {
          await page
            .locator('input[type="file"]')
            .last()
            .setInputFiles({
              name: `fixture.${ext}`,
              mimeType: mime,
              buffer: Buffer.from("mock upload bytes"),
            });
          await page.getByRole("button", { name: "Insert Selected" }).click();
        } else {
          await page.getByRole("tab", { name: "Your Cloud" }).click();
          await expect(
            page.getByRole("button", { name: /wrong.png/ }),
          ).toHaveCount(0);
          await page.getByRole("button", { name: /fixture/ }).click();
        }
        const expected = `Before \n\n::embed[${url}]\n\n after`;
        await expect(body).toHaveValue(expected);
        await expect
          .poll(() => saves.at(-1), { timeout: 15000 })
          .toBe(expected);
        await page
          .getByRole("button", { name: "Preview", exact: true })
          .last()
          .click();
        if (kind === "Document") {
          await expect(
            page.locator(`.first-party-embed-pdf a[href="${url}"]`),
          ).toBeVisible();
          await contained(page, ".first-party-embed-pdf");
        } else {
          await expect(page.locator(`video source[src="${url}"]`)).toHaveCount(
            1,
          );
          await expect(page.locator("video")).toBeVisible();
          await contained(page, "video");
        }
      });
    }
test("private Cloud PDF requires explicit consent", async ({ page }) => {
  const { body, patches } = await setup(
    page,
    "pdf",
    "application/pdf",
    "private",
  );
  await chooseAction(page, "Document");
  await page.getByRole("tab", { name: "Your Cloud" }).click();
  await page.getByRole("button", { name: /fixture/ }).click();
  await expect(page.locator("[data-media-access-gate]")).toBeVisible();
  expect(patches).toEqual([]);
  await expect(body).toHaveValue(initial);
  await page.locator('[data-media-access-gate-action="cancel"]').click();
  await page.getByRole("button", { name: /fixture/ }).click();
  await page.locator('[data-media-access-gate-action="promote"]').click();
  await expect(body).toHaveValue(
    "Before \n\n::embed[/uploadz/public/media-owner/fixture.pdf]\n\n after",
  );
  expect(patches).toHaveLength(1);
});
test("Embed link rejects unsafe schemes without editing", async ({ page }) => {
  const { body } = await setup(page, "pdf", "application/pdf");
  await chooseAction(page, "Embed link");
  await page.getByLabel("URL", { exact: true }).fill("javascript:alert(1)");
  await page.getByRole("button", { name: "Insert embed", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("HTTP");
  await expect(body).toHaveValue(initial);
  await page
    .getByLabel("URL", { exact: true })
    .fill("https://example.org/watch");
  await page.getByRole("button", { name: "Insert embed", exact: true }).click();
  await expect(body).toHaveValue(
    "Before \n\n::embed[https://example.org/watch]\n\n after",
  );
  await page
    .getByRole("button", { name: "Preview", exact: true })
    .last()
    .click();
  await expect(page.getByText(/example.org/).first()).toBeVisible();
});

test("upload failure can retry, and cancellation never saves a placeholder", async ({
  page,
}) => {
  const { body, url, saves } = await setup(page, "pdf", "application/pdf");
  await page.route("**/uploads/single-public", (route) =>
    route.fulfill({ status: 500, body: "failed" }),
  );
  await chooseAction(page, "Document");
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: "fixture.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("fixture"),
    });
  await page.getByRole("button", { name: "Insert Selected" }).click();
  await expect(page.getByRole("alert")).toContainText("failed");
  await expect(body).toHaveValue(initial);
  expect(saves.every((value) => !value.includes("upload-"))).toBe(true);
  await page.route("**/uploads/single-public", (route) =>
    route.fulfill({
      status: 201,
      json: { id: 7, url, mime_type: "application/pdf" },
    }),
  );
  await page.getByRole("button", { name: "Insert Selected" }).click();
  await expect(body).toHaveValue(`Before \n\n::embed[${url}]\n\n after`);
  await chooseAction(page, "Document");
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: "fixture.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("fixture"),
    });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/uploads/single-public", async (route) => {
    await held;
    await route
      .fulfill({
        status: 201,
        json: { id: 7, url, mime_type: "application/pdf" },
      })
      .catch(() => {});
  });
  await page.getByRole("button", { name: "Insert Selected" }).click();
  await expect(
    page.getByRole("button", { name: "Cancel upload" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel upload" }).click();
  release();
  await expect(
    page.getByRole("button", { name: "Insert Selected" }),
  ).toBeEnabled();
  await expect(body).toHaveValue(`Before \n\n::embed[${url}]\n\n after`);
});

test("Audio device upload uses the native preview player", async ({ page }) => {
  const { body, url } = await setup(page, "mp3", "audio/mpeg");
  await chooseAction(page, "Audio");
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: "fixture.mp3",
      mimeType: "audio/mpeg",
      buffer: Buffer.from("fixture"),
    });
  await page.getByRole("button", { name: "Insert Selected" }).click();
  await expect(body).toHaveValue(`Before \n\n::embed[${url}]\n\n after`);
  await page
    .getByRole("button", { name: "Preview", exact: true })
    .last()
    .click();
  await expect(page.locator("audio")).toBeVisible();
});

test("image details edit alt and caption, cancel and remove", async ({
  page,
}) => {
  const { body } = await setup(page, "png", "image/png");
  await body.fill('![old](/uploadz/public/media-owner/fixture.png "title")');
  await body.evaluate((element: HTMLTextAreaElement) => {
    element.focus();
    element.setSelectionRange(4, 4);
  });
  await page.getByRole("button", { name: "Edit image at cursor" }).click();
  await expect(
    page.getByRole("dialog", { name: "Image details" }),
  ).toBeVisible();
  await page.getByLabel("Alt text (image description)").fill("A bird");
  await page.getByLabel("Visible caption").fill("雪\nA caption");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(body).toHaveValue(
    '![old](/uploadz/public/media-owner/fixture.png "title")',
  );
  await page.getByRole("button", { name: "Edit image at cursor" }).click();
  await page.getByLabel("Alt text (image description)").fill("A bird");
  await page.getByLabel("Visible caption").fill("雪\nA caption");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(body).toHaveValue(
    '![A bird](/uploadz/public/media-owner/fixture.png "title")\n::caption["雪\\nA caption"]',
  );
  await body.evaluate((element: HTMLTextAreaElement) => {
    element.focus();
    element.setSelectionRange(3, 3);
  });
  await page.getByRole("button", { name: "Edit image at cursor" }).click();
  await page.getByLabel("Visible caption").fill("");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(body).toHaveValue(
    '![A bird](/uploadz/public/media-owner/fixture.png "title")',
  );
});

test("cloud image collects separate alt and caption before insertion", async ({
  page,
}) => {
  const { body } = await setup(page, "png", "image/png");
  await chooseAction(page, "Image");
  await page.getByRole("tab", { name: "Your Cloud" }).click();
  await page.getByRole("button", { name: /fixture.png/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Image details" }),
  ).toBeVisible();
  await page.getByLabel("Alt text (image description)").fill("A bird");
  await page.getByLabel("Visible caption").fill("雪\ncaption");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(body).toHaveValue(/!\[A bird\].*::caption\["雪\\ncaption"\]/s);
});

test("upload details can be cancelled or inserted with a visible caption", async ({
  page,
}) => {
  const { body, saves, isPublished } = await setup(page, "png", "image/png");
  await chooseAction(page, "Image");
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({
      name: "fixture.png",
      mimeType: "image/png",
      buffer: Buffer.from("fixture"),
    });
  await page.getByRole("button", { name: "Insert Selected" }).click();
  await expect(
    page.getByRole("dialog", { name: "Image details" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel", exact: true })
    .last()
    .click();
  await expect(body).toHaveValue(initial);
  await page.getByRole("button", { name: "Insert Selected" }).click();
  await page.getByLabel("Alt text (image description)").fill("Bird");
  await page.getByLabel("Visible caption").fill("雪\n<script>unsafe</script>");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(body).toHaveValue(
    /!\[Bird\].*::caption\["雪\\n<script>unsafe<\/script>"\]/s,
  );
  const exact = (await body.inputValue()).replace(
    "fixture.png)",
    'fixture.png "Original title")',
  );
  await body.fill(exact);
  await expect.poll(() => saves.at(-1), { timeout: 15000 }).toBe(exact);
  await page.reload();
  await expect(body).toHaveValue(exact);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish Now" }).click();
  await expect.poll(() => isPublished()).toBe(true);
  await page.goto("/caption-owner/media-fixture");
  await expect(
    page.locator('figure img[alt="Bird"][title="Original title"]'),
  ).toHaveCount(1);
  await expect(page.locator("figcaption")).toHaveText(
    "雪<script>unsafe</script>",
  );
  await expect(page.locator("figcaption script")).toHaveCount(0);
  await page.goto("/edit?id=media-fixture");
  await page
    .getByRole("button", { name: "Preview", exact: true })
    .last()
    .click();
  await expect(page.locator("figcaption")).toHaveText(
    "雪<script>unsafe</script>",
  );
  await expect(page.locator("figcaption script")).toHaveCount(0);
  await expect(page.locator('figure img[alt="Bird"]')).toHaveCount(1);
});
