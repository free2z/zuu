import { expect, test, type Page, type Route } from "@playwright/test";
import { devSourceModuleLoader } from "./dev-source-module";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Connected apps (`/account/apps`) and the developer console
 * (`/developers/apps`) —, zuu docs/free2z/sdk/spec/oidc.md §2, §3, §5.
 *
 * The SSR guard reads the shared mock API (this session is `fixtureowner`
 * there); the pages' own calls are mocked at the browser so each test owns
 * its data. Assertions on writes read the request the page SENT.
 *
 * NEGATIVE CONTROLS (run by hand, ): removing the confirm dialog from
 * `askRevoke` (calling `confirmRevoke` directly) turns "revoke asks first"
 * red (no dialog: the grant is deleted on the first click); dropping the
 * `uriProblems.length` check in `save()` turns "redirect URIs are checked
 * line by line" red (the form submits the bad URIs instead of refusing).
 */

const SESSION = "billing-fixture-session";

async function signIn(page: Page) {
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([
      { name: "sessionid", value: SESSION, domain: "127.0.0.1", path: "/" },
    ]);
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: body === null ? "" : JSON.stringify(body),
  });
}

const GRANTS = [
  {
    client_id: "tutor-client",
    application_id: "11111111-1111-4111-8111-111111111111",
    name: "Corpora Tutor",
    developer: "corpora",
    scope: ["openid", "profile", "ai:invoke"],
    spend_cap_2z: 1000,
    cap_period: "month",
    markup_bps: 2000,
    generation: 1,
    consented_at: "2026-09-20T12:00:00Z",
  },
  {
    client_id: "reader-client",
    application_id: "22222222-2222-4222-8222-222222222222",
    name: "Balance Reader",
    developer: null,
    scope: ["openid", "balance:read"],
    spend_cap_2z: null,
    cap_period: "month",
    markup_bps: 0,
    generation: 3,
    consented_at: "2026-09-21T12:00:00Z",
  },
];

type CapAnswer = { status: number; body: unknown };

async function mockGrants(
  page: Page,
  options: { cap?: (body: Record<string, unknown>) => CapAnswer } = {},
) {
  const deleted: string[] = [];
  const caps: { path: string; body: Record<string, unknown> }[] = [];
  await page.route(
    (url) => url.pathname.startsWith("/api/oauth/grants/"),
    (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/api/oauth/grants/") {
        return json(route, 200, GRANTS);
      }
      if (request.method() === "PUT" && url.pathname.endsWith("/cap/")) {
        const body = request.postDataJSON() as Record<string, unknown>;
        caps.push({ path: url.pathname, body });
        const answer = options.cap?.(body) ?? {
          status: 200,
          body: { ...GRANTS[0], ...body },
        };
        return json(route, answer.status, answer.body);
      }
      if (request.method() === "DELETE") {
        deleted.push(url.pathname.split("/").filter(Boolean).pop() ?? "");
        return route.fulfill({ status: 204, body: "" });
      }
      return json(route, 405, {});
    },
  );
  return { deleted, caps };
}

test("connected apps: an anonymous visitor is sent to /login and back", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto("/account/apps");
  await page.waitForURL("**/login?**");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/account/apps");
});

test("connected apps: each grant shows its scopes, limit and markup", async ({
  page,
}) => {
  await signIn(page);
  await mockGrants(page);
  await page.goto("/account/apps");

  await expect(
    page.getByRole("link", { name: "Manage balance and purchases" }),
  ).toHaveAttribute("href", "/fixtureowner/dashboard/billing");
  const apps = page.getByTestId("connected-app");
  await expect(apps).toHaveCount(2);
  const tutor = apps.filter({ hasText: "Corpora Tutor" });
  await expect(tutor).toContainText("Made by @corpora");
  await expect(tutor.getByTestId("connected-app-limit-value")).toHaveText(
    "1,000 2Z per month",
  );
  await expect(tutor).toContainText("This app adds 20% on top of the AI cost.");
  const reader = apps.filter({ hasText: "Balance Reader" });
  await expect(reader).toContainText("See your 2Z credit balance");
  // No ai:invoke, no limit line; no markup, no markup line.
  await expect(reader.getByTestId("connected-app-limit")).toHaveCount(0);
  await expect(reader).not.toContainText("on top of the AI cost");
});

test("connected apps: revoke asks first, then removes the grant", async ({
  page,
}) => {
  await signIn(page);
  const { deleted } = await mockGrants(page);
  await page.goto("/account/apps");
  await page.waitForLoadState("networkidle");

  const tutor = page
    .getByTestId("connected-app")
    .filter({ hasText: "Corpora Tutor" });
  await tutor.getByTestId("connected-app-revoke").click();
  const dialog = page.getByTestId("connected-app-revoke-dialog");
  await expect(dialog).toContainText("Remove Corpora Tutor's access?");
  expect(deleted).toHaveLength(0);

  // Changing your mind sends nothing.
  await dialog.getByRole("button", { name: "Keep access" }).click();
  await expect(dialog).toHaveCount(0);
  expect(deleted).toHaveLength(0);

  await tutor.getByTestId("connected-app-revoke").click();
  await page.getByTestId("connected-app-revoke-confirm").click();
  await expect(page.getByTestId("connected-apps-notice")).toHaveText(
    "Corpora Tutor no longer has access.",
  );
  expect(deleted).toEqual([GRANTS[0].application_id]);
  await expect(page.getByTestId("connected-app")).toHaveCount(1);
});

// ------------------------------------------------------------- developers

type DevApp = Record<string, unknown>;

function devApp(overrides: DevApp = {}): DevApp {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    client_id: "abcDEF123",
    client_type: "public",
    name: "Tutor Desktop",
    redirect_uris: ["http://127.0.0.1:0/callback"],
    allowed_scopes: ["openid", "ai:invoke"],
    allowed_origins: [],
    markup_bps: 0,
    approved_markup_bps: null,
    effective_markup_bps: 0,
    markup_approval: "none",
    default_spend_cap_2z: null,
    default_cap_period: "month",
    logo_url: "",
    privacy_url: "",
    terms_url: "",
    first_party: false,
    frozen: false,
    has_client_secret: false,
    created: "2026-09-27T12:00:00Z",
    updated: "2026-09-27T12:00:00Z",
    ...overrides,
  };
}

async function mockDeveloperApps(
  page: Page,
  options: {
    initial?: DevApp[];
    create?: (body: DevApp) => { status: number; body: unknown };
    destroy?: () => { status: number; body: unknown };
  } = {},
) {
  const created: DevApp[] = [];
  const rotated: string[] = [];
  const destroyed: string[] = [];
  await page.route(
    (url) => url.pathname.startsWith("/api/oauth/apps/"),
    (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/oauth/apps/" && request.method() === "GET") {
        return json(route, 200, options.initial ?? []);
      }
      if (path === "/api/oauth/apps/" && request.method() === "POST") {
        const body = request.postDataJSON() as DevApp;
        created.push(body);
        const answer = options.create?.(body) ?? {
          status: 201,
          body: {
            ...devApp({
              ...body,
              id: "44444444-4444-4444-8444-444444444444",
              client_id: "newClientId",
              effective_markup_bps: 0,
              markup_approval:
                (body.markup_bps as number) > 0 ? "pending" : "none",
              has_client_secret: body.client_type === "confidential",
            }),
            client_secret:
              body.client_type === "confidential" ? "s3cr3t-shown-once" : null,
          },
        };
        return json(route, answer.status, answer.body);
      }
      if (path.endsWith("/rotate-secret/") && request.method() === "POST") {
        rotated.push(path);
        return json(route, 200, { client_secret: "r0tated-secret" });
      }
      if (request.method() === "DELETE") {
        destroyed.push(path);
        const answer = options.destroy?.() ?? { status: 204, body: null };
        return json(route, answer.status, answer.body);
      }
      return json(route, 405, {});
    },
  );
  return { created, rotated, destroyed };
}

test("developer console: redirect URIs are checked line by line before anything is sent", async ({
  page,
}) => {
  await signIn(page);
  const { created } = await mockDeveloperApps(page);
  await page.goto("/developers/apps");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("dev-app-new").click();

  await page.getByTestId("dev-app-name").fill("Tutor Desktop");
  const redirects = page.getByTestId("dev-app-redirects");
  await redirects.fill(
    "http://localhost:8080/callback\nhttps://tutor.example.test/cb?x=1\nhttp://127.0.0.1:0/callback",
  );
  const feedback = page.getByTestId("dev-app-redirect-problem");
  await expect(feedback).toHaveCount(2);
  await expect(feedback.nth(0)).toContainText("“localhost” is not accepted");
  await expect(feedback.nth(1)).toContainText("cannot contain a query string");
  await expect(redirects).toHaveAttribute("aria-invalid", "true");

  await page.getByTestId("dev-app-save").click();
  await expect(page.getByTestId("dev-app-save-error")).toBeVisible();
  expect(created).toHaveLength(0);

  // A confidential client may register https only (spec §3).
  await redirects.fill("http://127.0.0.1:0/callback");
  await expect(feedback).toHaveCount(0);
  await page.getByTestId("dev-app-type-confidential").check();
  await expect(feedback).toHaveCount(1);
  await expect(feedback).toContainText("may only register https");
});

test("developer console: registering a confidential client shows its secret once", async ({
  page,
}) => {
  await signIn(page);
  const { created } = await mockDeveloperApps(page);
  await page.goto("/developers/apps");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("dev-apps-empty")).toBeVisible();

  await page.getByTestId("dev-app-new").click();
  await page.getByTestId("dev-app-name").fill("Tutor Server");
  await page.getByTestId("dev-app-type-confidential").check();
  await page
    .getByTestId("dev-app-redirects")
    .fill("https://api.tutor.example.test/oauth/callback");
  await page.locator('input[data-scope="ai:invoke"]').check();
  await page.getByTestId("dev-app-markup").fill("12.5");
  await page.getByTestId("dev-app-save").click();

  const dialog = page.getByTestId("dev-app-secret-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("dev-app-secret")).toHaveText(
    "s3cr3t-shown-once",
  );
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    name: "Tutor Server",
    client_type: "confidential",
    redirect_uris: ["https://api.tutor.example.test/oauth/callback"],
    allowed_scopes: ["openid", "profile", "ai:invoke"],
    allowed_origins: [],
    markup_bps: 1250,
    default_spend_cap_2z: null,
  });

  await page.getByTestId("dev-app-secret-done").click();
  await expect(dialog).toHaveCount(0);
  // Gone from the page for good.
  await expect(page.getByText("s3cr3t-shown-once")).toHaveCount(0);

  const app = page.getByTestId("dev-app");
  await expect(app).toHaveCount(1);
  await expect(app.getByTestId("dev-app-client-id")).toHaveText("newClientId");
  await expect(app.getByTestId("dev-app-markup-status")).toHaveText(
    "12.5% requested, pending approval. 0% applies now.",
  );
});

test("developer console: a public client is issued no secret", async ({
  page,
}) => {
  await signIn(page);
  const { created } = await mockDeveloperApps(page);
  await page.goto("/developers/apps");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("dev-app-new").click();
  await page.getByTestId("dev-app-name").fill("Tutor Desktop");
  await page
    .getByTestId("dev-app-redirects")
    .fill("http://127.0.0.1:0/callback\ncom.example.tutor:/oauth/callback");
  await page.getByTestId("dev-app-save").click();

  await expect(page.getByTestId("dev-apps-notice")).toHaveText(
    "Tutor Desktop was registered.",
  );
  await expect(page.getByTestId("dev-app-secret-dialog")).toHaveCount(0);
  expect(created[0]).toMatchObject({
    client_type: "public",
    redirect_uris: [
      "http://127.0.0.1:0/callback",
      "com.example.tutor:/oauth/callback",
    ],
  });
  await expect(page.getByTestId("dev-app-rotate")).toHaveCount(0);
});

test("developer console: the server's refusal is shown next to the field", async ({
  page,
}) => {
  await signIn(page);
  await mockDeveloperApps(page, {
    create: () => ({
      status: 400,
      body: {
        redirect_uris: [
          "https://tutor.example.test/cb: association file missing",
        ],
      },
    }),
  });
  await page.goto("/developers/apps");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("dev-app-new").click();
  await page.getByTestId("dev-app-name").fill("Tutor");
  await page
    .getByTestId("dev-app-redirects")
    .fill("https://tutor.example.test/cb");
  await page.getByTestId("dev-app-save").click();
  await expect(page.getByTestId("dev-app-redirect-feedback")).toContainText(
    "association file missing",
  );
  await expect(page.getByTestId("dev-app-form")).toBeVisible();
});

test("developer console: rotating a secret asks first and shows the new one", async ({
  page,
}) => {
  await signIn(page);
  const { rotated } = await mockDeveloperApps(page, {
    initial: [
      devApp({
        client_type: "confidential",
        name: "Tutor Server",
        redirect_uris: ["https://api.tutor.example.test/cb"],
        markup_bps: 2000,
        approved_markup_bps: 2000,
        effective_markup_bps: 2000,
        markup_approval: "approved",
        has_client_secret: true,
      }),
    ],
  });
  await page.goto("/developers/apps");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("dev-app-markup-status")).toHaveText(
    "20% (approved)",
  );

  await page.getByTestId("dev-app-rotate").click();
  await expect(page.getByTestId("dev-app-rotate-dialog")).toContainText(
    "stops working immediately",
  );
  expect(rotated).toHaveLength(0);
  await page.getByTestId("dev-app-rotate-confirm").click();
  await expect(page.getByTestId("dev-app-secret")).toHaveText("r0tated-secret");
  expect(rotated).toEqual([
    "/api/oauth/apps/33333333-3333-4333-8333-333333333333/rotate-secret/",
  ]);
});

test("developer console: an app people connected cannot be deleted, and says so", async ({
  page,
}) => {
  await signIn(page);
  const { destroyed } = await mockDeveloperApps(page, {
    initial: [devApp()],
    destroy: () => ({
      status: 409,
      body: { code: "app_has_authorizations", detail: "users have authorized" },
    }),
  });
  await page.goto("/developers/apps");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("dev-app-delete").click();
  await page.getByTestId("dev-app-delete-confirm").click();
  await expect(page.getByTestId("dev-app-delete-error")).toContainText(
    "People have connected this app",
  );
  expect(destroyed).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("dev-app")).toHaveCount(1);
});

test("developer console: a rotation with no answer does not claim the old secret still works", async ({
  page,
}) => {
  await signIn(page);
  await page.route(
    (url) => url.pathname.startsWith("/api/oauth/apps/"),
    (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/rotate-secret/")) {
        return json(route, 502, { detail: "bad gateway" });
      }
      return json(route, 200, [
        devApp({ client_type: "confidential", has_client_secret: true }),
      ]);
    },
  );
  await page.goto("/developers/apps");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("dev-app-rotate").click();
  await page.getByTestId("dev-app-rotate-confirm").click();
  const dialog = page.getByTestId("dev-app-rotate-dialog");
  await expect(dialog).toContainText("may no longer work");
  await expect(dialog).not.toContainText("still works");
});

// ------------------------------------------------------------------
//
// NEGATIVE CONTROLS (run by hand, ): replacing `stepUpPhase(...)` in
// `saveLimit` with `"stepUp"` turns "a raise asks for a fresh sign-in, once"
// red (Sign in again is offered a second time); dropping the `origins`
// problem from `payloadFromForm` turns "origins are checked line by line"
// red (the bad origin is POSTed).

const STEP_UP = {
  status: 401,
  body: {
    code: "insufficient_user_authentication",
    detail:
      "raising a spend cap requires authentication within the last 5 minutes",
    max_age: 300,
  },
};

test("connected apps: lowering a limit is sent explicitly and applies", async ({
  page,
}) => {
  await signIn(page);
  const { caps } = await mockGrants(page);
  await page.goto("/account/apps");
  const tutor = page
    .getByTestId("connected-app")
    .filter({ hasText: "Corpora Tutor" });
  await tutor.getByTestId("connected-app-limit-edit").click();
  const dialog = page.getByTestId("connected-app-limit-dialog");
  await expect(dialog).toContainText("Now: 1,000 2Z per month");
  // Unchanged: nothing to save.
  await expect(page.getByTestId("connected-app-limit-save")).toBeDisabled();

  await page.getByTestId("connected-app-limit-amount").fill("500");
  await expect(page.getByTestId("connected-app-limit-raise-note")).toHaveCount(
    0,
  );
  await page.getByTestId("connected-app-limit-save").click();
  await expect(page.getByTestId("connected-apps-notice")).toHaveText(
    "The spending limit for Corpora Tutor was updated.",
  );
  expect(caps).toEqual([
    {
      path: `/api/oauth/grants/${GRANTS[0].application_id}/cap/`,
      body: { spend_cap_2z: 500, cap_period: "month" },
    },
  ]);
  await expect(tutor.getByTestId("connected-app-limit-value")).toHaveText(
    "500 2Z per month",
  );
  // A grant without ai:invoke has no limit to edit.
  await expect(
    page
      .getByTestId("connected-app")
      .filter({ hasText: "Balance Reader" })
      .getByTestId("connected-app-limit-edit"),
  ).toHaveCount(0);
});

test("connected apps: no limit takes the confirmation and is sent as null", async ({
  page,
}) => {
  await signIn(page);
  const { caps } = await mockGrants(page);
  await page.goto("/account/apps");
  await page.getByTestId("connected-app-limit-edit").click();
  await page.getByTestId("connected-app-limit-kind-none").check();
  await expect(page.getByTestId("connected-app-limit-save")).toBeDisabled();
  await page.getByTestId("connected-app-limit-none-confirm").check();
  await expect(
    page.getByTestId("connected-app-limit-raise-note"),
  ).toBeVisible();
  await page.getByTestId("connected-app-limit-save").click();
  await expect(page.getByTestId("connected-apps-notice")).toBeVisible();
  expect(caps.map((c) => c.body)).toEqual([
    { spend_cap_2z: null, cap_period: "month" },
  ]);
});

test("connected apps: a raise asks for a fresh sign-in, once", async ({
  page,
}) => {
  await signIn(page);
  const { caps } = await mockGrants(page, { cap: () => STEP_UP });
  let loggedOut = 0;
  await page.route("**/api/auth/logout/", async (route) => {
    loggedOut += 1;
    // Really signed out: /login must not bounce a live session onward.
    await page.context().clearCookies();
    return route.fulfill({ status: 200, body: "{}" });
  });
  await page.goto("/account/apps");
  await page.getByTestId("connected-app-limit-edit").click();
  await page.getByTestId("connected-app-limit-amount").fill("5000");
  await expect(
    page.getByTestId("connected-app-limit-raise-note"),
  ).toBeVisible();
  await page.getByTestId("connected-app-limit-save").click();

  const stepUp = page.getByTestId("connected-app-limit-step-up");
  await expect(stepUp).toBeVisible();
  expect(loggedOut).toBe(0);
  await page.getByTestId("connected-app-limit-reauth").click();
  await page.waitForURL("**/login?**");
  expect(loggedOut).toBe(1);
  const login = new URL(page.url());
  expect(login.searchParams.get("reason")).toBe("confirm-limit");
  const next = new URL(
    login.searchParams.get("next") ?? "",
    "https://free2z.test",
  );
  expect(next.pathname).toBe("/account/apps");
  expect(next.searchParams.get("edit_limit")).toBe(GRANTS[0].application_id);
  expect(next.searchParams.get("f2z_reauth")).toBe("1");

  // Back from the sign-in: the editor reopens for that app, and when the
  // backend STILL refuses, the page stops instead of offering another one.
  await signIn(page);
  await page.goto(`${next.pathname}${next.search}`);
  const dialog = page.getByTestId("connected-app-limit-dialog");
  await expect(dialog).toContainText("Spending limit for Corpora Tutor");
  await page.getByTestId("connected-app-limit-amount").fill("5000");
  await page.getByTestId("connected-app-limit-save").click();
  await expect(
    page.getByTestId("connected-app-limit-step-up-loop"),
  ).toBeVisible();
  await expect(page.getByTestId("connected-app-limit-reauth")).toHaveCount(0);
  expect(caps).toHaveLength(2);
  expect(loggedOut).toBe(1);

  // The guard covers that one attempt: once the editor closes, the marker
  // is gone, and a later raise gets its sign-in offer again.
  await page.getByRole("button", { name: "Keep my current limit" }).click();
  await expect(page).not.toHaveURL(/f2z_reauth/);
  await page.getByTestId("connected-app-limit-edit").click();
  await page.getByTestId("connected-app-limit-amount").fill("5000");
  await page.getByTestId("connected-app-limit-save").click();
  await expect(page.getByTestId("connected-app-limit-step-up")).toBeVisible();
  await expect(page.getByTestId("connected-app-limit-reauth")).toBeVisible();
});

test("developer console: origins and consent links are checked before anything is sent", async ({
  page,
}) => {
  await signIn(page);
  const { created } = await mockDeveloperApps(page);
  await page.goto("/developers/apps");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("dev-app-new").click();
  await page.getByTestId("dev-app-name").fill("Tutor Web");
  await page
    .getByTestId("dev-app-redirects")
    .fill("https://tutor.example.test/cb");

  const origins = page.getByTestId("dev-app-origins");
  await origins.fill(
    "https://tutor.example.test/\nhttps://stage.free2z.cash\nhttps://Tutor.Example.test:443\nhttps://tutor.example.test",
  );
  const problems = page.getByTestId("dev-app-origin-problem");
  await expect(problems).toHaveCount(3);
  await expect(problems.nth(0)).toContainText("has no path");
  await expect(problems.nth(1)).toContainText("Free2Z's own domains");
  await expect(problems.nth(2)).toContainText("https://tutor.example.test");
  await expect(origins).toHaveAttribute("aria-invalid", "true");
  // The origins alone keep the form from being sent.
  await page.getByTestId("dev-app-save").click();
  await expect(page.getByTestId("dev-app-save-error")).toBeVisible();
  expect(created).toHaveLength(0);

  // So does an http consent-screen link, on its own.
  await origins.fill("https://tutor.example.test");
  await expect(problems).toHaveCount(0);
  await page
    .getByTestId("dev-app-privacy")
    .fill("http://tutor.example.test/privacy");
  await page.getByTestId("dev-app-save").click();
  await expect(page.getByTestId("dev-app-form")).toContainText(
    "Use an https:// address.",
  );
  expect(created).toHaveLength(0);

  await page
    .getByTestId("dev-app-privacy")
    .fill("https://tutor.example.test/privacy");
  await page.getByTestId("dev-app-save").click();
  await expect(page.getByTestId("dev-apps-notice")).toHaveText(
    "Tutor Web was registered.",
  );
  expect(created[0]).toMatchObject({
    allowed_origins: ["https://tutor.example.test"],
    privacy_url: "https://tutor.example.test/privacy",
  });
});

test("developer console: a refused lookalike name is shown next to the field", async ({
  page,
}) => {
  await signIn(page);
  const { created } = await mockDeveloperApps(page, {
    create: () => ({
      status: 400,
      body: {
        name: [
          'an app name may not contain "Free2Z" or a name that looks like it; only Free2Z\'s own apps may',
        ],
      },
    }),
  });
  await page.goto("/developers/apps");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("dev-app-new").click();
  await expect(page.getByTestId("dev-app-form")).toContainText(
    "It cannot include “Free2Z”",
  );
  await page.getByTestId("dev-app-name").fill("Fr\u0435e 2 Z Tutor");
  await page
    .getByTestId("dev-app-redirects")
    .fill("https://tutor.example.test/cb");
  await page.getByTestId("dev-app-save").click();
  await expect(page.getByTestId("dev-app-save-error")).toBeVisible();
  expect(created).toHaveLength(1);
  await expect(page.getByTestId("dev-app-form")).toContainText(
    'may not contain "Free2Z"',
  );
  await expect(page.getByTestId("dev-app-name")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

// --- "Manage Free2Z account": /account/apps?client_id=<id> -----------------
//
// The landing page an SDK app opens in the system browser (zuu
// docs/free2z/sdk/INTEGRATION.md). It focuses on that one app and is account
// management, never a sales pitch: no purchase link, no price, and no site
// navigation or footer (the account menu reaches Credits) — the only link
// left is account deletion.
//
// NEGATIVE CONTROLS (run by hand): rendering the "Manage balance and
// purchases" block whatever `focused` says, or dropping the `/account/apps`
// case from `isSdkPage` in $lib/sdk-flow.ts, turns "the focused view" red on
// the link assertion.

/**
 * The deletion page lands in its own change; until a build contains it, the
 * Manage page must not link to it (never a link to a 404).
 */
const HAS_DELETE_PAGE =
  globSync("src/routes/account/delete/+page.svelte", {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
  }).length > 0;
const MANAGE_LINKS = HAS_DELETE_PAGE ? ["/account/delete"] : [];

/** A burner account: no email, a balance with sub-cent digits. */
const BURNER = { id: 4301, username: "fixtureowner", tuzis: "1234.567" };

async function mockBurner(page: Page) {
  await page.route(
    (url) => url.pathname === "/api/auth/user/",
    (route) => json(route, 200, BURNER),
  );
}

/** Every same-site link on the page, chrome included, as a path. */
async function sameSiteLinks(page: Page) {
  const origin = new URL(page.url()).origin;
  const hrefs = await page
    .locator("a[href]")
    .evaluateAll((anchors) =>
      anchors.map((a) => (a as HTMLAnchorElement).href),
    );
  return hrefs
    .map((href) => new URL(href))
    .filter((url) => url.origin === origin)
    .map((url) => url.pathname + url.search);
}

test("manage account: the focused view shows the account, balance, this app's budget, revoke and delete — and nothing to buy", async ({
  page,
}) => {
  await signIn(page);
  await mockBurner(page);
  await mockGrants(page);
  await page.goto("/account/apps?client_id=tutor-client");

  await expect(page.getByTestId("manage-username")).toHaveText("@fixtureowner");
  // Neutral and truncated, never rounded up.
  await expect(page.getByTestId("manage-balance")).toHaveText("1,234.56 2Z");
  const apps = page.getByTestId("connected-app");
  await expect(apps).toHaveCount(1);
  await expect(apps).toHaveAttribute("data-client-id", "tutor-client");
  await expect(apps.getByTestId("connected-app-limit-value")).toHaveText(
    "1,000 2Z per month",
  );
  await expect(apps.getByTestId("connected-app-revoke")).toBeVisible();
  if (HAS_DELETE_PAGE) {
    await expect(page.getByTestId("manage-delete-account")).toHaveAttribute(
      "href",
      "/account/delete",
    );
  } else {
    await expect(page.getByTestId("manage-delete-account")).toHaveCount(0);
  }

  expect(await sameSiteLinks(page)).toEqual(MANAGE_LINKS);
  await expect(
    page.getByRole("link", { name: "Manage balance and purchases" }),
  ).toHaveCount(0);
});

test("manage account: removing this app's access leaves the account page, not a dead end", async ({
  page,
}) => {
  await signIn(page);
  await mockBurner(page);
  const { deleted } = await mockGrants(page);
  await page.goto("/account/apps?client_id=tutor-client");
  await page.getByTestId("connected-app-revoke").click();
  await page.getByTestId("connected-app-revoke-confirm").click();

  await expect(page.getByTestId("connected-apps-empty")).toHaveText(
    "This app is not connected to your Free2Z account.",
  );
  expect(deleted).toEqual([GRANTS[0].application_id]);
  await expect(page.getByTestId("manage-delete-account")).toHaveCount(
    HAS_DELETE_PAGE ? 1 : 0,
  );
});

test("manage account: an app that is not connected says so, without listing the others", async ({
  page,
}) => {
  await signIn(page);
  await mockBurner(page);
  await mockGrants(page);
  await page.goto("/account/apps?client_id=unknown-client");

  await expect(page.getByTestId("connected-apps-empty")).toHaveText(
    "This app is not connected to your Free2Z account.",
  );
  await expect(page.getByTestId("connected-app")).toHaveCount(0);
  await expect(page.getByTestId("manage-balance")).toHaveText("1,234.56 2Z");
});

test("manage account: an unusable client_id is a calm page, never an error or the full list", async ({
  page,
}) => {
  await signIn(page);
  await mockBurner(page);
  await mockGrants(page);
  for (const clientId of ["", "x".repeat(300), "tutor-client\u0001"]) {
    const response = await page.goto(
      `/account/apps?client_id=${encodeURIComponent(clientId)}`,
    );
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("connected-apps-empty")).toHaveText(
      "This app is not connected to your Free2Z account.",
    );
    await expect(page.getByTestId("connected-app")).toHaveCount(0);
    expect(await sameSiteLinks(page)).toEqual(MANAGE_LINKS);
  }
});

test("manage account: a signed-out visitor signs in and comes back to the same app", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto("/account/apps?client_id=tutor-client");
  await page.waitForURL("**/login?**");
  expect(new URL(page.url()).searchParams.get("next")).toBe(
    "/account/apps?client_id=tutor-client",
  );
  // The sign-in on the way is SDK-facing too: no chrome, and X is offered
  // (an X-only account must be able to reach this page to revoke an app or
  // delete the account), returning here rather than to the dashboard.
  await expect(page.locator("#username")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with X" }),
  ).toBeVisible();
  expect(await sameSiteLinks(page)).toEqual([]);
});

// X-only accounts (no password, often no email) reach the Manage and
// deletion exits through /login: "Sign in with X" must be offered there and
// carry the exit so the sign-in lands back on it (py/dj/apps/twitter/views.py
// safe_x_return_path; the round trips are pinned server-side in
// py/dj/apps/oidc/tests/test_x_only_account_exits.py).
//
// NEGATIVE CONTROL (run by hand): dropping `xReturnPath` from the
// `fetchTwitterAuthorizeUrl` call in UnifiedAuthModal.svelte turns both red.
for (const exit of [
  "/account/apps?client_id=tutor-client",
  "/account/delete",
]) {
  test(`an X-only account can sign in from ${exit.split("?")[0]}'s /login and land back on it`, async ({
    page,
  }) => {
    const starts: URL[] = [];
    await page.route(
      (url) => url.pathname === "/api/twitter/start",
      (route) => {
        starts.push(new URL(route.request().url()));
        return json(route, 200, {
          authorize_url: "https://x.com/i/oauth2/authorize?state=s",
        });
      },
    );
    await page.route("https://x.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<p>x</p>",
      }),
    );
    await page.context().clearCookies();
    await page.goto(`/login?next=${encodeURIComponent(exit)}`);
    await page.getByRole("button", { name: "Sign in with X" }).click();
    await page.waitForURL("https://x.com/**");
    expect(starts).toHaveLength(1);
    expect(starts[0].searchParams.get("next")).toBe(exit);
  });
}

test("X opened in place on an SDK-facing page returns to that page (#2640)", async ({
  page,
}) => {
  const starts: URL[] = [];
  await page.route(
    (url) => url.pathname === "/api/twitter/start",
    (route) => {
      starts.push(new URL(route.request().url()));
      return json(route, 200, {
        authorize_url: "https://x.com/i/oauth2/authorize?state=s",
      });
    },
  );
  await page.route("https://x.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<p>x</p>" }),
  );
  await signIn(page);
  await mockBurner(page);
  await mockGrants(page);
  await page.goto("/account/apps?client_id=tutor-client");
  await expect(page.getByTestId("manage-username")).toBeVisible();
  // The page's own sign-in modal, opened where the visitor is (no /login,
  // so no `next` in the URL): the return path is the page itself.
  await page.evaluate(async (loader) => {
    const { requestLogin } = await new Function(loader)();
    requestLogin();
  }, devSourceModuleLoader("/src/lib/stores/auth-modal.ts"));
  await page.getByRole("button", { name: "Sign in with X" }).click();
  await page.waitForURL("https://x.com/**");
  expect(starts).toHaveLength(1);
  expect(starts[0].searchParams.get("next")).toBe(
    "/account/apps?client_id=tutor-client",
  );
});
