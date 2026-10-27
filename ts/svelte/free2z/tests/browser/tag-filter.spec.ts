import { expect, test, type Page } from "@playwright/test";
import { browserMockApiOrigin } from "./ports";

const MOCK_API_ORIGIN = browserMockApiOrigin();
const USERNAME = "tagfilterfixture";
const OWNER_SESSION = "tag-filter-owner-session";
const PROFILE_URL = `/${USERNAME}`;
const LONG_TAIL_TAG = "shielded-pool accounting notes";
const DRAFT_ONLY_TAG = "unpublished launch checklist";
const SLOW_TAG = "slow response sentinel";

type UpstreamRequest = {
  path: string;
  cookie: string | null;
};

function tagItems(page: Page, name: string) {
  return page.locator('[data-slot="command-item"]').filter({ hasText: name });
}

async function openTagFilter(page: Page) {
  const trigger = page.getByRole("combobox", { name: "Tag", exact: true });
  // SSR exposes the trigger before Svelte hydration has attached the
  // Popover handler. Retry the click until the actual interactive state opens.
  await expect
    .poll(
      async () => {
        if ((await trigger.getAttribute("aria-expanded")) !== "true") {
          await trigger.click();
        }
        return trigger.getAttribute("aria-expanded");
      },
      { timeout: 10_000 },
    )
    .toBe("true");
  const input = page.locator('[data-slot="command-input"]');
  await expect(input).toBeVisible();
  return input;
}

async function upstreamRequests(request: {
  get: (url: string) => Promise<{ json: () => Promise<unknown> }>;
}) {
  const response = await request.get(`${MOCK_API_ORIGIN}/__requests`);
  return (await response.json()) as UpstreamRequest[];
}

async function resetUpstreamRequests(request: {
  delete: (url: string) => Promise<unknown>;
}) {
  await request.delete(`${MOCK_API_ORIGIN}/__requests`);
}

function tagRequests(requests: UpstreamRequest[]) {
  return requests.filter((entry) => {
    const url = new URL(entry.path, MOCK_API_ORIGIN);
    return (
      url.pathname === "/api/tagging/autocomplete" &&
      url.searchParams.get("username") === USERNAME
    );
  });
}

async function authenticate(page: Page) {
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: "sessionid",
      value: OWNER_SESSION,
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
}

async function routeTagAutocomplete(page: Page) {
  await page.route(
    (url) => url.pathname === "/api/tagging/autocomplete",
    async (route) => {
      const requestUrl = new URL(route.request().url());
      const upstream = await route.fetch({
        url: `${MOCK_API_ORIGIN}${requestUrl.pathname}${requestUrl.search}`,
      });
      await route.fulfill({ response: upstream });
    },
  );
}

test("the initial cap is only a starting vocabulary for public profiles", async ({
  page,
  request,
}) => {
  await page.context().clearCookies();
  await resetUpstreamRequests(request);
  await routeTagAutocomplete(page);
  await page.goto(PROFILE_URL);

  const input = await openTagFilter(page);
  const initialItems = page.locator('[data-slot="command-item"]');
  // One clear-selection item plus exactly the endpoint's 100-item initial cap.
  await expect(initialItems).toHaveCount(101);
  await expect(tagItems(page, LONG_TAIL_TAG)).toHaveCount(0);

  await input.fill("shielded-pool accounting");
  await expect(tagItems(page, LONG_TAIL_TAG)).toBeVisible();
  await tagItems(page, LONG_TAIL_TAG).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("tag"))
    .toBe(LONG_TAIL_TAG);

  const requests = tagRequests(await upstreamRequests(request));
  expect(requests.length).toBeGreaterThan(0);
  expect(
    requests.every(
      (entry) => !new URL(entry.path, MOCK_API_ORIGIN).searchParams.has("mine"),
    ),
  ).toBe(true);
});

test("an owner profile uses public tag scope and hides a draft-only tag", async ({
  page,
  request,
}) => {
  await authenticate(page);
  await resetUpstreamRequests(request);
  await routeTagAutocomplete(page);
  await page.goto(PROFILE_URL);

  const initialRequests = tagRequests(await upstreamRequests(request));
  const initial = initialRequests.find(
    (entry) => !new URL(entry.path, MOCK_API_ORIGIN).searchParams.has("query"),
  );
  expect(initial).toBeDefined();
  const initialUrl = new URL(initial!.path, MOCK_API_ORIGIN);
  expect(initialUrl.searchParams.has("mine")).toBe(false);
  expect(initial!.cookie).toContain(`sessionid=${OWNER_SESSION}`);

  const input = await openTagFilter(page);
  await input.fill("unpublished launch");
  await expect(page.getByText("No tag found.", { exact: true })).toBeVisible();
  await expect(tagItems(page, DRAFT_ONLY_TAG)).toHaveCount(0);

  const requests = tagRequests(await upstreamRequests(request));
  const remote = requests.find((entry) =>
    new URL(entry.path, MOCK_API_ORIGIN).searchParams.has("query"),
  );
  expect(remote).toBeDefined();
  expect(new URL(remote!.path, MOCK_API_ORIGIN).searchParams.has("mine")).toBe(
    false,
  );
  expect(remote!.cookie).toContain(`sessionid=${OWNER_SESSION}`);
});

test("a public visitor cannot search an owner's draft-only tag", async ({
  page,
  request,
}) => {
  await page.context().clearCookies();
  await resetUpstreamRequests(request);
  await routeTagAutocomplete(page);
  await page.goto(PROFILE_URL);

  const input = await openTagFilter(page);
  await input.fill("unpublished launch");
  await expect(page.getByText("No tag found.", { exact: true })).toBeVisible();
  await expect(tagItems(page, DRAFT_ONLY_TAG)).toHaveCount(0);

  const requests = tagRequests(await upstreamRequests(request));
  expect(requests.length).toBeGreaterThan(0);
  expect(
    requests.every(
      (entry) => !new URL(entry.path, MOCK_API_ORIGIN).searchParams.has("mine"),
    ),
  ).toBe(true);
});

test("a late response cannot replace the current tag query", async ({
  page,
}) => {
  await page.context().clearCookies();
  await routeTagAutocomplete(page);
  await page.goto(PROFILE_URL);

  const input = await openTagFilter(page);
  const slowRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname === "/api/tagging/autocomplete" &&
      url.searchParams.get("query") === "slow"
    );
  });
  await input.fill("slow");
  await slowRequest;

  await input.fill("shielded-pool accounting");
  await expect(tagItems(page, LONG_TAIL_TAG)).toBeVisible();
  await expect(tagItems(page, SLOW_TAG)).toHaveCount(0);
  // The mock deliberately resolves the slow response after this query. It
  // must remain ignored even after the transport has had time to finish.
  await page.waitForTimeout(600);
  await expect(tagItems(page, LONG_TAIL_TAG)).toBeVisible();
  await expect(tagItems(page, SLOW_TAG)).toHaveCount(0);
});
