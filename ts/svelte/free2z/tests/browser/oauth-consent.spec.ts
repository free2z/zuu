import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The OIDC consent screen (; zuu docs/free2z/sdk/spec/oidc.md §5, §10).
 *
 * The backend is mocked at the browser: `GET /api/oauth/authorize` answers
 * what the page must do, `POST` records the decision. Every assertion on a
 * decision reads the POST BODY the page sent — the contract is what reaches
 * the server, not what the page shows.
 *
 * The rule under test above all: an approval that grants `ai:invoke` always
 * carries `spend_cap_2z` explicitly (a number, or `null` the user chose).
 *
 * NEGATIVE CONTROLS (run by hand, ): deleting the
 * `body.spend_cap_2z = cap.spend_cap_2z` line in `buildConsentDecision`
 * turns "Allow sends the pre-selected cap" and "No limit is sent as null"
 * red on the body assertion; removing the `noCapConfirmed` check in
 * `resolveCap` turns "No limit needs a second click" red on the disabled
 * Allow button.
 */

const APP_ORIGIN = "https://tutor.example.test";
const REDIRECT_URI = `${APP_ORIGIN}/oauth/callback`;
const STATE = "s".repeat(32);

const AUTHORIZATION_REQUEST = {
  response_type: "code",
  client_id: "tutor-client",
  redirect_uri: REDIRECT_URI,
  scope: "openid profile ai:invoke",
  state: STATE,
  code_challenge: "c".repeat(43),
  code_challenge_method: "S256",
  nonce: "n".repeat(16),
};

function authorizeUrl(extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ ...AUTHORIZATION_REQUEST, ...extra });
  return `/oauth/authorize?${params.toString()}`;
}

function consentAnswer(overrides: Record<string, unknown> = {}) {
  return {
    action: "consent",
    request_id: "signed-request-id",
    authorization_request: AUTHORIZATION_REQUEST,
    consent: {
      application: {
        client_id: "tutor-client",
        name: "Corpora Tutor",
        developer: "corpora",
        logo_url: "",
        privacy_url: "https://tutor.example.test/privacy",
        terms_url: "",
        first_party: false,
        child_directed: false,
        markup_bps: 2000,
        markup_approval: "approved",
      },
      scopes: ["openid", "profile", "ai:invoke"],
      scope_descriptions: {
        openid: "Sign you in and identify your account",
        profile: "Your username, display name and avatar",
        "ai:invoke": "Call AI through the gateway, paid from your 2Z",
      },
      already_granted: [],
      cap_required: true,
      spend_cap: { spend_cap_2z: 1000, cap_period: "month" },
      is_raise_step_up_required: false,
      ...overrides,
    },
  };
}

type Mock = {
  evaluate: () => { status: number; body: unknown };
  decide?: (body: Record<string, unknown>) => { status: number; body: unknown };
};

/** Mocks the consent endpoints and the app's callback; returns the POST bodies. */
async function mockAuthorize(page: Page, mock: Mock) {
  const posted: Record<string, unknown>[] = [];
  const evaluated: URL[] = [];
  await page.route(
    (url) => url.pathname === "/api/oauth/authorize",
    async (route: Route) => {
      const request = route.request();
      if (request.method() === "GET") {
        evaluated.push(new URL(request.url()));
        const answer = mock.evaluate();
        return route.fulfill({
          status: answer.status,
          contentType: "application/json",
          body: JSON.stringify(answer.body),
        });
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      posted.push(body);
      const answer = mock.decide
        ? mock.decide(body)
        : {
            status: 200,
            body: {
              action: "redirect",
              redirect_to: `${REDIRECT_URI}?code=the-code&state=${STATE}`,
            },
          };
      return route.fulfill({
        status: answer.status,
        contentType: "application/json",
        body: JSON.stringify(answer.body),
      });
    },
  );
  // The app's own callback page: the browser really navigates there.
  await page.route(`${APP_ORIGIN}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>callback</title><p>app callback</p>",
    }),
  );
  return { posted, evaluated };
}

async function openConsent(page: Page, url = authorizeUrl()) {
  await page.goto(url);
  // The screen is rendered by the page's own onMount fetch, so seeing it
  // proves hydration already happened: a click here is never a pre-hydration
  // no-op. (`networkidle` timed out at 30s on this page when it was tried.)
  await expect(page.getByTestId("oauth-consent")).toBeVisible();
}

test("the screen names the app, its developer, its markup and the scopes in plain language", async ({
  page,
}) => {
  const { evaluated } = await mockAuthorize(page, {
    evaluate: () => ({ status: 200, body: consentAnswer() }),
  });
  await openConsent(page);

  await expect(page.getByTestId("oauth-consent-app-name")).toHaveText(
    "Corpora Tutor wants to use your Free2Z account",
  );
  await expect(page.getByTestId("oauth-consent-developer")).toHaveText(
    "Made by @corpora",
  );
  await expect(page.getByTestId("oauth-consent-markup")).toContainText(
    "This app adds 20% on top of the AI cost.",
  );
  const scopes = page.getByTestId("oauth-consent-scopes");
  await expect(scopes).toContainText("Sign you in with your Free2Z account");
  await expect(scopes).toContainText(
    "Use AI features that spend your 2Z credits",
  );
  // The pre-selection is the backend's, and it is selected.
  await expect(page.getByTestId("oauth-cap-preselected")).toBeChecked();
  await expect(page.getByTestId("oauth-consent-cap")).toContainText(
    "1,000 2Z per month",
  );
  // The page forwarded the authorization parameters, and only those.
  expect(evaluated[0].searchParams.get("client_id")).toBe("tutor-client");
  expect(evaluated[0].searchParams.get("state")).toBe(STATE);

  // No markup line at all when the effective markup is 0 (spec §2).
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const zero = consentAnswer();
  (zero.consent.application as Record<string, unknown>).markup_bps = 0;
  await mockAuthorize(page, { evaluate: () => ({ status: 200, body: zero }) });
  await openConsent(page);
  await expect(page.getByTestId("oauth-consent-markup")).toHaveCount(0);
});

test("Allow sends the pre-selected cap explicitly and follows the backend's redirect", async ({
  page,
}) => {
  const { posted } = await mockAuthorize(page, {
    evaluate: () => ({ status: 200, body: consentAnswer() }),
  });
  await openConsent(page);
  await page.getByTestId("oauth-consent-allow").click();

  await page.waitForURL(`${REDIRECT_URI}?**`);
  expect(new URL(page.url()).searchParams.get("code")).toBe("the-code");
  expect(posted).toHaveLength(1);
  expect(posted[0]).toEqual({
    request_id: "signed-request-id",
    authorization_request: AUTHORIZATION_REQUEST,
    allow: true,
    spend_cap_2z: 1000,
    cap_period: "month",
  });
});

test("Cancel posts allow:false and goes where the backend says", async ({
  page,
}) => {
  const { posted } = await mockAuthorize(page, {
    evaluate: () => ({ status: 200, body: consentAnswer() }),
    decide: () => ({
      status: 200,
      body: {
        action: "redirect",
        redirect_to: `${REDIRECT_URI}?error=access_denied&state=${STATE}`,
      },
    }),
  });
  await openConsent(page);
  await page.getByTestId("oauth-consent-deny").click();

  await page.waitForURL(`${REDIRECT_URI}?**`);
  expect(new URL(page.url()).searchParams.get("error")).toBe("access_denied");
  expect(posted).toEqual([
    {
      request_id: "signed-request-id",
      authorization_request: AUTHORIZATION_REQUEST,
      allow: false,
    },
  ]);
});

test("No limit needs a second click and is sent as an explicit null", async ({
  page,
}) => {
  const { posted } = await mockAuthorize(page, {
    evaluate: () => ({ status: 200, body: consentAnswer() }),
  });
  await openConsent(page);

  await page.getByTestId("oauth-cap-none").check();
  const allow = page.getByTestId("oauth-consent-allow");
  await expect(allow).toBeDisabled();
  expect(posted).toHaveLength(0);

  await page.getByTestId("oauth-cap-none-confirm").check();
  await expect(allow).toBeEnabled();
  await allow.click();
  await page.waitForURL(`${REDIRECT_URI}?**`);
  expect(posted).toHaveLength(1);
  expect(Object.hasOwn(posted[0], "spend_cap_2z")).toBe(true);
  expect(posted[0].spend_cap_2z).toBeNull();
});

test("a different limit is validated on the page and sent as typed", async ({
  page,
}) => {
  const { posted } = await mockAuthorize(page, {
    evaluate: () => ({ status: 200, body: consentAnswer() }),
  });
  await openConsent(page);

  await page.getByTestId("oauth-cap-custom").check();
  const amount = page.getByTestId("oauth-cap-amount");
  await amount.fill("0");
  await expect(page.getByTestId("oauth-consent-cap")).toContainText(
    "Enter a whole number of 2Z credits, 1 or more.",
  );
  await expect(amount).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("oauth-consent-allow")).toBeDisabled();

  await amount.fill("2500");
  await page.getByTestId("oauth-cap-period").selectOption("week");
  await page.getByTestId("oauth-consent-allow").click();
  await page.waitForURL(`${REDIRECT_URI}?**`);
  expect(posted[0]).toMatchObject({
    allow: true,
    spend_cap_2z: 2500,
    cap_period: "week",
  });
});

test("a consent without ai:invoke shows no cap control and sends no cap", async ({
  page,
}) => {
  const { posted } = await mockAuthorize(page, {
    evaluate: () => ({
      status: 200,
      body: consentAnswer({
        scopes: ["openid", "profile"],
        cap_required: false,
      }),
    }),
  });
  await openConsent(page);
  await expect(page.getByTestId("oauth-consent-cap")).toHaveCount(0);
  await page.getByTestId("oauth-consent-allow").click();
  await page.waitForURL(`${REDIRECT_URI}?**`);
  expect(Object.hasOwn(posted[0], "spend_cap_2z")).toBe(false);
});

test("action approve is decided without a screen", async ({ page }) => {
  const { posted } = await mockAuthorize(page, {
    evaluate: () => ({
      status: 200,
      body: {
        action: "approve",
        request_id: "signed-request-id",
        authorization_request: AUTHORIZATION_REQUEST,
      },
    }),
  });
  await page.goto(authorizeUrl());
  await page.waitForURL(`${REDIRECT_URI}?**`);
  expect(posted).toEqual([
    {
      request_id: "signed-request-id",
      authorization_request: AUTHORIZATION_REQUEST,
      allow: true,
    },
  ]);
});

test("a visitor who is not signed in is sent to /login and brought back", async ({
  page,
}) => {
  await mockAuthorize(page, {
    evaluate: () => ({
      status: 200,
      body: {
        action: "login",
        reason: "login_required",
        login_ticket: "anon-ticket",
      },
    }),
  });
  await page.goto(authorizeUrl({ max_age: "0" }));
  await page.waitForURL("**/login?**");
  const next = new URL(page.url()).searchParams.get("next") ?? "";
  expect(next.startsWith("/oauth/authorize?")).toBe(true);
  const back = new URLSearchParams(next.split("?")[1]);
  expect(back.get("state")).toBe(STATE);
  // The ticket rides the sign-in, so ONE sign-in satisfies max_age=0.
  expect(back.get("f2z_login_ticket")).toBe("anon-ticket");
  expect(back.get("max_age")).toBe("0");
});

test("a fresh sign-in is asked for, signs out, drops prompt=login, and never loops", async ({
  page,
}) => {
  const { evaluated } = await mockAuthorize(page, {
    evaluate: () => ({
      status: 200,
      body: {
        action: "login",
        reason: "prompt=login",
        login_ticket: "fresh-ticket",
      },
    }),
  });
  let loggedOut = 0;
  await page.route("**/api/auth/logout/", (route) => {
    loggedOut += 1;
    return route.fulfill({ status: 200, body: "{}" });
  });

  await page.goto(authorizeUrl({ prompt: "login" }));
  await expect(page.getByTestId("oauth-consent-reauth")).toBeVisible();
  // Nothing happens to the session until the user asks.
  expect(loggedOut).toBe(0);
  await page.getByTestId("oauth-consent-reauth-button").click();

  await page.waitForURL("**/login?**");
  expect(loggedOut).toBe(1);
  const login = new URL(page.url());
  expect(login.searchParams.get("reason")).toBe("reauthenticate");
  const next = new URL(
    login.searchParams.get("next") ?? "",
    "https://free2z.test",
  );
  expect(next.pathname).toBe("/oauth/authorize");
  expect(next.searchParams.has("prompt")).toBe(false);
  expect(next.searchParams.get("f2z_reauth")).toBe("1");
  expect(next.searchParams.get("f2z_login_ticket")).toBe("fresh-ticket");
  await expect(page.getByText("asked you to confirm it's you")).toBeVisible();

  // Back from the sign-in and the backend STILL cannot confirm one: stop.
  await page.goto(`${next.pathname}${next.search}`);
  await expect(page.getByTestId("oauth-consent-reauth-loop")).toBeVisible();
  await expect(page.getByTestId("oauth-consent-reauth-button")).toHaveCount(0);
  // The repeated evaluation sent the ticket back to the backend.
  expect(evaluated.at(-1)?.searchParams.get("f2z_login_ticket")).toBe(
    "fresh-ticket",
  );
});

test("a raise the backend refuses for step-up offers keeping the current limit", async ({
  page,
}) => {
  const { posted } = await mockAuthorize(page, {
    evaluate: () => ({
      status: 200,
      body: consentAnswer({
        already_granted: ["openid", "profile", "ai:invoke"],
        spend_cap: { spend_cap_2z: 100, cap_period: "month" },
        is_raise_step_up_required: true,
      }),
    }),
    decide: (body) =>
      body.spend_cap_2z === 100
        ? {
            status: 200,
            body: {
              action: "redirect",
              redirect_to: `${REDIRECT_URI}?code=kept&state=${STATE}`,
            },
          }
        : {
            status: 401,
            body: {
              code: "insufficient_user_authentication",
              detail:
                "raising a spend cap requires authentication within the last 5 minutes",
              max_age: 300,
            },
          },
  });
  await openConsent(page);
  await expect(page.getByTestId("oauth-consent-cap")).toContainText(
    "Your current budget",
  );
  await page.getByTestId("oauth-cap-custom").check();
  await page.getByTestId("oauth-cap-amount").fill("500");
  await expect(page.getByTestId("oauth-cap-raise-note")).toBeVisible();
  await page.getByTestId("oauth-consent-allow").click();

  await expect(page.getByTestId("oauth-consent-step-up")).toBeVisible();
  await page.getByRole("button", { name: "Keep my current limit" }).click();
  await expect(page.getByTestId("oauth-cap-preselected")).toBeChecked();
  await page.getByTestId("oauth-consent-allow").click();
  await page.waitForURL(`${REDIRECT_URI}?**`);
  expect(posted.map((b) => b.spend_cap_2z)).toEqual([500, 100]);
});

test("a request the backend refuses outright stays on Free2Z and says why", async ({
  page,
}) => {
  await mockAuthorize(page, {
    evaluate: () => ({
      status: 400,
      body: {
        error: "invalid_request",
        error_description:
          "redirect_uri: a redirect URI may not carry a query string",
      },
    }),
  });
  await page.goto(authorizeUrl());
  const error = page.getByTestId("oauth-consent-error");
  await expect(error).toContainText("This request can't continue");
  await expect(page.getByTestId("oauth-consent-error-detail")).toHaveText(
    "redirect_uri: a redirect URI may not carry a query string",
  );
  expect(new URL(page.url()).pathname).toBe("/oauth/authorize");
});

test("a logout that fails keeps prompt=login: no sign-in bypass", async ({
  page,
}) => {
  await mockAuthorize(page, {
    evaluate: () => ({
      status: 200,
      body: { action: "login", reason: "prompt=login" },
    }),
  });
  await page.route("**/api/auth/logout/", (route) =>
    route.fulfill({ status: 500, body: "{}" }),
  );
  await page.goto(authorizeUrl({ prompt: "login" }));
  await page.getByTestId("oauth-consent-reauth-button").click();
  await expect(page.getByTestId("oauth-consent-reauth-error")).toBeVisible();
  // Still here, still asking for prompt=login: never sent on without it.
  const here = new URL(page.url());
  expect(here.pathname).toBe("/oauth/authorize");
  expect(here.searchParams.get("prompt")).toBe("login");
});

test("a 403 on the decision (session gone) asks the backend again", async ({
  page,
}) => {
  let evaluations = 0;
  await mockAuthorize(page, {
    evaluate: () => {
      evaluations += 1;
      return evaluations === 1
        ? { status: 200, body: consentAnswer() }
        : { status: 200, body: { action: "login", reason: "login_required" } };
    },
    decide: () => ({
      status: 403,
      body: { detail: "Authentication credentials were not provided." },
    }),
  });
  await openConsent(page);
  await page.getByTestId("oauth-consent-allow").click();
  await page.waitForURL("**/login?**");
  expect(evaluations).toBe(2);
});

test("a logout refused with 403 (CSRF) is not a sign-out: prompt=login stays", async ({
  page,
}) => {
  await mockAuthorize(page, {
    evaluate: () => ({
      status: 200,
      body: { action: "login", reason: "prompt=login" },
    }),
  });
  await page.route("**/api/auth/logout/", (route) =>
    route.fulfill({ status: 403, body: "{}" }),
  );
  await page.goto(authorizeUrl({ prompt: "login" }));
  await page.getByTestId("oauth-consent-reauth-button").click();
  await expect(page.getByTestId("oauth-consent-reauth-error")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("prompt")).toBe("login");
});

test("a persistent 403 on a silent approval stops after one retry", async ({
  page,
}) => {
  const { posted } = await mockAuthorize(page, {
    evaluate: () => ({
      status: 200,
      body: {
        action: "approve",
        request_id: "signed-request-id",
        authorization_request: AUTHORIZATION_REQUEST,
      },
    }),
    decide: () => ({
      status: 403,
      body: { detail: "CSRF Failed: CSRF token missing." },
    }),
  });
  await page.goto(authorizeUrl());
  await expect(page.getByTestId("oauth-consent-error")).toContainText(
    "Free2Z refused this request.",
  );
  // Give a runaway loop time to show itself.
  await page.waitForTimeout(1000);
  expect(posted).toHaveLength(2);
});

// ------------------------------------------------------------------
//
// NEGATIVE CONTROLS (run by hand, ): replacing `stepUpPhase(...)` in
// the consent page's 401 handler with `"stepUp"` turns "a second step-up
// after the fresh sign-in stops" red (Sign in again is offered again);
// rendering the first-party badge unconditionally turns "a third-party app
// gets no badge" red.

test("a first-party app carries the verified badge", async ({ page }) => {
  const answer = consentAnswer();
  (answer.consent.application as Record<string, unknown>).first_party = true;
  (answer.consent.application as Record<string, unknown>).developer = "free2z";
  await mockAuthorize(page, {
    evaluate: () => ({ status: 200, body: answer }),
  });
  await openConsent(page);
  await expect(page.getByTestId("oauth-consent-first-party")).toHaveText(
    "Verified: made by Free2Z",
  );
  await expect(page.getByTestId("oauth-consent-third-party")).toHaveCount(0);
});

// A child-directed registration (zuu docs/free2z/sdk/CHILD-DIRECTED.md):
// the screen speaks to the adult account holder; an ordinary app shows no
// such line. NEGATIVE CONTROL (by hand): rendering the line unconditionally
// turns the second half red.
test("a child-directed app addresses the adult account holder", async ({
  page,
}) => {
  const answer = consentAnswer();
  (answer.consent.application as Record<string, unknown>).child_directed = true;
  await mockAuthorize(page, {
    evaluate: () => ({ status: 200, body: answer }),
  });
  await openConsent(page);
  await expect(page.getByTestId("oauth-consent-child-directed")).toHaveText(
    "Children may use this app. You are connecting your own account as the adult account holder.",
  );
});

test("an ordinary app shows no child-directed line", async ({ page }) => {
  await mockAuthorize(page, {
    evaluate: () => ({ status: 200, body: consentAnswer() }),
  });
  await openConsent(page);
  await expect(page.getByTestId("oauth-consent-app-name")).toBeVisible();
  await expect(page.getByTestId("oauth-consent-child-directed")).toHaveCount(0);
});

test("a third-party app gets no badge and says it is not made by Free2Z", async ({
  page,
}) => {
  await mockAuthorize(page, {
    evaluate: () => ({ status: 200, body: consentAnswer() }),
  });
  await openConsent(page);
  await expect(page.getByTestId("oauth-consent-first-party")).toHaveCount(0);
  await expect(page.getByTestId("oauth-consent-third-party")).toContainText(
    "This app is not made by Free2Z.",
  );
  // The developer line is the prominent one, not muted.
  await expect(page.getByTestId("oauth-consent-developer")).toHaveClass(
    /font-medium/,
  );
});

test("a second step-up after the fresh sign-in stops instead of looping", async ({
  page,
}) => {
  const { posted } = await mockAuthorize(page, {
    evaluate: () => ({
      status: 200,
      body: consentAnswer({
        already_granted: ["openid", "profile", "ai:invoke"],
        spend_cap: { spend_cap_2z: 100, cap_period: "month" },
        is_raise_step_up_required: true,
      }),
    }),
    decide: () => ({
      status: 401,
      body: {
        code: "insufficient_user_authentication",
        detail: "raising a spend cap requires a recent sign-in",
        max_age: 300,
      },
    }),
  });
  // The return trip from the fresh sign-in carries the marker.
  await openConsent(page, authorizeUrl({ f2z_reauth: "1" }));
  await page.getByTestId("oauth-cap-custom").check();
  await page.getByTestId("oauth-cap-amount").fill("500");
  await page.getByTestId("oauth-consent-allow").click();

  await expect(page.getByTestId("oauth-consent-step-up-loop")).toBeVisible();
  await expect(page.getByTestId("oauth-consent-step-up")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in again" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Keep my current limit" }).click();
  await expect(page.getByTestId("oauth-cap-preselected")).toBeChecked();
  expect(posted).toHaveLength(1);
});

test("no suggested budget authorizes prepaid balance with one explicit Allow", async ({
  page,
}) => {
  const { posted } = await mockAuthorize(page, {
    evaluate: () => ({
      status: 200,
      body: consentAnswer({
        spend_cap: { spend_cap_2z: null, cap_period: "month" },
      }),
    }),
  });
  await openConsent(page);
  await expect(page.getByTestId("oauth-consent-cap")).toContainText(
    "Available balance (no extra budget)",
  );
  await expect(page.getByTestId("oauth-consent-cap")).toContainText(
    "available prepaid 2Z balance",
  );
  await expect(page.getByTestId("oauth-cap-preselected")).toBeChecked();
  await expect(page.getByTestId("oauth-cap-none-confirm")).toHaveCount(0);
  await expect(page.getByTestId("oauth-consent-allow")).toBeEnabled();
  await page.getByTestId("oauth-consent-allow").click();
  await page.waitForURL(`${REDIRECT_URI}?**`);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({
    allow: true,
    spend_cap_2z: null,
    cap_period: "month",
  });
});

test("an app's spend-cap hint (#2296) is forwarded, labelled as a suggestion, and sent only as the user's choice", async ({
  page,
}) => {
  const HINT = { f2z_spend_cap: "60", f2z_spend_period: "total" };
  const { posted, evaluated } = await mockAuthorize(page, {
    evaluate: () => ({
      status: 200,
      body: consentAnswer({
        already_granted: ["openid", "profile", "ai:invoke"],
        // The backend took the lower amount and kept the capped grant's
        // period: 60 a month.
        spend_cap: { spend_cap_2z: 60, cap_period: "month" },
        spend_cap_source: "request",
        current_spend_cap: { spend_cap_2z: 100, cap_period: "month" },
        is_raise_step_up_required: true,
      }),
    }),
  });
  await openConsent(page, authorizeUrl(HINT));
  expect(evaluated.at(-1)?.searchParams.get("f2z_spend_cap")).toBe("60");
  expect(evaluated.at(-1)?.searchParams.get("f2z_spend_period")).toBe("total");
  await expect(page.getByTestId("oauth-consent-cap")).toContainText(
    "Suggested by this app",
  );
  // The grant it would replace is shown beside it, so one Allow never
  // lowers an existing budget unseen.
  await expect(page.getByTestId("oauth-cap-current-budget")).toHaveText(
    "Replaces your current budget: 100 2Z per month",
  );
  // Choosing the grant's own cap back is not a raise: no sign-in warning,
  // although it is above the (lower) hinted pre-selection.
  await page.getByTestId("oauth-cap-custom").check();
  await page.getByTestId("oauth-cap-amount").fill("100");
  await page.getByTestId("oauth-cap-period").selectOption("month");
  await expect(page.getByTestId("oauth-cap-raise-note")).toHaveCount(0);
  // Above the CURRENT grant it is one.
  await page.getByTestId("oauth-cap-amount").fill("101");
  await expect(page.getByTestId("oauth-cap-raise-note")).toBeVisible();
  // Back to the suggestion, confirmed by Allow: that is what is sent.
  await page.getByTestId("oauth-cap-preselected").check();
  await page.getByTestId("oauth-consent-allow").click();
  await page.waitForURL(`${REDIRECT_URI}?**`);
  expect(posted).toHaveLength(1);
  expect(posted[0].spend_cap_2z).toBe(60);
  expect(posted[0].cap_period).toBe("month");
});

test("a suggestion equal to the current grant, or none at all, shows no replacement line", async ({
  page,
}) => {
  await mockAuthorize(page, {
    evaluate: () => ({
      status: 200,
      body: consentAnswer({
        already_granted: ["openid", "profile", "ai:invoke"],
        spend_cap: { spend_cap_2z: 100, cap_period: "month" },
        spend_cap_source: "grant",
        current_spend_cap: { spend_cap_2z: 100, cap_period: "month" },
        is_raise_step_up_required: true,
      }),
    }),
  });
  await openConsent(page);
  await expect(page.getByTestId("oauth-consent-cap")).toContainText(
    "Your current budget",
  );
  await expect(page.getByTestId("oauth-cap-current-budget")).toHaveCount(0);
});

test("after a refused raise, keeping the current limit restores the GRANT's cap, not the app's lower suggestion", async ({
  page,
}) => {
  const { posted } = await mockAuthorize(page, {
    evaluate: () => ({
      status: 200,
      body: consentAnswer({
        already_granted: ["openid", "profile", "ai:invoke"],
        spend_cap: { spend_cap_2z: 40, cap_period: "month" },
        spend_cap_source: "request",
        current_spend_cap: { spend_cap_2z: 20_000_000, cap_period: "month" },
        is_raise_step_up_required: true,
      }),
    }),
    decide: (body) =>
      body.spend_cap_2z === 20_000_000
        ? {
            status: 200,
            body: {
              action: "redirect",
              redirect_to: `${REDIRECT_URI}?code=kept&state=${STATE}`,
            },
          }
        : {
            status: 401,
            body: {
              code: "insufficient_user_authentication",
              detail:
                "raising a spend cap requires authentication within the last 5 minutes",
              max_age: 300,
            },
          },
  });
  await openConsent(page, authorizeUrl({ f2z_spend_cap: "40" }));
  await page.getByTestId("oauth-cap-custom").check();
  // Above the custom-input ceiling (MAX_CUSTOM_CAP_2Z): only the "current"
  // choice can carry it, never re-typed custom input.
  await page.getByTestId("oauth-cap-amount").fill("9999999");
  await page.getByTestId("oauth-cap-period").selectOption("day");
  await page.getByTestId("oauth-consent-allow").click();
  await expect(page.getByTestId("oauth-consent-step-up")).toBeVisible();
  await page.getByRole("button", { name: "Keep my current limit" }).click();
  await expect(page.getByTestId("oauth-cap-current")).toBeChecked();
  await expect(page.getByTestId("oauth-consent-allow")).toBeEnabled();
  await page.getByTestId("oauth-consent-allow").click();
  await page.waitForURL(`${REDIRECT_URI}?**`);
  expect(posted.map((b) => [b.spend_cap_2z, b.cap_period])).toEqual([
    [9_999_999, "day"],
    [20_000_000, "month"],
  ]);
});

// --- The store line (zuu docs/free2z/sdk/INTEGRATION.md) --------------------
//
// An app's sign-in sheet is part of the app as far as the stores are
// concerned: Google Play bans sign-in and sign-up flows that lead to a
// non-Play payment, and Apple bans steering outside the US storefront. So the
// flow — consent, and the /login before it — renders no site chrome (whose
// account menu reaches Credits), no purchase link, and no sign-in method that
// leaves the flow (X lands on the dashboard, not back on the request).
//
// NEGATIVE CONTROL (run by hand): returning `false` from `isSdkFlow` in
// $lib/sdk-flow.ts turns both red — the Navbar's and Footer's same-site
// links appear on both pages, and X starts without the request to return to.

/** Purchase surfaces: buying 2Z, checkout, the Credits page, pricing. */
const PURCHASE_HREF = /buy-2z|\/checkout\/|\/dashboard\/billing|pricing/i;

/** Every link on the page, resolved, split by whether it stays on this site. */
async function pageLinks(page: Page) {
  const hrefs = await page
    .locator("a[href]")
    .evaluateAll((anchors) =>
      anchors.map((a) => (a as HTMLAnchorElement).href),
    );
  const origin = new URL(page.url()).origin;
  return {
    all: hrefs,
    sameSite: hrefs.filter((href) => new URL(href).origin === origin),
  };
}

test("the consent screen is commerce-free: no site chrome, no purchase link, no way into the site", async ({
  page,
}) => {
  await mockAuthorize(page, {
    evaluate: () => ({ status: 200, body: consentAnswer() }),
  });
  await openConsent(page);

  const links = await pageLinks(page);
  expect(links.all.filter((href) => PURCHASE_HREF.test(href))).toEqual([]);
  // Only the app's own policy link leaves the page; nothing leads back into
  // Free2Z, whose navigation reaches Credits.
  expect(links.sameSite).toEqual([]);
  expect(links.all).toEqual(["https://tutor.example.test/privacy"]);
  await expect(page.getByText(/buy 2z/i)).toHaveCount(0);
});

/** Records `/api/twitter/start` calls and answers with an X consent URL. */
async function mockXStart(page: Page) {
  const starts: URL[] = [];
  await page.route(
    (url) => url.pathname === "/api/twitter/start",
    (route) => {
      starts.push(new URL(route.request().url()));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          authorize_url: "https://x.com/i/oauth2/authorize?state=s",
        }),
      });
    },
  );
  await page.route("https://x.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<p>x</p>" }),
  );
  return starts;
}

test("/login inside an app's flow keeps the visitor in it: no chrome, and X returns to the request", async ({
  page,
}) => {
  const starts = await mockXStart(page);
  await page.context().clearCookies();
  await page.goto(`/login?next=${encodeURIComponent(authorizeUrl())}`);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("#username")).toBeVisible();

  const links = await pageLinks(page);
  expect(links.all.filter((href) => PURCHASE_HREF.test(href))).toEqual([]);
  // Nothing on the sign-in form leads back into the site.
  expect(links.sameSite).toEqual([]);

  // Sign-up (the burner path: no email asked for) is the same flow.
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await expect(page.locator("#signup-username")).toBeVisible();
  // The only same-site link is the Terms, in its plain rendering
  // (/docs/plain/…: no docs navigation, links only to other legal pages).
  const signup = await pageLinks(page);
  expect(signup.all.filter((href) => PURCHASE_HREF.test(href))).toEqual([]);
  expect(signup.sameSite.map((href) => new URL(href).pathname)).toEqual([
    "/docs/plain/legal/",
  ]);

  // X-only accounts (no password, often no email) can sign in here too: the
  // start carries the request, so the callback lands back on it, not on the
  // dashboard (py/dj/apps/twitter/views.py, safe_x_return_path).
  await page.getByRole("button", { name: "Sign up with X" }).click();
  await page.waitForURL("https://x.com/**");
  expect(starts).toHaveLength(1);
  expect(starts[0].searchParams.get("next")).toBe(authorizeUrl());
});

test("an ordinary /login starts X with no return path (it lands on /profile)", async ({
  page,
}) => {
  const starts = await mockXStart(page);
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with X" }).click();
  await page.waitForURL("https://x.com/**");
  expect(starts).toHaveLength(1);
  expect(starts[0].searchParams.has("next")).toBe(false);
});
