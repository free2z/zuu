import { expect, test, type Page } from "@playwright/test";

/**
 * A non-Latin title never breaks saving (prod ).
 *
 * The editor used to auto-fill the vanity by slugifying the title with every
 * script's letters kept, the API only accepts ASCII vanities, and so every
 * autosave of an Arabic or Korean draft was refused -- silently, because an
 * autosave failure only shows up in a tooltip -- until the creator found the
 * publish sheet and typed an ASCII slug by hand.
 *
 * The mock API applies the real `validate_vanity` rules that matter here: a
 * non-ASCII letter is a 400 with the server's own sentence, and so is a
 * reserved name.
 */

// The first test after a cold `vite dev` start compiles the whole /edit
// module graph on demand; leave room for that boot.
test.setTimeout(120_000);

const CREATOR = {
  id: 8178,
  username: "vanity-derivation-user",
  full_name: "Vanity Derivation User",
};

const ASCII_ONLY =
  "Vanity URLs can only use the letters a-z, numbers and hyphens.";
const RESERVED = "Vanity is a system reserved name, please choose another!";
const RESERVED_VANITIES = new Set(["dashboard", "private", "zpage"]);
const NOT_UNIQUE = "Vanity is not unique!";
const TAKEN_VANITIES = new Set(["taken-title"]);

type Payload = Record<string, unknown> & { vanity?: string; title?: string };

function created(payload: Payload) {
  return {
    id: 2178,
    free2zaddr: "vanity-derivation-fixture",
    vanity: payload.vanity || null,
    title: payload.title || "",
    description: "",
    canonical_url: "",
    content: payload.content || "",
    tags: [],
    p2paddr: "",
    featured_image: null,
    is_published: false,
    is_subscriber_only: false,
    publish_at: null,
    creator: CREATOR,
    source_language: "en",
    actual_language: "en",
    requested_language: "en",
    available_languages: ["en"],
    variant_is_published: false,
    created_at: "2026-09-26T00:00:00Z",
    updated_at: "2026-09-26T00:00:00Z",
  };
}

async function openNewEditor(
  page: Page,
  {
    clock = false,
    holdFirstWrite = false,
    holdPublishWrite = false,
    generateFallbackOnPublish = false,
  } = {},
) {
  if (clock) await page.clock.install();
  const writes: { method: string; payload: Payload; status: number }[] = [];
  let firstWriteArrived: () => void = () => {};
  const firstWriteSeen = new Promise<void>((resolve) => {
    firstWriteArrived = resolve;
  });
  let releaseFirstWrite: () => void = () => {};
  const firstWriteReleased = holdFirstWrite
    ? new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      })
    : Promise.resolve();
  let publishWriteArrived: () => void = () => {};
  const publishWriteSeen = new Promise<void>((resolve) => {
    publishWriteArrived = resolve;
  });
  let releasePublishWrite: () => void = () => {};
  const publishWriteReleased = holdPublishWrite
    ? new Promise<void>((resolve) => {
        releasePublishWrite = resolve;
      })
    : Promise.resolve();

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());

      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
        return;
      }

      const isCreate =
        pathname === "/api/zpage/" && request.method() === "POST";
      const isUpdate =
        pathname === "/api/zpage/vanity-derivation-fixture/" &&
        request.method() === "PUT";
      if (isCreate || isUpdate) {
        const payload = JSON.parse(request.postData() || "{}") as Payload;
        const vanity = payload.vanity || "";
        let error: string | null = null;
        if (/[^\p{ASCII}]/u.test(vanity)) error = ASCII_ONLY;
        else if (RESERVED_VANITIES.has(vanity)) error = RESERVED;
        else if (TAKEN_VANITIES.has(vanity)) error = NOT_UNIQUE;
        const status = error ? 400 : isCreate ? 201 : 200;
        const isFirst = writes.length === 0;
        const isPublishWrite =
          request.method() === "PUT" && payload.is_published === true;
        writes.push({ method: request.method(), payload, status });
        if (isFirst) {
          firstWriteArrived();
          await firstWriteReleased;
        }
        if (isPublishWrite && holdPublishWrite) {
          publishWriteArrived();
          await publishWriteReleased;
        }
        const responseBody = created(payload);
        if (isPublishWrite && generateFallbackOnPublish && !vanity) {
          responseBody.vanity = "p-server-generated";
          responseBody.is_published = true;
          responseBody.variant_is_published = true;
        }
        await route.fulfill(
          error
            ? { status, json: { vanity: [error] } }
            : { status, json: responseBody },
        );
        return;
      }

      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  await page.goto("/edit");
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toBeVisible({ timeout: 30_000 });
  const title = page.locator("textarea").first();
  return {
    body,
    title,
    writes,
    firstWriteSeen,
    releaseFirstWrite: () => releaseFirstWrite(),
    publishWriteSeen,
    releasePublishWrite: () => releasePublishWrite(),
  };
}

for (const [script, heading, expectedVanity] of [
  ["Arabic", "مرحبا بالعالم", ""],
  ["Korean", "한국어 요약", ""],
  ["mixed Arabic and Latin", "ملخص نظام Zcash البيئي", "zcash"],
] as const) {
  test(`a ${script} title autosaves on the first try`, async ({ page }) => {
    const { body, title, writes } = await openNewEditor(page);

    await title.fill(heading);
    await body.fill("The first paragraph.");

    await expect.poll(() => writes.length, { timeout: 15_000 }).toBe(1);
    expect(writes[0].payload.vanity).toBe(expectedVanity);
    expect(writes[0].status).toBe(201);
    await expect(page.getByText(ASCII_ONLY)).toHaveCount(0);
  });
}

test("a derived vanity the API refuses is dropped, and the draft still saves", async ({
  page,
}) => {
  const { body, title, writes } = await openNewEditor(page);

  // "Dashboard" derives `dashboard`, which is reserved. That is the editor's
  // guess failing, not the creator's input: it must not block the save.
  await title.fill("Dashboard");
  await body.fill("A post about dashboards.");

  await expect.poll(() => writes.length, { timeout: 20_000 }).toBe(2);
  expect(writes[0]).toMatchObject({
    payload: { vanity: "dashboard" },
    status: 400,
  });
  expect(writes[1]).toMatchObject({ payload: { vanity: "" }, status: 201 });
  await expect(page.getByText(RESERVED)).toHaveCount(0);

  // Editing the title again must not re-propose the refused guess.
  await title.fill("Dashboard!");
  await body.fill("A post about dashboards, revised.");
  await expect.poll(() => writes.length, { timeout: 15_000 }).toBe(3);
  expect(writes[2]).toMatchObject({ payload: { vanity: "" }, status: 200 });
});

test("a vanity the creator typed is refused visibly, not rewritten", async ({
  page,
}) => {
  const { body, title, writes } = await openNewEditor(page);

  await title.fill("Hello World");
  await body.fill("The first paragraph.");
  await expect.poll(() => writes.length, { timeout: 15_000 }).toBe(1);
  expect(writes[0]).toMatchObject({
    payload: { vanity: "hello-world" },
    status: 201,
  });

  await page.getByRole("button", { name: "Publish" }).click();
  const vanityInput = page.locator("#vanity");
  await vanityInput.fill("مرحبا");

  // The autosave is refused and the refusal is sent as typed -- the editor
  // does not "fix" it -- and the server's reason is on screen: in the field,
  // and in a toast, because the publish sheet is usually closed while the
  // creator writes.
  await expect
    .poll(() => writes.filter((w) => w.status === 400).length, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(1);
  expect(writes.find((w) => w.status === 400)?.payload.vanity).toBe("مرحبا");
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: ASCII_ONLY }),
  ).toBeVisible();
  await expect(vanityInput).toHaveAttribute("aria-invalid", "true");
});

test("a proposal the creator retyped is theirs: its refusal is shown, not dropped", async ({
  page,
}) => {
  // The clock is held so no autosave leaves before the creator has edited the
  // vanity field (codex review of: equality with the proposal is not
  // proof the editor chose it).
  const { body, title, writes } = await openNewEditor(page, { clock: true });

  await title.fill("Taken Title");
  await body.fill("The first paragraph.");
  await page.getByRole("button", { name: "Publish" }).click();
  const vanityInput = page.locator("#vanity");
  await expect(vanityInput).toHaveValue("taken-title");
  // Edit away from the proposal and type it back by hand.
  await vanityInput.fill("taken-titl");
  await vanityInput.fill("taken-title");

  await page.clock.runFor(10_000);
  await expect.poll(() => writes.length, { timeout: 15_000 }).toBe(1);
  expect(writes[0]).toMatchObject({
    payload: { vanity: "taken-title" },
    status: 400,
  });
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: NOT_UNIQUE }),
  ).toBeVisible();
  await expect(vanityInput).toHaveValue("taken-title");

  // Nothing retried behind the creator's back with the vanity stripped.
  await page.clock.runFor(10_000);
  expect(writes.every((w) => w.payload.vanity === "taken-title")).toBe(true);
});

test("a vanity the creator retypes while the guess is in flight is kept", async ({
  page,
}) => {
  // codex review of, round 2: the refusal of the editor's guess arrives
  // AFTER the creator has taken the field over. What they typed must not be
  // cleared just because it reads the same as the refused guess.
  const { body, title, writes, firstWriteSeen, releaseFirstWrite } =
    await openNewEditor(page, { holdFirstWrite: true });

  await title.fill("Taken Title");
  await body.fill("The first paragraph.");
  await firstWriteSeen;
  expect(writes[0].payload.vanity).toBe("taken-title");

  await page.getByRole("button", { name: "Publish" }).click();
  const vanityInput = page.locator("#vanity");
  await vanityInput.fill("taken-titl");
  await vanityInput.fill("taken-title");
  releaseFirstWrite();

  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: NOT_UNIQUE }),
  ).toBeVisible();
  await expect(vanityInput).toHaveValue("taken-title");
  expect(writes.every((w) => w.payload.vanity === "taken-title")).toBe(true);
});

test("a server vanity survives unrelated edits made while publish is in flight", async ({
  page,
}) => {
  const { body, title, writes, publishWriteSeen, releasePublishWrite } =
    await openNewEditor(page, {
      clock: true,
      holdPublishWrite: true,
      generateFallbackOnPublish: true,
    });

  await body.fill("The first paragraph.");
  await page.clock.runFor(5_000);
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    method: "POST",
    payload: { vanity: "" },
  });

  await title.fill("한국어 요약");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish Now" }).click();
  await publishWriteSeen;
  expect(writes[1].payload).toMatchObject({
    vanity: "",
    is_published: true,
  });

  // The publish sheet stays open while the request is held; changing the
  // description is an unrelated edit that requires a follow-up autosave.
  await page
    .getByLabel(/subtitle|description/i)
    .first()
    .fill("A subtitle.");
  releasePublishWrite();

  const vanityInput = page.locator("#vanity");
  await expect(vanityInput).toHaveValue("p-server-generated");
  await page.clock.runFor(10_000);
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2].payload).toMatchObject({
    vanity: "p-server-generated",
    description: "A subtitle.",
  });
});

test("a vanity the creator edits during publish wins over the server fallback", async ({
  page,
}) => {
  const { body, title, writes, publishWriteSeen, releasePublishWrite } =
    await openNewEditor(page, {
      clock: true,
      holdPublishWrite: true,
      generateFallbackOnPublish: true,
    });

  await body.fill("The first paragraph.");
  await page.clock.runFor(5_000);
  await expect.poll(() => writes.length).toBe(1);

  await title.fill("한국어 요약");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish Now" }).click();
  await publishWriteSeen;

  const vanityInput = page.locator("#vanity");
  await vanityInput.fill("creator-chosen");
  releasePublishWrite();

  await expect(vanityInput).toHaveValue("creator-chosen");
  await page.clock.runFor(10_000);
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2].payload.vanity).toBe("creator-chosen");
});
