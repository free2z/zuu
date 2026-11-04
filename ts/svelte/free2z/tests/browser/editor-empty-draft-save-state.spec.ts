import { expect, test, type Page } from "@playwright/test";

// The first test after a cold `vite dev` start compiles the whole /edit
// module graph on demand. The boot wait below allows up to 30s for that;
// the default 30s per-test timeout would leave nothing for the actual
// assertions, so give each test room to absorb one slow boot.
test.setTimeout(120_000);

const CALM_COPY = {
  en: "We'll save this page when you add something to the body.",
  es: "Guardaremos esta página cuando añadas algo al cuerpo.",
  fr: "Nous enregistrerons cette page dès que vous ajouterez du contenu.",
  "pt-BR": "Vamos salvar esta página quando você adicionar algo ao corpo.",
} as const;

const BLOCKED_COPY = {
  en: "Add body content before saving this version.",
  es: "Añade contenido al cuerpo antes de guardar esta versión.",
  fr: "Ajoutez du contenu avant d’enregistrer cette version.",
  "pt-BR": "Adicione conteúdo ao corpo antes de salvar esta versão.",
} as const;

type TestLocale = keyof typeof CALM_COPY;

const CREATOR = {
  id: 8104,
  username: "empty-draft-user",
  full_name: "Empty Draft User",
};

type CreatePayload = {
  [key: string]: unknown;
  content?: string;
  source_language?: string;
};

async function openNewEditor(
  page: Page,
  locale: TestLocale,
  failCreate = false,
) {
  const creates: CreatePayload[] = [];
  let resolveCreateStarted: (() => void) | null = null;
  let releaseCreateFailure: (() => void) | null = null;
  const createStarted = new Promise<void>((resolve) => {
    resolveCreateStarted = resolve;
  });
  const createFailureReleased = new Promise<void>((resolve) => {
    releaseCreateFailure = resolve;
  });

  await page.context().addCookies([
    {
      name: "free2z-locale",
      value: locale,
      domain: "127.0.0.1",
      path: "/",
    },
  ]);

  // Route with a predicate rather than the usual "**/api/**" glob. Vite
  // serves source modules from paths such as /src/lib/api/config.ts, which
  // the glob ALSO matches: intercepting them (or falling through to
  // route.continue() for every module of a cold dev-server compile) both
  // risks serving JSON where JavaScript is expected and stalls the boot.
  // The predicate lets everything outside /api/ reach the network directly,
  // untouched.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());

      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
        return;
      }

      if (pathname === "/api/zpage/" && request.method() === "POST") {
        const payload = JSON.parse(request.postData() || "{}") as CreatePayload;
        creates.push(payload);
        resolveCreateStarted?.();

        if (failCreate) {
          await createFailureReleased;
          await route.fulfill({
            status: 500,
            json: { detail: "fixture save failure" },
          });
          return;
        }

        // The real create endpoint preserves the explicit source_language sent
        // by the editor. Echo it here so non-English tests do not accidentally
        // turn their freshly-created source into a translation and add an
        // unrelated disabled-reason row to the language chip.
        const sourceLanguage = payload.source_language || "en";

        await route.fulfill({
          status: 201,
          json: {
            id: 1173,
            free2zaddr: "empty-draft-fixture",
            vanity: "empty-draft-fixture",
            title: payload.title || "",
            description: payload.description || "",
            canonical_url: payload.canonical_url || "",
            content: payload.content || "",
            tags: payload.tags || [],
            p2paddr: payload.p2paddr || "",
            featured_image: null,
            is_published: false,
            is_subscriber_only: false,
            publish_at: null,
            creator: CREATOR,
            source_language: sourceLanguage,
            actual_language: sourceLanguage,
            requested_language: sourceLanguage,
            available_languages: [sourceLanguage],
            variant_is_published: false,
            created_at: "2026-08-20T00:00:00Z",
            updated_at: "2026-08-20T00:00:00Z",
          },
        });
        return;
      }

      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  await page.goto("/edit");
  const body = page.locator("textarea.writing-area-textarea");
  // The first navigation after a cold `vite dev` start compiles the whole
  // /edit module graph on demand, which legitimately takes far longer than
  // the default 5s expect timeout on a busy machine. Give the boot itself a
  // generous ceiling; every later assertion keeps the default.
  await expect(body).toBeVisible({ timeout: 30_000 });

  return {
    body,
    creates,
    createStarted,
    releaseCreateFailure: () => releaseCreateFailure?.(),
  };
}

async function box(locator: ReturnType<Page["locator"]>) {
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return rect!;
}

for (const locale of Object.keys(CALM_COPY) as TestLocale[]) {
  test(`an empty new page is calm and reserved in ${locale}`, async ({
    page,
  }) => {
    const { body, creates } = await openNewEditor(page, locale);
    const calmStatus = page.getByText(CALM_COPY[locale], { exact: true });
    await expect(calmStatus).toBeVisible();
    await expect(calmStatus).toHaveClass(/text-muted-foreground/);
    await expect(calmStatus).not.toHaveClass(/text-destructive|text-red/);

    // Entering a title can legitimately resize its auto-growing field (the
    // localized placeholder may wrap), so establish the geometry baseline
    // after that unrelated transition. The manual empty-body save itself is
    // synchronous and must not insert a late status row. This measures the
    // writing surface directly, so the negative control fails on the old
    // layout shift rather than only on the missing calm-copy selector.
    await page.locator("textarea").first().fill("Draft title");
    const beforeManualSave = await box(body);
    await page.keyboard.press("Control+s");
    await expect(calmStatus).toBeVisible();
    expect(creates).toHaveLength(0);
    expect((await box(body)).y).toBe(beforeManualSave.y);

    // Body content follows the normal debounce/create path and removes the
    // waiting sentence.
    await body.fill("The first paragraph of a new page.");
    await expect.poll(() => creates.length, { timeout: 10_000 }).toBe(1);
    expect(creates[0]?.content).toBe("The first paragraph of a new page.");
    await expect(calmStatus).toHaveCount(0);

    // Once the create has made this an existing page, an empty body is a real
    // blocker again and remains in the reserved status slot.
    const beforeBlocked = await box(body);
    await body.fill("");
    await page.keyboard.press("Control+s");
    const blockedStatus = page
      .locator('[role="status"]')
      .filter({ hasText: BLOCKED_COPY[locale] });
    await expect(blockedStatus).toBeVisible();
    expect((await box(body)).y).toBe(beforeBlocked.y);
  });
}

test("a real create failure remains actionable after the body is cleared in flight", async ({
  page,
}) => {
  const { body, createStarted, releaseCreateFailure } = await openNewEditor(
    page,
    "en",
    true,
  );

  await body.fill("Content that will fail to save.");
  await page.keyboard.press("Control+s");
  await createStarted;

  // This is still a genuinely new page until the response settles. Clearing
  // the body must not turn the server failure into the calm waiting state.
  await body.fill("");
  releaseCreateFailure();

  const failureStatus = page
    .locator('[role="status"]')
    .filter({ hasText: "The server could not be reached." });
  await expect(failureStatus).toBeVisible();
  await expect(
    page.getByText("Failed to save article", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(CALM_COPY.en, { exact: true })).toHaveCount(0);
});
