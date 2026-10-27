import { expect, test, type Page } from "@playwright/test";

const ARTICLE_ID = "series-editor-fixture";
const CREATOR = {
  id: 8105,
  username: "serieswriter",
  full_name: "Series Writer",
};

function article(id = ARTICLE_ID, title = "Current article") {
  return {
    id: id === ARTICLE_ID ? 540 : 541,
    free2zaddr: id,
    vanity: id,
    title,
    description: "",
    canonical_url: "",
    content: "The body of the article.",
    tags: [],
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

type PageOrder = {
  page: { free2zaddr: string; title: string };
  order: number;
};

type Series = {
  id: string;
  name: string;
  created_at: string;
  pageorder_set: PageOrder[];
};

type Sent = { method: string; pathname: string; body: any };

type StubOptions = {
  articles?: Record<string, ReturnType<typeof article>>;
  delayUpdateId?: string;
  failFirstUpdateId?: string;
  failFirstClear?: boolean;
  conflictFirstUpdate?: boolean;
  deletedMemberFirstUpdate?: boolean;
  initialSeries?: Series[];
};

async function stubSeriesApi(page: Page, options: StubOptions = {}) {
  const sent: Sent[] = [];
  const articles = options.articles || { [ARTICLE_ID]: article() };
  const updateAttempts = new Map<string, number>();
  let clearAttempts = 0;
  let series: Series[] = [
    {
      id: "series-existing",
      name: "Existing series",
      created_at: "2026-01-01T00:00:00Z",
      pageorder_set: [
        {
          page: { free2zaddr: "first-article", title: "First article" },
          order: 0,
        },
      ],
    },
  ];
  if (options.initialSeries) series = options.initialSeries;

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      const method = request.method();
      let body: any = null;
      if (method !== "GET") {
        body = JSON.parse(request.postData() || "null");
        sent.push({ method, pathname, body });
      }

      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
        return;
      }

      if (pathname === "/api/zpage/" && method === "POST") {
        await route.fulfill({
          status: 201,
          json: { ...article(), ...body, is_published: false },
        });
        return;
      }

      const articleRequest = pathname.match(/^\/api\/zpage\/([^/]+)\/$/);
      if (articleRequest) {
        const currentArticle =
          articles[articleRequest[1]] || article(articleRequest[1]);
        await route.fulfill({
          json: { ...currentArticle, ...(body || {}) },
        });
        return;
      }

      if (pathname === "/api/g12f/series/mine/" && method === "GET") {
        const pageNumber = Number(
          new URL(request.url()).searchParams.get("page") || "1",
        );
        const start = (pageNumber - 1) * 12;
        if (pageNumber > 1 && start >= series.length) {
          await route.fulfill({
            status: 404,
            json: { detail: "Invalid page." },
          });
          return;
        }
        await route.fulfill({ json: series.slice(start, start + 12) });
        return;
      }

      if (pathname === "/api/g12f/series/mine/" && method === "POST") {
        const created: Series = {
          id: "series-created",
          name: body.name,
          created_at: "2026-02-01T00:00:00Z",
          pageorder_set: body.pageorder_set.map(
            (entry: { page: { free2zaddr: string }; order: number }) => ({
              page: {
                free2zaddr: entry.page.free2zaddr,
                title:
                  entry.page.free2zaddr === ARTICLE_ID ? article().title : "",
              },
              order: entry.order,
            }),
          ),
        };
        series = [...series, created];
        await route.fulfill({ status: 201, json: created });
        return;
      }

      const update = pathname.match(/^\/api\/g12f\/series\/mine\/([^/]+)\/$/);
      if (update && method === "PUT") {
        const id = update[1];
        const attempt = (updateAttempts.get(id) || 0) + 1;
        updateAttempts.set(id, attempt);
        if (options.deletedMemberFirstUpdate && attempt === 1) {
          series = series.map((item) => ({
            ...item,
            pageorder_set: item.pageorder_set.filter(
              (row) => row.page.free2zaddr !== "deleted-article",
            ),
          }));
          await route.fulfill({
            status: 400,
            json: { pageorder_set: [{ page: "No page belonging to you." }] },
          });
          return;
        }
        if (options.conflictFirstUpdate && attempt === 1) {
          series = series.map((item) =>
            item.id === id
              ? {
                  ...item,
                  name: "Updated elsewhere",
                  pageorder_set: [
                    ...item.pageorder_set,
                    {
                      page: {
                        free2zaddr: "other-tab-article",
                        title: "Other tab article",
                      },
                      order: item.pageorder_set.length,
                    },
                  ],
                }
              : item,
          );
          await route.fulfill({
            status: 409,
            json: { detail: "This series changed in another session." },
          });
          return;
        }
        if (options.failFirstUpdateId === id && attempt === 1) {
          await route.fulfill({
            status: 500,
            json: { detail: "The series could not be updated." },
          });
          return;
        }
        if (options.delayUpdateId === id) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        const current = series.find((item) => item.id === id);
        const updated: Series = {
          ...(current || {
            id,
            created_at: "2026-01-01T00:00:00Z",
          }),
          name: body.name,
          pageorder_set: body.pageorder_set.map(
            (entry: { page: { free2zaddr: string }; order: number }) => ({
              page: {
                free2zaddr: entry.page.free2zaddr,
                title: articles[entry.page.free2zaddr]
                  ? articles[entry.page.free2zaddr].title
                  : current?.pageorder_set.find(
                      (row) => row.page.free2zaddr === entry.page.free2zaddr,
                    )?.page.title || "First article",
              },
              order: entry.order,
            }),
          ),
        };
        const movedPages = new Set(
          body.pageorder_set.map(
            (entry: { page: { free2zaddr: string } }) => entry.page.free2zaddr,
          ),
        );
        series = series.map((item) =>
          item.id === id
            ? updated
            : {
                ...item,
                pageorder_set: item.pageorder_set.filter(
                  (entry) => !movedPages.has(entry.page.free2zaddr),
                ),
              },
        );
        await route.fulfill({ json: updated });
        return;
      }

      if (
        pathname === `/api/g12f/series/clear-zpage/${ARTICLE_ID}/` &&
        method === "DELETE"
      ) {
        clearAttempts += 1;
        if (options.failFirstClear && clearAttempts === 1) {
          await route.fulfill({
            status: 500,
            json: { detail: "Removal failed." },
          });
          return;
        }
        series = series.map((item) => ({
          ...item,
          pageorder_set: item.pageorder_set.filter(
            (entry) => entry.page.free2zaddr !== ARTICLE_ID,
          ),
        }));
        await route.fulfill({ json: { status: "success" } });
        return;
      }

      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  return sent;
}

test.setTimeout(120_000);

// The series controls are one inline trigger in the editor's metadata row; the
// picker lives in a popover and create/rename/reorder in a dialog. Located by
// test id so the helpers work in every locale.
function seriesTrigger(page: Page) {
  return page.getByTestId("editor-series-trigger-row").getByRole("button");
}

async function openSeries(page: Page) {
  const trigger = seriesTrigger(page);
  if ((await trigger.getAttribute("aria-expanded")) === "true") return;
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#editor-series-select")).toBeVisible();
}

function seriesDialog(page: Page, nameLabel = "Series name") {
  return page.getByRole("dialog").filter({ has: page.getByLabel(nameLabel) });
}

async function closeSeriesDialog(page: Page) {
  const dialog = seriesDialog(page);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test("a creator can create, reorder, assign, and remove an article series", async ({
  page,
}) => {
  const sent = await stubSeriesApi(page);

  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(page.locator("textarea.writing-area-textarea")).toBeVisible({
    timeout: 30_000,
  });
  await expect(seriesTrigger(page)).toHaveText(/Series:\s*None/);
  // Nothing but the trigger is on the page until the author asks for it.
  await expect(page.getByLabel("Current series")).toHaveCount(0);
  await openSeries(page);
  await expect(page.getByLabel("Current series")).toHaveValue("");

  await page.getByRole("button", { name: "New series" }).click();
  await page.getByLabel("Series name").fill("Created series");
  await page.getByRole("button", { name: "Create series" }).click();

  await expect
    .poll(
      () =>
        sent.find(
          (request) =>
            request.method === "POST" &&
            request.pathname === "/api/g12f/series/mine/",
        )?.body,
      { timeout: 10_000 },
    )
    .toMatchObject({
      name: "Created series",
      pageorder_set: [{ page: { free2zaddr: ARTICLE_ID }, order: 0 }],
    });
  // A confirmed save closes the dialog, reports the membership on the
  // trigger, and returns focus to the trigger it was opened from.
  await expect(seriesDialog(page)).toHaveCount(0);
  await expect(seriesTrigger(page)).toHaveText(
    /Series:\s*Created series\s*\(1 of 1\)/,
  );
  await expect(seriesTrigger(page)).toBeFocused();

  // Choosing an existing series moves the article into it through the same
  // owner-scoped PUT the classic editor used, instead of inventing a new API.
  await openSeries(page);
  await page.getByLabel("Current series").selectOption("series-existing");
  await expect
    .poll(
      () =>
        sent.filter(
          (request) =>
            request.method === "PUT" &&
            request.pathname === "/api/g12f/series/mine/series-existing/",
        ).length,
      { timeout: 10_000 },
    )
    .toBe(1);

  await expect(
    page.getByRole("button", { name: "Move Current article earlier" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Move Current article earlier" })
    .click();
  await page.getByRole("button", { name: "Save series" }).click();

  await expect
    .poll(
      () =>
        sent
          .filter(
            (request) =>
              request.method === "PUT" &&
              request.pathname === "/api/g12f/series/mine/series-existing/",
          )
          .at(-1)?.body.pageorder_set,
      { timeout: 10_000 },
    )
    .toEqual([
      { page: { free2zaddr: ARTICLE_ID }, order: 0 },
      { page: { free2zaddr: "first-article" }, order: 1 },
    ]);
  await expect(seriesTrigger(page)).toHaveText(
    /Series:\s*Existing series\s*\(1 of 2\)/,
  );

  await openSeries(page);
  await expect(page.getByText("This article is part 1 of 2.")).toBeVisible();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect
    .poll(
      () =>
        sent.some(
          (request) =>
            request.method === "DELETE" &&
            request.pathname === `/api/g12f/series/clear-zpage/${ARTICLE_ID}/`,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  await expect(page.getByLabel("Current series")).toHaveValue("");
  await expect(seriesTrigger(page)).toHaveText(/Series:\s*None/);
});

test("loads an article's series from later owner-list pages", async ({
  page,
}) => {
  const initialSeries = Array.from({ length: 13 }, (_, index) => ({
    id: `series-page-${index + 1}`,
    name: `Series ${index + 1}`,
    created_at: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    pageorder_set:
      index === 12
        ? [
            {
              page: { free2zaddr: ARTICLE_ID, title: "Current article" },
              order: 0,
            },
          ]
        : [],
  }));
  await stubSeriesApi(page, { initialSeries });

  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(seriesTrigger(page)).toHaveText(/Series:\s*Series 13\b/);
  await openSeries(page);
  await expect(page.getByLabel("Current series")).toHaveValue("series-page-13");
  await expect(
    page.getByRole("button", { name: "Manage series" }),
  ).toBeVisible();
});

test("failed assignment keeps the confirmed series and can be retried", async ({
  page,
}) => {
  const initialSeries: Series[] = [
    {
      id: "series-confirmed",
      name: "Confirmed series",
      created_at: "2026-01-01T00:00:00Z",
      pageorder_set: [
        {
          page: { free2zaddr: ARTICLE_ID, title: "Current article" },
          order: 0,
        },
      ],
    },
    {
      id: "series-retry",
      name: "Retry series",
      created_at: "2026-01-02T00:00:00Z",
      pageorder_set: [],
    },
  ];
  const sent = await stubSeriesApi(page, {
    initialSeries,
    failFirstUpdateId: "series-retry",
  });

  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await openSeries(page);
  await expect(page.getByLabel("Current series")).toHaveValue(
    "series-confirmed",
  );

  await page.getByLabel("Current series").selectOption("series-retry");
  await expect
    .poll(
      () =>
        sent.filter(
          (request) =>
            request.method === "PUT" &&
            request.pathname === "/api/g12f/series/mine/series-retry/",
        ).length,
    )
    .toBe(1);
  await expect(page.getByLabel("Current series")).toHaveValue(
    "series-confirmed",
  );
  await expect(page.getByRole("alert")).toContainText(
    "The series could not be updated",
  );

  await page.getByLabel("Current series").selectOption("series-retry");
  await expect
    .poll(
      () =>
        sent.filter(
          (request) =>
            request.method === "PUT" &&
            request.pathname === "/api/g12f/series/mine/series-retry/",
        ).length,
    )
    .toBe(2);
  await closeSeriesDialog(page);
  await openSeries(page);
  await expect(page.getByLabel("Current series")).toHaveValue("series-retry");
});

test("a delayed save from article A cannot overwrite article B", async ({
  page,
}) => {
  const articles = {
    "article-a": article("article-a", "Article A"),
    "article-b": article("article-b", "Article B"),
  };
  const initialSeries: Series[] = [
    {
      id: "series-a",
      name: "Series A",
      created_at: "2026-01-01T00:00:00Z",
      pageorder_set: [
        { page: { free2zaddr: "article-a", title: "Article A" }, order: 0 },
      ],
    },
    {
      id: "series-b",
      name: "Series B",
      created_at: "2026-01-02T00:00:00Z",
      pageorder_set: [
        { page: { free2zaddr: "article-b", title: "Article B" }, order: 0 },
      ],
    },
  ];
  const sent = await stubSeriesApi(page, {
    articles,
    initialSeries,
    delayUpdateId: "series-a",
  });

  await page.goto("/edit?id=article-a");
  await openSeries(page);
  await expect(page.getByLabel("Current series")).toHaveValue("series-a");
  await page.getByRole("button", { name: "Manage series" }).click();
  await page.getByLabel("Series name").fill("A pending");
  await page.getByRole("button", { name: "Save series" }).click();
  await expect
    .poll(
      () =>
        sent.filter(
          (request) =>
            request.method === "PUT" &&
            request.pathname === "/api/g12f/series/mine/series-a/",
        ).length,
    )
    .toBe(1);

  await page.evaluate(() => {
    const link = document.createElement("a");
    link.href = "/edit?id=article-b";
    document.body.append(link);
    link.click();
  });

  // Article A's dialog belonged to article A; it does not survive the switch.
  await expect(seriesDialog(page)).toHaveCount(0);
  await expect(seriesTrigger(page)).toHaveText(/Series:\s*Series B\b/);
  await openSeries(page);
  await expect(page.getByLabel("Current series")).toHaveValue("series-b");
  await page.getByRole("button", { name: "Manage series" }).click();
  await expect(page.getByLabel("Series name")).toHaveValue("Series B");
  await page.getByLabel("Series name").fill("B updated");
  await page.getByRole("button", { name: "Save series" }).click();
  await expect
    .poll(
      () =>
        sent.filter(
          (request) =>
            request.method === "PUT" &&
            request.pathname === "/api/g12f/series/mine/series-b/",
        ).length,
    )
    .toBe(1);
  await expect(seriesTrigger(page)).toHaveText(/Series:\s*B updated\b/);

  // A's delayed response lands now; it must not touch B's state.
  await page.waitForTimeout(1700);
  await expect(seriesTrigger(page)).toHaveText(/Series:\s*B updated\b/);
  await expect(seriesDialog(page)).toHaveCount(0);
  await openSeries(page);
  await expect(page.getByLabel("Current series")).toHaveValue("series-b");
  await page.getByRole("button", { name: "Manage series" }).click();
  await expect(page.getByLabel("Series name")).toHaveValue("B updated");
  expect(
    sent.filter(
      (request) =>
        request.method === "PUT" &&
        request.pathname === "/api/g12f/series/mine/series-a/",
    ),
  ).toHaveLength(1);
  expect(
    sent.find(
      (request) =>
        request.method === "PUT" &&
        request.pathname === "/api/g12f/series/mine/series-b/",
    )?.body,
  ).toMatchObject({
    name: "B updated",
    pageorder_set: [{ page: { free2zaddr: "article-b" }, order: 0 }],
  });
});

for (const count of [12, 24]) {
  test(`loads exactly ${count} owned series through the real terminal 404`, async ({
    page,
  }) => {
    const initialSeries: Series[] = Array.from(
      { length: count },
      (_, index) => ({
        id: `exact-${index}`,
        name: `Series ${index}`,
        created_at: "2026-01-01T00:00:00Z",
        pageorder_set:
          index === count - 1
            ? [
                {
                  page: { free2zaddr: ARTICLE_ID, title: "Current article" },
                  order: 0,
                },
              ]
            : [],
      }),
    );
    await stubSeriesApi(page, { initialSeries });
    await page.goto(`/edit?id=${ARTICLE_ID}`);
    await openSeries(page);
    await expect(page.getByLabel("Current series")).toHaveValue(
      `exact-${count - 1}`,
    );
    await expect(
      page.getByLabel("Current series").locator("option"),
    ).toHaveCount(count + 1);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

test("failed clear restores confirmed membership and permits retry", async ({
  page,
}) => {
  const initialSeries: Series[] = [
    {
      id: "confirmed",
      name: "Confirmed",
      created_at: "2026-01-01T00:00:00Z",
      pageorder_set: [
        {
          page: { free2zaddr: ARTICLE_ID, title: "Current article" },
          order: 0,
        },
      ],
    },
  ];
  const sent = await stubSeriesApi(page, {
    initialSeries,
    failFirstClear: true,
  });
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await openSeries(page);
  await expect(page.getByLabel("Current series")).toHaveValue("confirmed");
  await page.getByLabel("Current series").selectOption("");
  await expect(page.getByRole("alert")).toContainText("Removal failed.");
  await expect(page.getByLabel("Current series")).toHaveValue("confirmed");
  await expect(
    page.getByRole("button", { name: "Manage series" }),
  ).toBeVisible();
  await page.getByLabel("Current series").selectOption("");
  await expect(page.getByLabel("Current series")).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(sent.filter((request) => request.method === "DELETE")).toHaveLength(2);
});

test("stale membership conflict reloads current series without replaying the save", async ({
  page,
}) => {
  const sent = await stubSeriesApi(page, {
    conflictFirstUpdate: true,
    initialSeries: [
      {
        id: "series-existing",
        name: "Existing series",
        created_at: "2026-01-01T00:00:00Z",
        pageorder_set: [
          {
            page: { free2zaddr: "first-article", title: "First article" },
            order: 7,
          },
        ],
      },
    ],
  });
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await openSeries(page);
  await expect(page.getByLabel("Current series")).toHaveValue("");
  await page.getByLabel("Current series").selectOption("series-existing");
  await expect(page.getByRole("alert")).toContainText(
    "changed in another session",
  );
  await expect(page.getByLabel("Current series")).toHaveValue("");
  await expect(
    page
      .getByLabel("Current series")
      .locator("option[value='series-existing']"),
  ).toHaveText("Updated elsewhere");
  await expect(
    page.getByRole("button", { name: "Save series", exact: true }),
  ).toHaveCount(0);
  expect(sent.filter((request) => request.method === "PUT")).toHaveLength(1);
  expect(sent.find((request) => request.method === "PUT")?.body).toMatchObject({
    expected_name: "Existing series",
    expected_pageorder_set: [
      { page: { free2zaddr: "first-article" }, order: 7 },
    ],
  });
  await page.getByLabel("Current series").selectOption("series-existing");
  await expect(
    page.getByRole("button", { name: "Move Other tab article earlier" }),
  ).toBeVisible();
  const requests = sent.filter((request) => request.method === "PUT");
  expect(requests).toHaveLength(2);
  expect(requests[1].body.expected_name).toBe("Updated elsewhere");
  expect(requests[1].body.expected_pageorder_set).toHaveLength(2);
  await closeSeriesDialog(page);
  await openSeries(page);
  await expect(page.getByLabel("Current series")).toHaveValue(
    "series-existing",
  );
});

test("a conflict while saving from the dialog stays visible after the dialog closes", async ({
  page,
}) => {
  // The conflict closes the dialog (its draft is stale). The explanation must
  // not vanish with it: the popover reopens with the alert and the reloaded
  // series.
  const sent = await stubSeriesApi(page, {
    conflictFirstUpdate: true,
    initialSeries: [
      {
        id: "series-existing",
        name: "Existing series",
        created_at: "2026-01-01T00:00:00Z",
        pageorder_set: [
          {
            page: { free2zaddr: ARTICLE_ID, title: "Current article" },
            order: 0,
          },
        ],
      },
    ],
  });
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await openSeries(page);
  await page.getByRole("button", { name: "Manage series" }).click();
  await page.getByLabel("Series name").fill("Renamed here");
  await page.getByRole("button", { name: "Save series", exact: true }).click();
  await expect(seriesDialog(page)).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText(
    "changed in another session",
  );
  await expect(
    page.getByRole("heading", { name: "Series", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Current series").locator("option:checked"),
  ).toHaveText("Updated elsewhere");
  expect(sent.filter((request) => request.method === "PUT")).toHaveLength(1);

  // That popover was surfaced without focus. Once the author closes it and
  // reopens it from the keyboard (the trigger toggles on keydown, so no click
  // fires), it is a normal popover: focus moves inside, so its controls are
  // reachable — the content is portaled, so Tab from the trigger would not
  // get there.
  const content = page.locator("[data-slot='popover-content']");
  await seriesTrigger(page).focus();
  await page.keyboard.press("Enter");
  await expect(seriesTrigger(page)).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(seriesTrigger(page)).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() =>
      content.evaluate((node) => node.contains(document.activeElement)),
    )
    .toBe(true);
});

test("a series list that fails to load never claims the page is in no series", async ({
  page,
}) => {
  // The article IS in a series; the list request fails. "Series: None" would
  // be a false statement, and the aria-hidden alert icon alone is not an
  // accessible cue — the trigger's text (its accessible name) must say so.
  await stubSeriesApi(page, {
    initialSeries: [
      {
        id: "series-existing",
        name: "Existing series",
        created_at: "2026-01-01T00:00:00Z",
        pageorder_set: [
          {
            page: { free2zaddr: ARTICLE_ID, title: "Current article" },
            order: 0,
          },
        ],
      },
    ],
  });
  let failures = 1;
  await page.route("**/api/g12f/series/mine/?page=1", async (route) => {
    if (failures-- > 0) {
      await route.fulfill({
        status: 503,
        json: { detail: "Series are unavailable." },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(page.locator("textarea.writing-area-textarea")).toBeVisible({
    timeout: 30_000,
  });
  await expect(seriesTrigger(page)).toHaveAccessibleName(
    /Series:\s*couldn't load/,
  );
  await expect(seriesTrigger(page)).not.toHaveText(/None/);

  await openSeries(page);
  await expect(page.getByRole("alert")).toContainText(
    "Series are unavailable.",
  );
  await page.getByRole("button", { name: "Reload series" }).click();
  await expect(seriesTrigger(page)).toHaveAccessibleName(
    /Series:\s*Existing series\s*\(1 of 1\)/,
  );
});

test("a stalled save never traps the author in the series dialog", async ({
  page,
}) => {
  // apiFetch has no timeout. The modal must stay dismissible while a save is
  // pending, and the failure that eventually arrives must still be shown.
  const sent = await stubSeriesApi(page, {
    initialSeries: [
      {
        id: "series-existing",
        name: "Existing series",
        created_at: "2026-01-01T00:00:00Z",
        pageorder_set: [
          {
            page: { free2zaddr: ARTICLE_ID, title: "Current article" },
            order: 0,
          },
        ],
      },
    ],
  });
  let releaseSave = () => {};
  const saveGate = new Promise<void>((resolve) => (releaseSave = resolve));
  await page.route(
    "**/api/g12f/series/mine/series-existing/",
    async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await saveGate;
      await route.fulfill({
        status: 502,
        json: { detail: "Upstream timed out." },
      });
    },
  );
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toBeVisible({ timeout: 30_000 });
  await openSeries(page);
  await page.getByRole("button", { name: "Manage series" }).click();
  await page.getByLabel("Series name").fill("Pending name");
  await page.getByRole("button", { name: "Save series", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(seriesDialog(page)).toHaveCount(0);
  await body.fill("Still writing while the series save is stuck.");
  await expect(body).toHaveValue(
    "Still writing while the series save is stuck.",
  );

  releaseSave();
  await expect(page.getByRole("alert")).toContainText("Upstream timed out.");
  await expect(page.locator("#editor-series-select")).toBeVisible();
  // The failure surfaced without taking focus: the author's next keystrokes
  // (including arrow keys, which would change a focused select and send a
  // membership write) still go to the article.
  await expect(body).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type(" More.");
  await expect(body).toHaveValue(
    "Still writing while the series save is stuck. More.",
  );
  await expect(page.locator("#editor-series-select")).toHaveValue(
    "series-existing",
  );
  // The stalled PUT is answered by this test's own route, so the stub has
  // seen no series write at all; a keystroke-driven change would show here.
  expect(
    sent.filter((request) => request.pathname.startsWith("/api/g12f/")),
  ).toEqual([]);
});

test("deleted member validation failure can reload series without losing article draft", async ({
  page,
}) => {
  await stubSeriesApi(page, {
    deletedMemberFirstUpdate: true,
    initialSeries: [
      {
        id: "series-existing",
        name: "Existing series",
        created_at: "2026-01-01T00:00:00Z",
        pageorder_set: [
          {
            page: { free2zaddr: ARTICLE_ID, title: "Current article" },
            order: 0,
          },
          {
            page: { free2zaddr: "deleted-article", title: "Deleted article" },
            order: 1,
          },
        ],
      },
    ],
  });
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toBeVisible();
  await body.fill("Unsaved article draft survives series reload.");
  await openSeries(page);
  await page.getByRole("button", { name: "Manage series" }).click();
  await page.getByLabel("Series name").fill("Renamed series");
  await page.getByRole("button", { name: "Save series", exact: true }).click();
  // A validation failure keeps the dialog (and the author's edits) open.
  await expect(seriesDialog(page).getByRole("alert")).toContainText(
    "Request failed (400)",
  );
  await page.getByRole("button", { name: "Reload series" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(seriesDialog(page)).toHaveCount(0);
  await expect(body).toHaveValue(
    "Unsaved article draft survives series reload.",
  );
  await openSeries(page);
  await page.getByRole("button", { name: "Manage series" }).click();
  await expect(
    page.getByRole("list", { name: "Series reading order" }).locator("li"),
  ).toHaveCount(1);
  await page.getByLabel("Series name").fill("Renamed series");
  await page.getByRole("button", { name: "Save series", exact: true }).click();
  await expect(seriesDialog(page)).toHaveCount(0);
  await openSeries(page);
  await expect(
    page
      .getByLabel("Current series")
      .locator("option[value='series-existing']"),
  ).toHaveText("Renamed series");
});

test("series controls render in Spanish while preserving authored names", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("free2z-locale", "es"));
  await stubSeriesApi(page);
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(seriesTrigger(page)).toHaveText(/Serie:\s*Ninguna/);
  await openSeries(page);
  await expect(page.getByRole("button", { name: "Nueva serie" })).toBeVisible();
  await expect(
    page.getByLabel("Serie actual").locator("option[value='series-existing']"),
  ).toHaveText("Existing series");
  await page.getByLabel("Serie actual").selectOption("series-existing");
  await expect(
    page.getByRole("button", { name: "Mover First article después" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Guardar serie", exact: true }),
  ).toBeVisible();
});

test("new drafts explain how to unlock series controls, then allow creating a series", async ({
  page,
}) => {
  const hint =
    "Add content and save this page to create a series or add it to an existing one.";
  const sent = await stubSeriesApi(page);
  await page.goto("/edit?id=new");
  await expect(page.locator("textarea.writing-area-textarea")).toBeVisible({
    timeout: 30_000,
  });
  // The explanation lives behind the trigger, not in the page flow.
  await expect(seriesTrigger(page)).toBeEnabled();
  await expect(page.getByText(hint)).toHaveCount(0);
  await openSeries(page);
  await expect(page.getByText(hint)).toBeVisible();
  await expect(page.getByRole("button", { name: "New series" })).toBeDisabled();
  await expect(page.getByLabel("Current series")).toBeDisabled();
  expect(sent).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect(page.getByText(hint)).toHaveCount(0);
  await expect(seriesTrigger(page)).toBeFocused();
  await page
    .locator("textarea.writing-area-textarea")
    .fill("The first page of my series.");
  await page.keyboard.press("ControlOrMeta+s");
  await openSeries(page);
  await expect(page.getByRole("button", { name: "New series" })).toBeEnabled();
  await page.getByRole("button", { name: "New series" }).click();
  await page.getByLabel("Series name").fill("New draft series");
  await page
    .getByRole("button", { name: "Create series", exact: true })
    .click();
  await expect(seriesTrigger(page)).toHaveText(/Series:\s*New draft series/);
  await openSeries(page);
  await expect(page.getByLabel("Current series")).toHaveValue("series-created");
  expect(
    sent.find(
      (request) =>
        request.pathname === "/api/g12f/series/mine/" &&
        request.method === "POST",
    )?.body.pageorder_set,
  ).toEqual([{ page: { free2zaddr: ARTICLE_ID }, order: 0 }]);
});

test("a translated article can join and manage its page's series", async ({
  page,
}) => {
  // `lang=fr` selects the article translation, not the product UI locale.
  // Keep the UI in Spanish to exercise the two language choices independently.
  await page.addInitScript(() => localStorage.setItem("free2z-locale", "es"));
  const translated = {
    ...article(),
    title: "Titre traduit",
    content: "Corps traduit",
    actual_language: "fr",
    requested_language: "fr",
    available_languages: ["en", "fr"],
  };
  const sent = await stubSeriesApi(page, {
    articles: { [ARTICLE_ID]: translated },
  });
  await page.goto(`/edit?id=${ARTICLE_ID}&lang=fr`);
  await expect(page.locator("textarea.writing-area-textarea")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("textarea.writing-area-textarea")).toHaveValue(
    "Corps traduit",
  );
  await expect(page).toHaveURL(/lang=fr/);
  await openSeries(page);
  await expect(page.getByRole("button", { name: "Nueva serie" })).toBeVisible();
  await expect(page.getByLabel("Serie actual")).toBeVisible();
  await page.getByLabel("Serie actual").selectOption("series-existing");
  await expect(page.getByLabel("Nombre de la serie")).toHaveValue(
    "Existing series",
  );
  await page.getByLabel("Nombre de la serie").fill("All languages series");
  await page
    .getByRole("button", { name: "Guardar serie", exact: true })
    .click();
  await expect(seriesDialog(page, "Nombre de la serie")).toHaveCount(0);
  await openSeries(page);
  await expect(
    page.getByLabel("Serie actual").locator("option:checked"),
  ).toHaveText("All languages series");
  expect(
    sent.filter((request) => request.pathname.startsWith("/api/zpage/")),
  ).toEqual([]);
  expect(
    sent.find((request) => request.method === "PUT")?.body.pageorder_set,
  ).toContainEqual({ page: { free2zaddr: ARTICLE_ID }, order: 1 });
});

test("loading series never moves the writing surface", async ({ page }) => {
  //nothing that re-renders above the composer may shift it. Series
  // arrive after the article; a production-length name must not change the
  // metadata row's height at phone width (the default 390px viewport).
  await stubSeriesApi(page, {
    initialSeries: [
      {
        id: "long-series",
        name: "Building a Zcash memo scanner from scratch, one block at a time",
        created_at: "2026-01-01T00:00:00Z",
        pageorder_set: [
          { page: { free2zaddr: "one", title: "One" }, order: 0 },
          {
            page: { free2zaddr: ARTICLE_ID, title: "Current article" },
            order: 1,
          },
        ],
      },
    ],
  });
  let releaseSeries = () => {};
  const seriesGate = new Promise<void>((resolve) => (releaseSeries = resolve));
  await page.route("**/api/g12f/series/mine/**", async (route) => {
    await seriesGate;
    await route.fallback();
  });
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  const title = page.getByPlaceholder("Article title...");
  await expect(title).toBeVisible({ timeout: 30_000 });
  await expect(seriesTrigger(page)).toHaveText(/Series:\s*…/);
  const before = (await title.boundingBox())?.y;
  releaseSeries();
  await expect(seriesTrigger(page)).toHaveText(/\(2 of 2\)/);
  const after = (await title.boundingBox())?.y;
  expect(before).toBeDefined();
  expect(after).toBe(before);
});
