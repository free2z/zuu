import { expect, test, type Page, type Route } from "@playwright/test";

const INTENT = "x".repeat(43);
const CONNECTION = "11111111-1111-4111-8111-111111111111";
const GRANT = "22222222-2222-4222-8222-222222222222";
const APP = { name: "Example assistant", client_id: "example-assistant" };
const scopes = ["mcp:read", "mcp:write", "mcp:publish"];

function json(route: Route, status: number, value: unknown) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}

async function link(page: Page, username = "target-user") {
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/oauth/mcp/link/evaluate/", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ intent: INTENT });
    expect(new URL(route.request().url()).search).toBe("");
    expect(route.request().headers().referer).toBeUndefined();
    return json(route, 200, {
      expected_username: "target-user",
      signed_in_username: username,
      account_matches: username === "target-user",
      application: APP,
      connection: { id: CONNECTION, primary_username: "owner-user" },
      scopes,
      scope_descriptions: {},
      expires_at: "2099-01-01T00:00:00Z",
    });
  });
  await page.route("**/api/oauth/mcp/link/", (route) => {
    const body = route.request().postDataJSON();
    writes.push(body);
    return json(route, 200, { linked: body.allow });
  });
  return writes;
}

test("link review uses a clean URL, exact account and explicit reduced permissions", async ({
  page,
}) => {
  const writes = await link(page);
  const response = await page.goto(`/account/agent-link#intent=${INTENT}`);
  expect(response?.headers()["cache-control"]).toBe("no-store");
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(
    page.getByRole("button", { name: "Allow access" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Allow the Example assistant connection owned by @owner-user to act as @target-user with these permissions.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.getByText("@target-user", { exact: true })).toHaveCount(2);
  expect(writes).toEqual([]);
  await page
    .getByRole("checkbox", { name: "Publish or edit public pages and media" })
    .uncheck();
  await page.getByRole("button", { name: "Allow access" }).click();
  await expect(
    page.getByRole("heading", { name: "Account connected", exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([
    { intent: INTENT, allow: true, scopes: ["mcp:read", "mcp:write"] },
  ]);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("free2z:agent-link-intent:v1"),
    ),
  ).toBeNull();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("wrong account cannot approve and failed logout cannot navigate to sign-in", async ({
  page,
}) => {
  const writes = await link(page, "different-user");
  let logoutCalls = 0;
  await page.route("**/api/auth/logout/", (route) => {
    logoutCalls++;
    return json(route, 403, {});
  });
  await page.goto(`/account/agent-link#intent=${INTENT}`);
  await expect(
    page.getByText("@different-user", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow access" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Sign in as @target-user" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Could not sign out" }),
  ).toBeVisible();
  expect(logoutCalls).toBe(1);
  expect(new URL(page.url()).pathname).toBe("/account/agent-link");
  expect(writes).toEqual([]);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("free2z:agent-link-intent:v1"),
    ),
  ).toContain(INTENT);
});

test("successful account switch keeps the intent in its tab and out of login URL", async ({
  page,
}) => {
  await link(page, "different-user");
  const logoutPaths: string[] = [];
  await page.route("**/api/auth/logout/", (route) => {
    logoutPaths.push(new URL(route.request().url()).pathname);
    return json(route, 200, {});
  });
  await page.goto(`/account/agent-link#intent=${INTENT}`);
  await page.getByRole("button", { name: "Sign in as @target-user" }).click();
  await page.waitForURL("**/login?**");
  expect(logoutPaths).toEqual(["/api/auth/logout/"]);
  expect(new URL(page.url()).searchParams.get("next")).toBe(
    "/account/agent-link",
  );
  expect(page.url()).not.toContain(INTENT);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("free2z:agent-link-intent:v1"),
    ),
  ).toContain(INTENT);
});

test("declining clears the request without granting permissions", async ({
  page,
}) => {
  const writes = await link(page);
  await page.goto(`/account/agent-link#intent=${INTENT}`);
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Connection declined" }),
  ).toBeVisible();
  expect(writes).toEqual([{ intent: INTENT, allow: false }]);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("free2z:agent-link-intent:v1"),
    ),
  ).toBeNull();
});

test("connected accounts require confirmation and revoke the selected grant only", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route("**/api/oauth/grants/", (route) => json(route, 200, []));
  let revoked = false;
  const paths: string[] = [];
  await page.route("**/api/oauth/mcp/connections/", (route) =>
    json(route, 200, {
      connections: [
        {
          id: CONNECTION,
          application: APP,
          primary_username: "fixtureowner",
          scopes,
          revoked: false,
          accounts: [],
        },
      ],
      account_grants: revoked
        ? []
        : [
            {
              id: GRANT,
              connection_id: CONNECTION,
              application: APP,
              primary_username: "owner-user",
              username: "fixtureowner",
              scopes,
              revoked: false,
              available: true,
            },
          ],
      recent_actions: [
        {
          id: "activity-1",
          operation: "zpage_create",
          status: "success",
          created_at: "2026-11-07T04:00:00Z",
          primary_username: "owner-user",
          target_username: "fixtureowner",
          application: APP.name,
        },
      ],
    }),
  );
  await page.route(`**/api/oauth/mcp/grants/${GRANT}/`, (route) => {
    expect(route.request().method()).toBe("DELETE");
    paths.push(new URL(route.request().url()).pathname);
    revoked = true;
    return route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/account/apps");
  await page.getByRole("button", { name: "Remove account access" }).click();
  expect(paths).toEqual([]);
  await page
    .getByRole("button", { name: "Remove access", exact: true })
    .click();
  await expect(page.getByTestId("agent-account-grant")).toHaveCount(0);
  await expect(page.getByTestId("agent-connection")).toHaveCount(1);
  expect(paths).toEqual([`/api/oauth/mcp/grants/${GRANT}/`]);
  await expect(page.getByText("@fixtureowner · zpage_create")).toBeVisible();
});

test("initial consent can switch accounts without losing the MCP resource or PKCE request", async ({
  page,
}) => {
  const request = {
    response_type: "code",
    client_id: APP.client_id,
    redirect_uri: "https://assistant.example/callback",
    scope: "mcp:read mcp:write",
    resource: "https://free2z.cash/api/mcp",
    state: "s".repeat(32),
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  };
  const decisions: unknown[] = [];
  await page.route("**/api/oauth/authorize?**", (route) => {
    const received = new URL(route.request().url()).searchParams;
    expect(received.get("resource")).toBe(request.resource);
    return json(route, 200, {
      action: "consent",
      request_id: "signed-request",
      authorization_request: request,
      consent: {
        signed_in_username: "different-user",
        application: {
          ...APP,
          developer: null,
          logo_url: "",
          privacy_url: "",
          terms_url: "",
          first_party: false,
          child_directed: false,
          markup_bps: 0,
          markup_approval: "approved",
        },
        scopes: ["mcp:read", "mcp:write"],
        scope_descriptions: {},
        already_granted: [],
        cap_required: false,
        spend_cap: { spend_cap_2z: null, cap_period: "month" },
        is_raise_step_up_required: false,
      },
    });
  });
  await page.route("**/api/oauth/authorize", (route) => {
    decisions.push(route.request().postDataJSON());
    return json(route, 400, {});
  });
  const logoutPaths: string[] = [];
  await page.route("**/api/auth/logout/", (route) => {
    logoutPaths.push(new URL(route.request().url()).pathname);
    return json(route, 200, {});
  });
  await page.goto(`/oauth/authorize?${new URLSearchParams(request)}`);
  await expect(
    page.getByText("@different-user", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Switch account", exact: true })
    .click();
  await page.waitForURL("**/login?**");
  const returned = new URL(
    new URL(page.url()).searchParams.get("next")!,
    "https://free2z.cash",
  );
  expect(returned.searchParams.get("resource")).toBe(request.resource);
  expect(returned.searchParams.get("code_challenge")).toBe(
    request.code_challenge,
  );
  expect(returned.searchParams.get("state")).toBe(request.state);
  expect(returned.searchParams.get("prompt")).toBe("consent");
  expect(logoutPaths).toEqual(["/api/auth/logout/"]);
  expect(decisions).toEqual([]);
});

test("an uncertain approval checks connected apps instead of retrying the write", async ({
  page,
}) => {
  await link(page);
  let writes = 0;
  await page.route("**/api/oauth/mcp/link/", async (route) => {
    writes++;
    await page.route("**/api/oauth/mcp/link/evaluate/", (next) =>
      json(next, 404, { detail: "Request unavailable" }),
    );
    await route.abort("failed");
  });
  await page.goto(`/account/agent-link#intent=${INTENT}`);
  await page.getByRole("button", { name: "Allow access" }).click();
  await expect(
    page.getByRole("link", { name: "Open Connected apps" }),
  ).toHaveAttribute("href", "/account/apps");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "connection could not be confirmed" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow access" })).toHaveCount(
    0,
  );
  expect(writes).toBe(1);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("free2z:agent-link-intent:v1"),
    ),
  ).toBeNull();
});
