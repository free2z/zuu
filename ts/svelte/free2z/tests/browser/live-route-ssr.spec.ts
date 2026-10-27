import { expect, test, type APIRequestContext } from "@playwright/test";
import { browserMockApiOrigin } from "./ports";
import { AUTH_STORE_LOADER } from "./dev-source-module";

// Regression gate for  — the live-stream viewer 500'd on the SERVER.
//
// `LiveStreamViewer.svelte` called `window.removeEventListener` from inside
// `onDestroy`. `onDestroy` is the one Svelte lifecycle hook that ALSO runs on
// the server, at the end of the SSR render, so every server render of a live
// page threw `ReferenceError: window is not defined` *after* the markup had
// already been produced and SvelteKit turned it into a hard 500. Verified on
// production 2026-08-17:
//
//   GET /live/skylar        (Googlebot UA) → 500
//   GET /skylar/broadcast   (Googlebot UA) → 500
//
// Two things follow that shape these tests:
//
//   * The failure was in the RENDER, not the loader. `/{u}/ppv` and
//     `/{u}/subscribers-only` 302 an anonymous visitor to /login before the
//     component is ever built, which is why they looked healthy while
//     broadcast burned. So the signed-in persona below is not thoroughness for
//     its own sake — it is the only persona that reaches the crashing code on
//     those two routes.
//   * A unit test that imports the module cannot catch this: the throw only
//     happens when a real server render TEARS DOWN the component tree. Only an
//     end-to-end request through SvelteKit's own SSR reproduces it.
//
// The SEO half of  rides along: 336 creators × 4 mutually duplicate,
// self-canonicalising viewer URLs is 1,344 thin pages. Every shape now
// declares the single canonical `/{username}/{type}` and `noindex, follow`.
// Cross-tier agreement with the Django card tier is pinned separately, in
// tests/live-route-seo.test.mjs.

const USER = "livefixture";
// The mock API answers this creator under any casing and returns the stored
// (lower-case) username, exactly as `username__iexact` does in Django.
const TYPED_USER = "LiveFixture";
const ORIGIN = "https://free2z.cash";

const CRAWLER_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// A session the mock API authenticates. Reused rather than invented so this
// file cannot drift from the fixture roster in mock-api.mjs.
const SIGNED_IN_COOKIE = "sessionid=profile-fixture-session";

/** Every public viewer URL, and the ONE canonical each must declare. */
const SHAPES = [
  { path: `/live/${USER}`, canonical: `/${USER}/broadcast`, gated: false },
  {
    path: `/live/${USER}?type=broadcast`,
    canonical: `/${USER}/broadcast`,
    gated: false,
  },
  { path: `/${USER}/broadcast`, canonical: `/${USER}/broadcast`, gated: false },
  { path: `/${USER}/ppv`, canonical: `/${USER}/ppv`, gated: true },
  {
    path: `/${USER}/subscribers-only`,
    canonical: `/${USER}/subscribers-only`,
    gated: true,
  },
];

function get(
  request: APIRequestContext,
  path: string,
  { ua = CRAWLER_UA, cookie = "" } = {},
) {
  return request.get(path, {
    headers: {
      "user-agent": ua,
      ...(cookie ? { cookie } : {}),
    },
    maxRedirects: 0,
  });
}

function head(html: string, attribute: RegExp) {
  return html.match(attribute)?.[1] ?? null;
}

const canonicalOf = (html: string) =>
  head(html, /<link rel="canonical" href="([^"]*)"/);
const robotsOf = (html: string) =>
  head(html, /<meta name="robots" content="([^"]*)"/);

test.describe("#1178 live-stream viewer SSR", () => {
  for (const ua of [
    { label: "Googlebot", value: CRAWLER_UA },
    { label: "a browser", value: BROWSER_UA },
  ]) {
    test(`open viewer URLs render, not 500, for ${ua.label}`, async ({
      request,
    }) => {
      for (const shape of SHAPES.filter((s) => !s.gated)) {
        const response = await get(request, shape.path, { ua: ua.value });
        expect(response.status(), `${shape.path} must render, not error`).toBe(
          200,
        );

        const html = await response.text();
        expect(canonicalOf(html), `canonical of ${shape.path}`).toBe(
          `${ORIGIN}${shape.canonical}`,
        );
        expect(robotsOf(html), `robots of ${shape.path}`).toBe(
          "noindex, follow",
        );
        expect(
          response.headers()["x-robots-tag"],
          `X-Robots-Tag of ${shape.path}`,
        ).toBe("noindex, follow");
      }
    });
  }

  test("gated viewer URLs send an anonymous visitor to log in", async ({
    request,
  }) => {
    // Pinned as a POSITIVE assertion, not merely "not 500": this redirect is
    // what hid the crash on these two routes for months, so a change that
    // turns it into a render is a change this file must notice.
    for (const shape of SHAPES.filter((s) => s.gated)) {
      const response = await get(request, shape.path);
      expect(response.status(), `${shape.path} anonymous`).toBe(302);
      expect(response.headers()["location"]).toContain("/login?next=");
      // The redirect carries NO markup, so the `<meta name="robots">` the
      // page would have rendered never reaches a crawler on precisely these
      // URLs. Without the header, `noindex` is a policy that only applies to
      // the shapes that did not need it (codex adversarial review).
      expect(
        response.headers()["x-robots-tag"],
        `${shape.path} must state noindex on the redirect itself`,
      ).toBe("noindex, follow");
    }
  });

  test("gated viewer URLs render for a signed-in visitor", async ({
    request,
  }) => {
    // The persona that actually reaches the code that used to throw on
    // `/{u}/ppv` and `/{u}/subscribers-only`.
    for (const shape of SHAPES.filter((s) => s.gated)) {
      const response = await get(request, shape.path, {
        ua: BROWSER_UA,
        cookie: SIGNED_IN_COOKIE,
      });
      expect(response.status(), `${shape.path} signed in`).toBe(200);

      const html = await response.text();
      expect(canonicalOf(html)).toBe(`${ORIGIN}${shape.canonical}`);
      expect(robotsOf(html)).toBe("noindex, follow");
    }
  });

  test("a repeated ?type= is read FIRST-value, as Django reads it", async ({
    request,
  }) => {
    // `URLSearchParams.get()` takes the first value; Django's `QueryDict.get()`
    // takes the LAST. The card tier now reads `getlist("type")[0]` to match —
    // pin the SvelteKit half here so a future refactor cannot flip it and
    // hand the two tiers different canonicals for one URL.
    const first = await get(request, `/live/${USER}?type=broadcast&type=ppv`);
    expect(first.status()).toBe(200);
    expect(canonicalOf(await first.text())).toBe(`${ORIGIN}/${USER}/broadcast`);

    // Reversed: the first value is the gated one, so this must gate.
    const gated = await get(request, `/live/${USER}?type=ppv&type=broadcast`);
    expect(gated.status()).toBe(302);
    expect(gated.headers()["location"]).toContain("/login?next=");
  });

  test("the canonical uses the stored username casing, not the typed one", async ({
    request,
  }) => {
    const response = await get(request, `/${TYPED_USER}/broadcast`);

    expect(response.status()).toBe(200);
    expect(canonicalOf(await response.text())).toBe(
      `${ORIGIN}/${USER}/broadcast`,
    );
  });

  test("no viewer URL declares itself canonical under /live/", async ({
    request,
  }) => {
    // The specific duplicate  reports: `/live/{u}` self-canonicalising
    // while SSR declared `/{u}/broadcast` for the same URL.
    //
    // The status assertion is load-bearing: SvelteKit's 500 page contains no
    // `/live/` string either, so without it this passes on a hard error.
    const response = await get(request, `/live/${USER}`);
    expect(response.status()).toBe(200);

    expect(await response.text()).not.toContain(`${ORIGIN}/live/${USER}`);
  });
});

//. social unfurlers reach THIS tier instead of Django's card
// tier, and the gated shapes 302'd every anonymous request to /login — so a
// shared `/{u}/ppv` or `/{u}/subscribers-only` link unfurled as the login page.
// An anonymous unfurler now gets the creator's PUBLIC card; nobody gets the
// stream without the API's own access check.
const PAID_USER = "paidstreamfixture";
const PAID_NAME = "Paid Stream Creator";
const PAID_AVATAR =
  "https://media.free2z.example/avatars/paidstreamfixture.png";
const MOCK_API_ORIGIN = browserMockApiOrigin();

const UNFURLER_UAS = [
  "Twitterbot/1.0",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
];

const PAID_SHAPES = [
  { path: `/${PAID_USER}/ppv`, canonical: `/${PAID_USER}/ppv` },
  {
    path: `/${PAID_USER}/subscribers-only`,
    canonical: `/${PAID_USER}/subscribers-only`,
  },
  // The legacy alias resolves to the same gated viewer.
  { path: `/live/${PAID_USER}?type=ppv`, canonical: `/${PAID_USER}/ppv` },
];

const metaProperty = (html: string, property: string) =>
  head(html, new RegExp(`<meta property="${property}" content="([^"]*)"`));

async function upstreamPaths(request: APIRequestContext): Promise<string[]> {
  const received: { path: string }[] = await (
    await request.get(`${MOCK_API_ORIGIN}/__requests`)
  ).json();
  return received.map((r) => r.path);
}

test.describe("#2420 paid-stream links unfurl as the creator's card", () => {
  test("an anonymous unfurler gets the creator's og: card, not /login", async ({
    request,
  }) => {
    for (const ua of UNFURLER_UAS) {
      for (const shape of PAID_SHAPES) {
        await request.delete(`${MOCK_API_ORIGIN}/__requests`);
        const response = await get(request, shape.path, { ua });
        const label = `${shape.path} as ${ua}`;
        expect(response.status(), label).toBe(200);

        const html = await response.text();
        expect(metaProperty(html, "og:title"), label).toContain(PAID_NAME);
        expect(metaProperty(html, "og:image"), label).toBe(PAID_AVATAR);
        expect(metaProperty(html, "og:url"), label).toBe(
          `${ORIGIN}${shape.canonical}`,
        );
        expect(canonicalOf(html), label).toBe(`${ORIGIN}${shape.canonical}`);
        expect(robotsOf(html), label).toBe("noindex, follow");
        expect(response.headers()["x-robots-tag"], label).toBe(
          "noindex, follow",
        );
        // A shared cache must not hand this 200 to a browser that should get
        // the 302, or the reverse.
        expect(response.headers()["vary"], label).toMatch(/user-agent/i);

        // The gated state renders a way in, never the viewer.
        expect(html, label).toContain('data-testid="gated-stream-preview"');
        expect(html, label).toContain(
          `/login?next=${encodeURIComponent(shape.canonical)}`,
        );

        // No stream credentials: the server asked the API for the PUBLIC
        // creator profile and nothing else — no meeting, no token, no
        // identity lookup — and no meeting material reached the markup.
        const paths = await upstreamPaths(request);
        expect(paths, label).toContain(`/api/creator/${PAID_USER}/`);
        expect(
          paths.filter((p) => !p.startsWith(`/api/creator/${PAID_USER}`)),
          `${label}: upstream calls besides the public profile`,
        ).toEqual([]);
        expect(html, label).not.toMatch(/authToken|auth_token|meeting_id/i);
      }
    }
  });

  test("the hydrated preview never boots the viewer", async ({
    browser,
    baseURL,
  }) => {
    // The SSR assertions above cover the server; this covers the client.
    // Positive control first: a signed-in visit to the same URL, same UA,
    // DOES boot the viewer, which asks `/api/dyte/...` to join. That proves
    // the listener sees a join, so its absence below means something.
    const dyteRequests = async (cookie: string | null) => {
      const context = await browser.newContext({
        userAgent: UNFURLER_UAS[0],
      });
      try {
        if (cookie) {
          await context.addCookies([
            { name: "sessionid", value: cookie, url: baseURL! },
          ]);
        }
        const page = await context.newPage();
        const joins: { method: string; path: string; body: unknown }[] = [];
        page.on("request", (req) => {
          const path = new URL(req.url()).pathname;
          if (path.startsWith("/api/dyte/")) {
            let body: unknown = null;
            try {
              body = req.postDataJSON();
            } catch {
              // GET discovery and live-status reads have no JSON body.
            }
            joins.push({ method: req.method(), path, body });
          }
        });
        await page.goto(`/${PAID_USER}/ppv`);
        if (cookie) {
          // SSR authenticated the viewer, but the client store hydrates
          // separately. The positive control is meaningful only after that
          // client identity is authoritative, and only a POST to this exact
          // PPV join endpoint proves the viewer booted.
          await expect
            .poll(
              async () =>
                page.evaluate(async (loader) => {
                  const { authStore } = await new Function(loader)();
                  let state: any;
                  authStore.subscribe((value: any) => (state = value))();
                  return {
                    status: state.status,
                    id: state.creator?.id ?? null,
                    username: state.creator?.username ?? null,
                  };
                }, AUTH_STORE_LOADER),
              { timeout: 15_000 },
            )
            .toEqual({
              status: "authenticated",
              id: 4498,
              username: "profilefixture",
            });
          await expect
            .poll(
              () =>
                joins.find(
                  (join) =>
                    join.method === "POST" &&
                    join.path === `/api/dyte/${PAID_USER}/ppv` &&
                    (join.body as any)?.expected_actor_id === 4498,
                ),
              {
                timeout: 15_000,
                message:
                  "authenticated viewer POST must include expected_actor_id 4498",
              },
            )
            .toBeTruthy();
          expect(
            joins.find(
              (join) =>
                join.method === "POST" &&
                join.path === `/api/dyte/${PAID_USER}/ppv`,
            ),
          ).toMatchObject({
            method: "POST",
            path: `/api/dyte/${PAID_USER}/ppv`,
            body: { role: "viewer", expected_actor_id: 4498 },
          });
        } else {
          await expect
            .poll(async () =>
              page.evaluate(async (loader) => {
                const { authStore } = await new Function(loader)();
                let status = "unknown";
                authStore.subscribe((value: any) => (status = value.status))();
                return status;
              }, AUTH_STORE_LOADER),
            )
            .toBe("anonymous");
          await expect(page.getByTestId("gated-stream-preview")).toBeVisible();
          // The window the positive control needed, generously.
          await page.waitForTimeout(3000);
          await expect(page.getByTestId("gated-stream-preview")).toBeVisible();
        }
        return joins;
      } finally {
        await context.close();
      }
    };

    expect(await dyteRequests("profile-fixture-session")).not.toEqual([]);
    expect(await dyteRequests(null)).toEqual([]);
  });

  test("anonymous browsers and Googlebot still go to /login", async ({
    request,
  }) => {
    for (const ua of [CRAWLER_UA, BROWSER_UA]) {
      for (const shape of PAID_SHAPES) {
        const response = await get(request, shape.path, { ua });
        expect(response.status(), `${shape.path} as ${ua}`).toBe(302);
        expect(response.headers()["location"]).toContain("/login?next=");
        expect(response.headers()["vary"]).toMatch(/user-agent/i);
      }
    }
  });

  test("an unfurler UA with a session is NOT handed the preview", async ({
    request,
  }) => {
    // A signed-in visitor whose in-app browser matches the unfurler list must
    // reach the real viewer, and a bad session still goes through the access
    // check (302), never around it.
    for (const shape of PAID_SHAPES) {
      const signedIn = await get(request, shape.path, {
        ua: UNFURLER_UAS[0],
        cookie: SIGNED_IN_COOKIE,
      });
      expect(signedIn.status(), shape.path).toBe(200);
      expect(await signedIn.text()).not.toContain(
        'data-testid="gated-stream-preview"',
      );

      const badSession = await get(request, shape.path, {
        ua: UNFURLER_UAS[0],
        cookie: "sessionid=not-a-real-session",
      });
      expect(badSession.status(), shape.path).toBe(302);
      expect(badSession.headers()["location"]).toContain("/login?next=");
    }
  });
});
