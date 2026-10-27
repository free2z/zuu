import { expect, test, type Page } from "@playwright/test";

/**
 *  the media dashboard rejected PDFs in the browser, before any request
 * was made, with "That file is not a supported image or MP4 video". The server
 * had accepted `application/pdf` since.
 *
 * The regression was invisible to every existing test because the failure
 * happened *client-side*: no request, no server log, nothing to assert on. So
 * these tests assert on the two things that actually broke — a request leaves
 * the browser, and the resulting row renders as a usable document card — rather
 * than on a re-implementation of the gate.
 *
 * The gate module itself is pulled out of the Vite dev module graph, so this
 * exercises the code the app ships.
 */

const FIXTURE_USER = "pdffixture";
const MEDIA_URL = `/${FIXTURE_USER}/dashboard/media`;

// A minimal but honest PDF: `%PDF` at offset 0 is the whole signature, which is
// all `sniff_media_type()` looks at. Mirrors the `PDF` fixture in
// py/dj/apps/uploads/test_upload_type_allowlist.py.
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

const PDF_ROW = {
  id: 501,
  url: "/uploadz/private/pdffixture/w-9-form.pdf",
  name: "pdffixture/w-9-form.pdf",
  // The server returns null here for anything that is not an image — this is
  // the field whose truthiness used to decide whether an <img> was rendered.
  thumbnail: null,
  thumb: null,
  card: null,
  banner: null,
  variants: [],
  title: "W-9 form",
  description: "",
  mime_type: "application/pdf",
  access: "private",
  created_at: "2026-08-14T10:00:00Z",
  updated_at: "2026-08-14T10:00:00Z",
};

const IMAGE_ROW = {
  ...PDF_ROW,
  id: 502,
  url: "/uploadz/public/pdffixture/cat.png",
  name: "pdffixture/cat.png",
  thumbnail: "/uploadz/public/pdffixture/cat.png",
  title: "Cat",
  mime_type: "image/png",
  access: "public",
  created_at: "2026-08-13T10:00:00Z",
};

type Seen = { url: string; method: string; hasFile: boolean; body: string };

/**
 * What `GenericFile._get_prefix()` does: the URL is DERIVED from the access
 * level, `/uploadz/public/` for public and `/uploadz/` for everything else.
 * The mock reproduces that so a test can prove the client takes the server's
 * URL back rather than assuming an access flip leaves the link alone.
 */
const urlForAccess = (name: string, access: string) =>
  access === "public" ? `/uploadz/public/${name}` : `/uploadz/${name}`;

async function mockMediaApi(page: Page) {
  const seen: Seen[] = [];
  let rows = [PDF_ROW, IMAGE_ROW];

  await page.route(
    (url) => url.pathname.startsWith("/uploadz/"),
    (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-length": String(PDF_BYTES.byteLength) },
        contentType: "application/pdf",
        body: PDF_BYTES,
      }),
  );

  await page.route(
    (url) =>
      url.pathname.startsWith("/api/myuploads") ||
      url.pathname.startsWith("/uploads/handle"),
    async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      seen.push({
        url: request.url(),
        method: request.method(),
        hasFile: body.includes("%PDF-1.4"),
        body,
      });

      if (request.method() === "PATCH") {
        const id = Number(request.url().match(/myuploads\/(\d+)/)?.[1]);
        const patch = JSON.parse(body || "{}");
        rows = rows.map((row) =>
          row.id === id
            ? {
                ...row,
                ...patch,
                url: urlForAccess(row.name, patch.access ?? row.access),
              }
            : row,
        );
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(rows.find((row) => row.id === id)),
        });
        return;
      }
      if (request.method() === "POST") {
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify([PDF_ROW]),
        });
        return;
      }
      if (request.method() === "DELETE") {
        const id = Number(request.url().match(/myuploads\/(\d+)/)?.[1]);
        rows = rows.filter((row) => row.id !== id);
        await route.fulfill({ status: 204, body: "" });
        return;
      }

      const params = new URL(request.url()).searchParams;
      const mime = params.get("mime_type");
      const access = params.get("access");
      // `GenericFileFilter`: mime_type is `istartswith`, access is exact.
      const results = rows
        .filter((row) => !mime || row.mime_type.startsWith(mime))
        .filter((row) => !access || row.access === access);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ count: results.length, next: null, results }),
      });
    },
  );

  return seen;
}

const documentCard = (page: Page) =>
  page.locator('article:has([data-media-kind="document"])');

const publicCard = (page: Page) =>
  page.locator('article:has([data-media-access="public"])');

/**
 * `goto` resolves on `load`, which is BEFORE SvelteKit hydrates — and the file
 * input is server-rendered, so `setInputFiles` on a freshly loaded page
 * silently sets files on an element whose `change` handler does not exist yet.
 * The library fetch happens in `onMount`, i.e. strictly after hydration, so
 * waiting for it is the honest signal that the page is live.
 */
async function gotoMedia(page: Page) {
  const loaded = page.waitForResponse((r) =>
    r.url().includes("/api/myuploads"),
  );
  await page.goto(MEDIA_URL);
  await loaded;
  await expect(page.locator("#file-input")).toBeAttached();
}

test("the client gate is the server's list, and it takes a PDF (#1177)", async ({
  page,
}) => {
  await page.goto("/");

  const gate = await page.evaluate(async () => {
    // Indirect so TypeScript treats this as a runtime path: the module is
    // served by the Vite dev server, not resolvable from tsconfig.
    const path = "/src/lib/components/media/supportedUploadTypes.ts";
    const mod: any = await import(/* @vite-ignore */ path);
    return {
      supported: mod.SUPPORTED_UPLOAD_MIME_TYPES,
      accept: mod.UPLOAD_ACCEPT_ATTRIBUTE,
      pdf: mod.isSupportedUploadType("application/pdf"),
      pdfAlias: mod.isSupportedUploadType("application/x-pdf"),
      heicNoType: mod.isSupportedUploadType(""),
      mp3Alias: mod.isSupportedUploadType("audio/mp3"),
      html: mod.isSupportedUploadType("text/html"),
      svg: mod.isSupportedUploadType("image/svg+xml"),
      zip: mod.isSupportedUploadType("application/zip"),
      kind: mod.mediaKind("application/pdf", "w9.pdf"),
      label: mod.documentLabel("application/pdf", "pdffixture/w-9-form.pdf"),
    };
  });

  // The bug, inverted: what the browser refused to send is now accepted.
  expect(gate.pdf).toBe(true);
  expect(gate.pdfAlias).toBe(true);
  expect(gate.supported).toContain("application/pdf");
  expect(gate.accept).toContain("application/pdf");
  // Widened for the media families (codex finding 2): the OS matches `accept`
  // against its own extension table, which calls a `.heif` `image/heif` and a
  // `.opus` `audio/opus`. Listing only canonical types hides those in the
  // picker. `application/*` stays exact — it would mean "any file".
  expect(gate.accept).toContain("image/*");
  expect(gate.accept).toContain("audio/*");
  expect(gate.accept).toContain("video/*");
  expect(gate.accept).not.toContain("application/*");

  //...and the other nine types the client used to drop on the floor. A floor,
  // not an exact count: two PRs that each add a type would each commit 15,
  // merge cleanly, and leave main red at 16.
  expect(gate.supported.length).toBeGreaterThanOrEqual(14);
  expect(gate.supported).toEqual(
    expect.arrayContaining([
      "image/heic",
      "image/avif",
      "audio/mpeg",
      "video/webm",
    ]),
  );
  // A browser that cannot identify the file (Chrome/Windows on a.heic) makes
  // no claim; the server sniffs the bytes, so the client must not pre-empt it.
  expect(gate.heicNoType).toBe(true);
  expect(gate.mp3Alias).toBe(true);

  // The  boundary is untouched: active documents are still refused, and so
  // is anything the server would 400 anyway.
  expect(gate.html).toBe(false);
  expect(gate.svg).toBe(false);
  expect(gate.zip).toBe(false);

  expect(gate.kind).toBe("document");
  expect(gate.label).toBe("PDF");
});

test("a PDF reaches the server instead of being refused in the browser", async ({
  page,
}) => {
  const seen = await mockMediaApi(page);
  await gotoMedia(page);

  await page.setInputFiles("#file-input", {
    name: "W-9 form.pdf",
    mimeType: "application/pdf",
    buffer: PDF_BYTES,
  });

  await expect
    .poll(() => seen.filter((r) => r.method === "POST").length)
    .toBe(1);
  const upload = seen.find((r) => r.method === "POST")!;
  expect(upload.url).toContain("/uploads/handle");
  // The whole regression in one assertion: the bytes left the browser.
  expect(upload.hasFile).toBe(true);

  // No "not a supported image or MP4 video" anywhere on the page.
  await expect(page.getByText(/supported image or MP4 video/i)).toHaveCount(0);
  await expect(page.getByText("W-9 form.pdf uploaded")).toBeVisible();
});

test("an unsupported file is still refused, with copy that names what works", async ({
  page,
}) => {
  const seen = await mockMediaApi(page);
  await gotoMedia(page);

  await page.setInputFiles("#file-input", {
    name: "evil.html",
    mimeType: "text/html",
    buffer: Buffer.from("<script>alert(1)</script>"),
  });

  await expect(
    page.getByText(/Images, video, audio and PDF documents are supported/i),
  ).toBeVisible();
  // Rejected client-side means no wasted upload — the server never sees it.
  expect(seen.filter((r) => r.method === "POST")).toHaveLength(0);
});

test("a PDF renders as a document card with every action working", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const seen = await mockMediaApi(page);
  await gotoMedia(page);

  const card = documentCard(page);
  await expect(card).toHaveCount(1);

  // The card says what the file IS — no broken <img>, no empty grey box.
  await expect(card.locator('[data-media-kind="document"]')).toContainText(
    "PDF",
  );
  await expect(card.locator("img")).toHaveCount(0);
  await expect(card).toContainText("W-9 form");
  await expect(card).toContainText("pdffixture/w-9-form.pdf");
  await expect(card).toContainText("Aug 14, 2026");
  // Size comes from a HEAD against the file itself.
  await expect(card).toContainText(String(PDF_BYTES.byteLength));
  // Access level: a `private` file 401s for anyone else, so "copy link" needs
  // to say so next to it.
  await expect(card.locator('[data-media-access="private"]')).toHaveText(
    "Private",
  );

  // Download: same-origin href (browsers ignore `download` cross-origin) and
  // the stored filename.
  const download = card.locator('[data-media-action="download"]');
  await expect(download).toHaveAttribute("href", PDF_ROW.url);
  await expect(download).toHaveAttribute("download", "w-9-form.pdf");
  // Not just "the attributes look right": actually click it and take the file.
  const [saved] = await Promise.all([
    page.waitForEvent("download"),
    download.click(),
  ]);
  expect(saved.suggestedFilename()).toBe("w-9-form.pdf");

  // Copy link puts the complete absolute URL on the clipboard, not a fragment,
  // and the toast says who that link works for rather than implying it is
  // shareable.
  await card.locator('[data-media-action="copy"]').click();
  await expect(
    page.getByText("Link copied — only you can open it"),
  ).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(`${new URL(page.url()).origin}${PDF_ROW.url}`);

  // There is NO Share on a private file: /uploadz/ 401s every recipient, so
  // the share sheet would hand out a link that cannot work. The affordance is
  // conditional, not removed — the public row alongside it still has one.
  await expect(card.locator('[data-media-action="share"]')).toHaveCount(0);
  await expect(
    publicCard(page).locator('[data-media-action="share"]'),
  ).toBeVisible();

  // Preview: a document opens the document state, and it must NOT embed the
  // uploaded bytes in the app origin  — download and open only.
  await card.locator("button[aria-label^='Preview']").click();
  const dialog = page.locator('[data-preview-kind="document"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("W-9 form");
  await expect(page.locator("iframe, object, embed")).toHaveCount(0);
  await expect(
    page.locator('[data-preview-action="download"]'),
  ).toHaveAttribute("href", PDF_ROW.url);
  await page.keyboard.press("Escape");

  // Delete: confirm, then the row is gone and the server was actually asked.
  await card.locator('[data-media-action="delete"]').click();
  await expect(page.getByText("Delete this file?")).toBeVisible();
  await page.locator('[data-media-action="confirm-delete"]').click();
  await expect
    .poll(() => seen.filter((r) => r.method === "DELETE").length)
    .toBe(1);
  await expect(documentCard(page)).toHaveCount(0);
});

test("a refused delete shows the server's reason, not a generic failure", async ({
  page,
}) => {
  // Codex review of, finding 1: `storytime.Page.image` is the one
  // CASCADE reference to GenericFile, so the server now 409s rather than
  // deleting a paid story page along with its illustration. Its `detail` names
  // what has to go first, and swallowing that would leave the user with a
  // button that does nothing and no next step.
  await page.route(
    (url) => url.pathname.startsWith("/uploadz/"),
    (route) => route.fulfill({ status: 200, body: "" }),
  );
  await page.route(
    (url) => url.pathname.startsWith("/api/myuploads"),
    async (route) => {
      if (route.request().method() === "DELETE") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            detail:
              "This file illustrates 1 story page. Delete that page first, " +
              "or the story content would be deleted with it.",
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ count: 1, next: null, results: [PDF_ROW] }),
      });
    },
  );

  await gotoMedia(page);
  await documentCard(page).locator('[data-media-action="delete"]').click();
  await page.locator('[data-media-action="confirm-delete"]').click();

  await expect(page.getByText(/illustrates 1 story page/)).toBeVisible();
  //...and the row is still there, because it was not deleted.
  await expect(documentCard(page)).toHaveCount(1);
});

test("the owner can change a file's access level from the library", async ({
  page,
}) => {
  const seen = await mockMediaApi(page);
  await gotoMedia(page);

  const card = documentCard(page);
  await expect(card.locator('[data-media-access="private"]')).toHaveText(
    "Private",
  );
  await expect(card.locator('[data-media-action="share"]')).toHaveCount(0);

  // A title-only edit must NOT replay `access`. Replaying the whole form
  // turns an unrelated save into a privacy write whenever the value on screen
  // is stale, and this endpoint has no precondition to catch that.
  await card.locator('[data-media-action="edit"]').click();
  await expect(page.getByText("Who can see this file?")).toBeVisible();
  await page.fill('[data-media-edit="title"]', "W-9 form (2026)");
  await expect(
    page.locator('[data-media-edit="access-change-note"]'),
  ).toHaveCount(0);
  await page.locator('[data-media-action="save-edit"]').click();

  const patches = () => seen.filter((r) => r.method === "PATCH");
  await expect.poll(() => patches().length).toBe(1);
  expect(JSON.parse(patches()[0].body)).toEqual({ title: "W-9 form (2026)" });

  // Now the access change itself.
  const listsBefore = seen.filter((r) => r.method === "GET").length;
  await card.locator('[data-media-action="edit"]').click();
  await page.selectOption('[data-media-edit="access"]', "public");
  await expect(
    page.locator('[data-media-edit="access-change-note"]'),
  ).toBeVisible();
  await page.locator('[data-media-action="save-edit"]').click();

  await expect.poll(() => patches().length).toBe(2);
  expect(JSON.parse(patches()[1].body)).toEqual({ access: "public" });

  // The row is replaced with the SERVER's object, so everything derived from
  // the access level follows: the badge, the share affordance, and the URL —
  // `_get_prefix()` moved it to /uploadz/public/, and a client that patched
  // only the access string locally would still be pointing at the old prefix.
  await expect(card.locator('[data-media-access="public"]')).toHaveText(
    "Public",
  );
  await expect(card.locator('[data-media-action="share"]')).toBeVisible();
  await expect(card.locator('[data-media-action="download"]')).toHaveAttribute(
    "href",
    "/uploadz/public/pdffixture/w-9-form.pdf",
  );
  //...and it happened without refetching the list, so the user's scroll
  // position and loaded pages survive the edit.
  expect(seen.filter((r) => r.method === "GET").length).toBe(listsBefore);
});

test("the access filter asks the server for one tier", async ({ page }) => {
  const seen = await mockMediaApi(page);
  await gotoMedia(page);
  await expect(page.locator("article")).toHaveCount(2);

  await page.selectOption("#media-access-filter", "public");
  await expect
    .poll(() => seen.some((r) => r.url.includes("access=public")))
    .toBe(true);
  await expect(page.locator("article")).toHaveCount(1);
  await expect(publicCard(page)).toHaveCount(1);

  // Clearing the filters clears this one too — otherwise the empty state
  // tells a creator their library is empty when only the filter is wrong.
  await page.selectOption("#media-access-filter", "members");
  await expect(page.locator("article")).toHaveCount(0);
  await expect(page.getByText("No matching files")).toBeVisible();
  await page.getByText("Clear filters").click();
  await expect(page.locator("article")).toHaveCount(2);
});

test("the Documents filter asks the server for the application/ prefix", async ({
  page,
}) => {
  const seen = await mockMediaApi(page);
  await gotoMedia(page);
  await expect(documentCard(page)).toHaveCount(1);

  await page.selectOption("#media-type-filter", "document");

  await expect
    .poll(() => seen.some((r) => r.url.includes("mime_type=application%2F")))
    .toBe(true);
  await expect(documentCard(page)).toHaveCount(1);
  // The image row is filtered out server-side, so only the PDF remains.
  await expect(page.locator("article")).toHaveCount(1);
});

test("the document card survives grid view, list view and a phone", async ({
  page,
}) => {
  await mockMediaApi(page);

  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ["grid", "list"] as const) {
      await gotoMedia(page);
      await page.click(
        `[aria-label="${mode === "grid" ? "Grid" : "List"} view"]`,
      );
      await expect(page.locator(`[data-view="${mode}"]`)).toBeVisible();

      const card = documentCard(page);
      await expect(card).toHaveCount(1);
      await expect(card.locator('[data-media-kind="document"]')).toBeVisible();
      // Actions are reachable without hovering — the list-view thumbnail is
      // only 112px wide on a phone and touch has no hover at all.
      await expect(
        card.locator('[data-media-action="download"]'),
      ).toBeVisible();
      await expect(card.locator('[data-media-action="delete"]')).toBeVisible();
      await expect(card.locator('[data-media-action="edit"]')).toBeVisible();

      // Two filter selects now share the control row. UI copy never truncates
      // (AGENTS.md), and a native select clips its selected option silently —
      // so each one must stay wide enough for its longest label ("Cualquier
      // acceso" is the worst case) and the row wraps instead of squeezing.
      for (const id of ["#media-type-filter", "#media-access-filter"]) {
        const box = await page.locator(id).boundingBox();
        expect(box, `${id} has no box`).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(140);
      }

      // Nothing may push the page sideways.
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    }
  }
});
