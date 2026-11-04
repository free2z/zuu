import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * A timed-out CREATE is retried under the same Idempotency-Key and yields
 * exactly one page  — but only against a backend that has PROVED it
 * honours the key.
 *
 * The server here does what the real one does with a key: it COMMITS the first
 * POST and then never answers it (the  case — the client gives up at its
 * bound, the server does not), replays that page for a retry with the same key
 * and the same body, and refuses the same key with a different body. So the
 * number of pages it holds at the end is the thing that goes wrong if the
 * editor re-sends without the key, with a fresh key, or with the draft it has
 * now instead of the body it sent the first time.
 *
 * The proof is `Idempotency-Key-Honored: true`, which the real backend puts on
 * every create answer. A hung create has no answer, so the proof has to come
 * from an EARLIER create this tab's session saw; `seedHonored` stands in for
 * that by writing the same sessionStorage marker such an answer writes. An
 * older backend (a rollback) ignores the key and never sends the header, and
 * there the editor must keep 's latch: every automatic retry would be
 * another page, published if the original was a Publish.
 *
 * `editor-save-timeout.spec.ts` keeps the keyless half: a browser that cannot
 * mint a key is still latched and never re-sends on its own.
 */

// The first test after a cold `vite dev` start compiles the whole /edit
// module graph on demand; leave room for that boot.
test.setTimeout(120_000);

/** Kept in sync with API_WRITE_TIMEOUT_MS in src/lib/api/request-timeout.js. */
const WRITE_BOUND_MS = 30_000;
/** AUTOSAVE_DELAY in src/routes/edit/+page.svelte. */
const AUTOSAVE_DELAY_MS = 2_500;
/** HONORED_STORAGE_KEY in src/lib/zpage-create-idempotency.js. */
const HONORED_STORAGE_KEY = "f2z.zpageCreateKeyHonored";

const CREATOR = {
  id: 8121,
  username: "idempotent-create-user",
  full_name: "Idempotent Create User",
};

const TIMED_OUT =
  "The server did not answer in time. Your changes are still here — try saving again.";
const CREATE_TIMED_OUT =
  "The server did not answer in time, and this new page may have been created anyway.";
const MAY_HAVE_DUPLICATED =
  "an earlier attempt that timed out may have made a second copy";

function pageFor(address: string, payload: Record<string, unknown>) {
  const language = (payload.source_language as string) || "en";
  return {
    id: 2079,
    free2zaddr: address,
    vanity: "",
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
    source_language: language,
    actual_language: language,
    requested_language: language,
    available_languages: [language],
    variant_is_published: false,
    created_at: "2026-09-23T00:00:00Z",
    updated_at: "2026-09-23T00:00:00Z",
  };
}

type Options = {
  /** The session saw the capability signal on an earlier create. */
  seedHonored: boolean;
  /**
   * Whether this backend honours the key: it sends the signal and replays.
   * `false` is an OLDER backend: no header, and every POST is a new page.
   */
  honorsKey: boolean;
  /** Answer the FIRST retry with this before the key is consulted. */
  turnAwayStatus?: number;
  /** The title typed before the first create. */
  title?: string;
  /** The vanity the server generates for a create that sent none. */
  generatedVanity?: string;
};

/**
 * Open a fresh editor whose first create commits and hangs. Returns the
 * recorded traffic and the "pages" the mock server holds.
 */
async function openWithHungCreate(page: Page, options: Options) {
  await page.clock.install();
  if (options.seedHonored) {
    await page.addInitScript((storageKey) => {
      sessionStorage.setItem(storageKey, "1");
    }, HONORED_STORAGE_KEY);
  }

  const posts: { key: string | null; body: string }[] = [];
  const puts: { url: string; body: Record<string, unknown> }[] = [];
  // Every page the server made, keyed by the key that made it (or a unique
  // name when the server ignored the key).
  const created = new Map<
    string,
    { body: string; page: ReturnType<typeof pageFor> }
  >();
  const hung: Route[] = [];
  const signal = options.honorsKey
    ? { "Idempotency-Key-Honored": "true" }
    : ({} as Record<string, string>);

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      const method = request.method();

      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
        return;
      }

      if (pathname === "/api/zpage/" && method === "POST") {
        const key = (await request.headerValue("idempotency-key")) ?? null;
        const body = request.postData() || "";
        posts.push({ key, body });
        const payload = JSON.parse(body || "{}");

        if (options.turnAwayStatus !== undefined && posts.length === 2) {
          await route.fulfill({
            status: options.turnAwayStatus,
            json: { detail: "Turned away before the view ran." },
          });
          return;
        }

        if (options.honorsKey && key && created.has(key)) {
          const original = created.get(key)!;
          if (original.body !== body) {
            await route.fulfill({
              status: 409,
              headers: signal,
              json: { code: "idempotency_mismatch", error: "mismatch" },
            });
            return;
          }
          await route.fulfill({
            status: 201,
            headers: { ...signal, "Idempotent-Replayed": "true" },
            json: original.page,
          });
          return;
        }

        const address = `idempotent-page-${created.size + 1}`;
        const made = pageFor(address, payload);
        if (options.generatedVanity && !payload.vanity) {
          made.vanity = options.generatedVanity;
        }
        created.set(options.honorsKey && key ? key : `page-${posts.length}`, {
          body,
          page: made,
        });
        if (posts.length === 1) {
          // COMMITTED, and never answered.
          hung.push(route);
          return;
        }
        await route.fulfill({ status: 201, headers: signal, json: made });
        return;
      }

      if (pathname.startsWith("/api/zpage/") && method === "PUT") {
        const body = JSON.parse(request.postData() || "{}");
        puts.push({ url: pathname, body });
        const address = decodeURIComponent(pathname.split("/")[3] || "");
        const saved = pageFor(address, body);
        // Stores what was sent, as the real one does; only where a test
        // looks at the vanity, so the other cases keep their exact traffic.
        if (options.generatedVanity)
          saved.vanity = (body.vanity as string) || "";
        await route.fulfill({ status: 200, json: saved });
        return;
      }

      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  await page.goto("/edit");
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toBeVisible({ timeout: 30_000 });
  const chip = page.locator('[role="status"][aria-live="polite"]');

  await page
    .locator("textarea")
    .first()
    .fill(options.title ?? "A title");
  await body.fill("A brand-new page.");
  await page.clock.runFor(AUTOSAVE_DELAY_MS + 500);
  await expect.poll(() => posts.length).toBe(1);
  await expect(chip).toContainText("Saving...");
  expect(posts[0].key, "the create must carry an Idempotency-Key").toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  // The creator keeps writing while the create hangs.
  await body.fill("A brand-new page, edited while the create hung.");
  await page.clock.runFor(WRITE_BOUND_MS + 500);

  return { body, chip, posts, puts, created, hung };
}

/** Assert `read()` STAYS at `expected` for a window of real time. */
async function expectHeld(
  read: () => number,
  expected: number,
  message: string,
  windowMs = 2_000,
) {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    expect(read(), message).toBe(expected);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(read(), message).toBe(expected);
}

async function expectOnePageWithTheLateEdits(
  page: Page,
  traffic: Awaited<ReturnType<typeof openWithHungCreate>>,
  expectedPosts: number,
) {
  const { chip, posts, puts, created, hung } = traffic;
  for (const later of posts.slice(1)) {
    expect(later.key).toBe(posts[0].key);
    expect(later.body).toBe(posts[0].body);
  }
  // The words typed during the hang are saved onto THAT page.
  await expect
    .poll(() => puts.length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);
  expect(puts.at(-1)!.url).toBe("/api/zpage/idempotent-page-1/");
  expect(puts.at(-1)!.body.content).toBe(
    "A brand-new page, edited while the create hung.",
  );
  await expect(chip).toContainText("Saved", { timeout: 10_000 });

  // Exactly one page, however long we wait: nothing creates again.
  await page.clock.runFor(AUTOSAVE_DELAY_MS * 8);
  await page.waitForTimeout(1_000);
  expect(posts).toHaveLength(expectedPosts);
  expect(created.size, "the retry made a second page").toBe(1);
  expect(hung).toHaveLength(1);
}

test("a hung create is retried with the same key and makes exactly one page", async ({
  page,
}) => {
  const traffic = await openWithHungCreate(page, {
    seedHonored: true,
    honorsKey: true,
  });

  // An ordinary timed-out save — not the "check your pages" dead end.
  const notice = page.locator('[role="status"]').filter({ hasText: TIMED_OUT });
  await expect(notice).toBeVisible({ timeout: 5_000 });
  await expect(
    page.locator('[role="status"]').filter({ hasText: CREATE_TIMED_OUT }),
  ).toHaveCount(0);

  // Autosave retries on its own: the SAME key and the SAME bytes, so the
  // server answers with the page the first attempt made.
  await page.clock.runFor(AUTOSAVE_DELAY_MS * 2 + 500);
  await expect.poll(() => traffic.posts.length, { timeout: 10_000 }).toBe(2);
  await expectOnePageWithTheLateEdits(page, traffic, 2);
  await expect(notice).toHaveCount(0);
});

for (const status of [429, 404]) {
  test(`a retry turned away with ${status} keeps the key, and the next one replays`, async ({
    page,
  }) => {
    // The retry never reached the receipt, so it proves nothing about the
    // original — dropping the key here is how a second page got made (codex
    // review). The draft must reconcile under the SAME key afterwards.
    const traffic = await openWithHungCreate(page, {
      seedHonored: true,
      honorsKey: true,
      turnAwayStatus: status,
    });
    await page.clock.runFor(AUTOSAVE_DELAY_MS * 2 + 500);
    await expect.poll(() => traffic.posts.length, { timeout: 10_000 }).toBe(2);
    await page.clock.runFor(AUTOSAVE_DELAY_MS * 4 + 500);
    await expect.poll(() => traffic.posts.length, { timeout: 10_000 }).toBe(3);
    await expectOnePageWithTheLateEdits(page, traffic, 3);
  });
}

test("without the capability signal a hung keyed create is latched, not auto-retried", async ({
  page,
}) => {
  // An older backend: never sends `Idempotency-Key-Honored`, ignores the key.
  // This session has no proof, so an automatic re-send could be a second page.
  const traffic = await openWithHungCreate(page, {
    seedHonored: false,
    honorsKey: false,
  });

  const latch = page
    .locator('[role="status"]')
    .filter({ hasText: CREATE_TIMED_OUT });
  await expect(latch).toBeVisible({ timeout: 5_000 });

  // Well past every autosave retry, and after another edit: nothing re-sent.
  await page.clock.runFor(AUTOSAVE_DELAY_MS * 16);
  await expectHeld(
    () => traffic.posts.length,
    1,
    "autosave re-sent a keyed create the backend never proved it honours",
  );
  await traffic.body.fill("A brand-new page, edited again.");
  await page.clock.runFor(AUTOSAVE_DELAY_MS * 4);
  await expectHeld(
    () => traffic.posts.length,
    1,
    "an edit after the latch autosaved a second create",
  );
  await expect(latch).toBeVisible();

  // The creator's own save goes ahead, as it did before  — under the
  // SAME key and bytes, so a backend that does honour it would replay.
  await page.keyboard.press("Control+s");
  await expect.poll(() => traffic.posts.length, { timeout: 10_000 }).toBe(2);
  expect(traffic.posts[1].key).toBe(traffic.posts[0].key);
  expect(traffic.posts[1].body).toBe(traffic.posts[0].body);
});

test("a retry answered without the signal (a rollback) is adopted, warned about, and never repeated", async ({
  page,
}) => {
  // The session saw the signal earlier; the backend has since been rolled back
  // to one that ignores the key. One automatic retry goes out — and its
  // header-less answer withdraws the trust, so it is the only one.
  const traffic = await openWithHungCreate(page, {
    seedHonored: true,
    honorsKey: false,
  });
  await page.clock.runFor(AUTOSAVE_DELAY_MS * 2 + 500);
  await expect.poll(() => traffic.posts.length, { timeout: 10_000 }).toBe(2);

  await expect(page.getByText(MAY_HAVE_DUPLICATED)).toBeVisible({
    timeout: 10_000,
  });
  // The page that answered is the one the editor now saves to.
  await expect
    .poll(() => traffic.puts.length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);
  expect(traffic.puts.at(-1)!.url).toBe("/api/zpage/idempotent-page-2/");

  await page.clock.runFor(AUTOSAVE_DELAY_MS * 8);
  await page.waitForTimeout(1_000);
  expect(traffic.posts).toHaveLength(2);
  expect(
    await page.evaluate(
      (storageKey) => sessionStorage.getItem(storageKey),
      HONORED_STORAGE_KEY,
    ),
    "a header-less create answer must withdraw the capability",
  ).toBeNull();
});

test("a vanity the server generated on a hung create survives the reconcile", async ({
  page,
}) => {
  // A non-Latin title derives no vanity, so the create sent none and the
  // server generated one. The reconcile keeps the rest of the local
  // draft, but a blank local vanity is nobody's choice: the save that follows
  // must carry the generated URL, not clear it.
  const traffic = await openWithHungCreate(page, {
    seedHonored: true,
    honorsKey: true,
    title: "한국어 요약",
    generatedVanity: "p-server-generated",
  });
  expect(JSON.parse(traffic.posts[0].body).vanity ?? "").toBe("");

  await page.clock.runFor(AUTOSAVE_DELAY_MS * 2 + 500);
  await expect.poll(() => traffic.posts.length, { timeout: 10_000 }).toBe(2);
  await expect
    .poll(() => traffic.puts.length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);
  expect(traffic.puts[0].body.vanity).toBe("p-server-generated");
  // And it stays: every later save carries it too.
  await page.clock.runFor(AUTOSAVE_DELAY_MS * 4);
  for (const put of traffic.puts) {
    expect(put.body.vanity).toBe("p-server-generated");
  }
});
