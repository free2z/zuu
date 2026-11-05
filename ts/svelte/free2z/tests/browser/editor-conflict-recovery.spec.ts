import { expect, test, type Page } from "@playwright/test";

test.setTimeout(120_000);
const owner = { id: 8125, username: "conflict-owner", full_name: "Owner" };
function article(language = "en") {
  return {
    id: 8125,
    free2zaddr: "conflict-fixture",
    vanity: "conflict-fixture",
    title: "Server title",
    description: "Server summary",
    content: "Server body",
    creator: owner,
    source_language: "en",
    actual_language: language,
    requested_language: language,
    available_languages: ["en", "fr"],
    tags: ["original"],
    is_published: false,
    is_subscriber_only: false,
    variant_is_published: false,
    featured_image: null,
    canonical_url: "",
    publish_at: null,
    p2paddr: "",
  };
}
async function fixture(page: Page, variantStatus = 200) {
  const writes: { headers: Record<string, string>; body: any }[] = [];
  let reject = true;
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (path === "/api/auth/user/") return route.fulfill({ json: owner });
      if (path === "/api/zpage/conflict-fixture/variants/fr/")
        return route.fulfill({
          status: variantStatus,
          json: variantStatus === 200 ? article("fr") : { detail: "Failure" },
          headers: { ETag: '"variant"' },
        });
      if (
        path === "/api/zpage/conflict-fixture/" ||
        path === "/api/zpage/conflict-fixture/translations/fr/"
      ) {
        if (req.method() === "GET")
          return route.fulfill({
            json: article(),
            headers: { ETag: '"current"' },
          });
        writes.push({ headers: req.headers(), body: req.postDataJSON() });
        return route.fulfill({
          status: reject ? 412 : 200,
          json: reject
            ? { detail: "Unlocalized server message" }
            : {
                ...article(path.includes("/translations/") ? "fr" : "en"),
                ...req.postDataJSON(),
              },
          headers: { ETag: '"saved"' },
        });
      }
      return route.fulfill({ json: { count: 0, results: [] } });
    },
  );
  return {
    writes,
    allowSave: () => {
      reject = false;
    },
  };
}
const body = (page: Page) => page.locator("textarea.writing-area-textarea");

test("412 reload offers the full rejected draft and saves it against the newly loaded validator", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/edit?id=conflict-fixture");
  await expect(body(page)).toBeVisible({ timeout: 30_000 });
  await page.locator("textarea").first().fill("Rejected title");
  await body(page).fill("Rejected body");
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(
    page.getByText("The server has a newer version.", { exact: false }).first(),
  ).toBeVisible();
  await body(page).fill("Rejected body plus later edits");
  await page
    .getByRole("button", { name: "Reload", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("button", { name: "Restore draft" }),
  ).toBeVisible();
  await expect(body(page)).toHaveValue("Server body");
  expect(state.writes).toHaveLength(1);
  state.allowSave();
  await page.getByRole("button", { name: "Restore draft" }).click();
  await expect(body(page)).toHaveValue("Rejected body plus later edits");
  await expect(page.locator("textarea").first()).toHaveValue("Rejected title");
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1].headers["if-match"]).toBe('"current"');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(sessionStorage).filter((k) =>
            k.startsWith("editor-conflict:"),
          ).length,
      ),
    )
    .toBe(0);
});

test("blocked storage refuses offered reload and keeps edits in memory", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/edit?id=conflict-fixture");
  await expect(body(page)).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
  });
  await body(page).fill("Do not lose this");
  await page
    .getByRole("button", { name: "Reload", exact: true })
    .last()
    .click();
  await expect(
    page.getByText("Could not preserve your draft", { exact: false }).first(),
  ).toBeVisible();
  await expect(body(page)).toHaveValue("Do not lose this");
});

for (const status of [500, 403])
  test(`variant ${status} never opens an unprotected editor`, async ({
    page,
  }) => {
    const state = await fixture(page, status);
    await page.goto("/edit?id=conflict-fixture&lang=fr");
    if (status === 500)
      await expect(
        page.getByRole("alert").filter({ hasText: "Could not safely load" }),
      ).toBeVisible();
    else await expect(page).toHaveURL(/login/);
    await expect(body(page)).toHaveCount(0);
    expect(state.writes).toHaveLength(0);
  });

test("404 starts a new translation with a create-only precondition", async ({
  page,
}) => {
  const sent: Record<string, string>[] = [];
  await fixture(page, 404);
  await page.route(
    (url) => url.pathname === "/api/zpage/conflict-fixture/translations/fr/",
    async (route) => {
      sent.push(route.request().headers());
      await route.fulfill({
        json: { ...article("fr"), ...route.request().postDataJSON() },
        headers: { ETag: '"created"' },
      });
    },
  );
  await page.goto("/edit?id=conflict-fixture&lang=fr");
  await expect(body(page)).toBeVisible({ timeout: 30_000 });
  await expect(body(page)).toHaveValue("");
  await page.locator("textarea").first().fill("Titre");
  await body(page).fill("Nouveau texte");
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]["if-none-match"]).toBe("*");
});

test("other actors, articles and languages never see a stored rejected draft", async ({
  page,
}) => {
  await fixture(page);
  await page.addInitScript(() => {
    const draft = {
      title: "Private",
      content: "Private",
      description: "Private",
      canonicalUrl: "",
      coverImage: "",
      coverImageId: null,
      tags: [],
      zcashAddress: "",
      vanity: "",
      isPublished: false,
      isSubscriberOnly: false,
      publishAt: "",
      showCover: false,
      showSubtitle: false,
    };
    for (const identity of [
      [999, "conflict-fixture", "en"],
      [8125, "other-article", "en"],
      [8125, "conflict-fixture", "fr"],
    ]) {
      sessionStorage.setItem(
        `editor-conflict:v1:${JSON.stringify(identity)}`,
        JSON.stringify(draft),
      );
    }
    sessionStorage.setItem(
      `editor-conflict:v1:${JSON.stringify([8125, "conflict-fixture", "en"])}`,
      "{corrupt",
    );
  });
  await page.goto("/edit?id=conflict-fixture");
  await expect(body(page)).toBeVisible({ timeout: 30_000 });
  await expect(body(page)).toHaveValue("Server body");
  await expect(page.getByRole("button", { name: "Restore draft" })).toHaveCount(
    0,
  );
});

for (const language of ["en", "fr"])
  for (const stale of [false, true])
    test(`${language} tag decision ${stale ? "conflict blocks saves" : "retains its response validator"}`, async ({
      page,
    }) => {
      const state = await fixture(page);
      state.allowSave();
      let decisionHeader: string | undefined;
      await page.route(
        (url) =>
          url.pathname === "/api/tagging/zpage/conflict-fixture/suggestions",
        (route) =>
          route.fulfill({
            json: [{ name: "privacy", level: "broad", count: 1 }],
          }),
      );
      await page.route(
        (url) =>
          url.pathname ===
          "/api/tagging/zpage/conflict-fixture/suggestions/decide",
        async (route) => {
          decisionHeader = route.request().headers()["if-match"];
          expect(new URL(route.request().url()).searchParams.get("lang")).toBe(
            language === "en" ? null : "fr",
          );
          await route.fulfill({
            status: stale ? 412 : 200,
            json: stale
              ? { detail: "stale" }
              : {
                  accepted: ["privacy"],
                  dismissed: [],
                  tags: ["original", "privacy"],
                  suggestions: [],
                },
            headers: { ETag: '"after-decision"' },
          });
        },
      );
      await page.goto(
        `/edit?id=conflict-fixture${language === "fr" ? "&lang=fr" : ""}`,
      );
      await expect(body(page)).toBeVisible({ timeout: 30_000 });
      await page
        .getByRole("button", { name: "Publish", exact: true })
        .first()
        .click();
      await page
        .getByRole("button", { name: "Add tag privacy", exact: true })
        .click();
      await expect
        .poll(() => decisionHeader)
        .toBe(language === "en" ? '"current"' : '"variant"');
      if (stale) {
        await page.keyboard.press("Escape");
        await body(page).fill("Still unsaved");
        await expect(
          page.getByRole("button", { name: "Reload", exact: true }).last(),
        ).toBeVisible();
        expect(state.writes).toHaveLength(0);
      } else {
        await expect.poll(() => state.writes.length).toBe(1);
        expect(state.writes[0].headers["if-match"]).toBe('"after-decision"');
        expect(state.writes[0].body.tags).toContain("privacy");
      }
    });

for (const failure of [
  {
    name: "missing article",
    path: "/api/zpage/conflict-fixture/",
    status: 404,
    message: "Article not found.",
  },
  {
    name: "article load failure",
    path: "/api/zpage/conflict-fixture/",
    status: 503,
    message: "Failed to load the article.",
  },
  {
    name: "account load failure",
    path: "/api/auth/user/",
    status: 503,
    message: "Failed to load your account for the editor.",
  },
])
  test(`${failure.name} keeps its meaning in the editor error boundary`, async ({
    page,
  }) => {
    await fixture(page);
    await page.route(
      (url) => url.pathname === failure.path,
      (route) =>
        route.fulfill({
          status: failure.status,
          json: { detail: "Private backend diagnostics" },
        }),
    );
    await page.goto("/edit?id=conflict-fixture");
    const alert = page.getByRole("alert").filter({ hasText: failure.message });
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert.getByRole("heading")).toHaveText(
      failure.status === 404 ? "404" : "502",
    );
    await expect(alert).not.toContainText("Could not safely load this version");
    await expect(page.getByText("Private backend diagnostics")).toHaveCount(0);
    await expect(
      alert.getByRole("button", { name: "Reload", exact: true }),
    ).toHaveCount(failure.status === 404 ? 0 : 1);
    await expect(body(page)).toHaveCount(0);
  });
