import { expect, test } from "@playwright/test";
import { AUTH_STORE_LOADER } from "./dev-source-module";

// Signing back in after an expired session happens IN PLACE in the editor
//  the draft only exists in this document, so a login page would
// throw it away. That opens a hazard the navigate-away version did not have:
// the session the NEXT save is sent with need not be the one the page loaded
// under. `zPageViewSet.create()` takes ownership from `request.user`, so
// Alice's unsaved draft would be created — and could be published — as Bob,
// while the editor's own `data.currentUser` still says Alice everywhere else.
//
// The save is refused instead, and the notice names the account that can save
// it. The work stays on screen. (codex adversarial review.)
//
// NEGATIVE CONTROL: delete the `signedInAsSomeoneElse` gate at the top of
// `handleSave` in src/routes/edit/+page.svelte and the second save is sent —
// `creates` reaches 2 with Bob's session and this test goes red.

// A cold `vite dev` compiles the whole /edit module graph on this first hit.
test.setTimeout(120_000);

const OWNER = { id: 8101, username: "draft-owner", full_name: "Draft Owner" };
const INTRUDER = {
  id: 8102,
  username: "other-account",
  full_name: "Other Account",
};

test("re-authenticating as a different account refuses the save instead of misattributing the draft", async ({
  page,
}) => {
  const creates: Array<Record<string, unknown>> = [];
  let signedInAs: typeof OWNER | null = OWNER;

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());

      if (pathname === "/api/auth/user/") {
        if (!signedInAs) {
          await route.fulfill({
            status: 401,
            json: { detail: "Not authenticated" },
          });
          return;
        }
        await route.fulfill({ json: signedInAs });
        return;
      }

      if (pathname === "/api/auth/login/" && request.method() === "POST") {
        // Whoever they typed; the fixture only cares that it is not the owner.
        signedInAs = INTRUDER;
        await route.fulfill({ json: { key: "session" } });
        return;
      }

      if (pathname === "/api/zpage/" && request.method() === "POST") {
        creates.push(JSON.parse(request.postData() || "{}"));
        // The session behind this editor has expired.
        signedInAs = null;
        await route.fulfill({
          status: 401,
          json: { detail: "Authentication credentials were not provided." },
        });
        return;
      }

      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  await page.goto("/edit");
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toBeVisible({ timeout: 30_000 });

  // The first save 401s and opens the sign-in modal in place, on this URL.
  await body.fill("A draft that belongs to draft-owner.");
  await page.keyboard.press("Control+s");
  await expect.poll(() => creates.length, { timeout: 15_000 }).toBe(1);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL("/edit");

  // …and somebody else signs in.
  await dialog.locator("#username").fill(INTRUDER.username);
  await dialog.locator("#password").fill("correct-password");
  await dialog.getByRole("button", { name: "Log in" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });

  // The draft is still on screen, and the editor refuses to send it.
  await expect(body).toHaveValue("A draft that belongs to draft-owner.");
  await page.keyboard.press("Control+s");
  // The always-visible save notice names the account that can save it...
  await expect(
    page
      .locator('[role="status"]:not([data-testid="auth-modal-notice"])')
      .filter({ hasText: `Sign in as ${OWNER.username} to save this draft.` }),
  ).toBeVisible();
  //...and a manual save reopens the sign-in modal IN PLACE, so this is a
  // recoverable state rather than a dead end with the draft stranded behind a
  // logout that would navigate away from it.
  await expect(page.getByTestId("auth-modal-notice")).toContainText(
    `Sign in as ${OWNER.username} to save this draft.`,
  );
  await expect(page).toHaveURL("/edit");
  // Give any autosave timer a chance to misbehave before asserting silence.
  await expect.poll(() => creates.length, { timeout: 8_000 }).toBe(1);
});

// The same hazard with the identity fetch missing rather than answered. The
// login POST succeeds — the OTHER account's session cookie is installed — and
// `/api/auth/user/` then fails, so `$currentUser` stays null. Reading null as
// "nobody is signed in, go ahead and save" hands the draft to whoever the
// cookie belongs to. Once this editor's session is known to be gone, nothing
// is sent until the ORIGINAL owner is positively confirmed.
//
// NEGATIVE CONTROL: narrow the guard back to `$currentUser !== null`
// in src/routes/edit/+page.svelte and the save is
// sent — `creates` reaches 2 and this test goes red.
test("a login whose identity fetch fails does not count as permission to save", async ({
  page,
}) => {
  const creates: Array<Record<string, unknown>> = [];
  let phase: "owner" | "expired" | "unresolvable" = "owner";

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());

      if (pathname === "/api/auth/user/") {
        if (phase === "owner") {
          await route.fulfill({ json: OWNER });
          return;
        }
        if (phase === "expired") {
          await route.fulfill({
            status: 401,
            json: { detail: "Not authenticated" },
          });
          return;
        }
        // Signed in as somebody — the cookie says so — but the client cannot
        // find out who.
        await route.fulfill({
          status: 503,
          json: { detail: "identity backend unavailable" },
        });
        return;
      }

      if (pathname === "/api/auth/login/" && request.method() === "POST") {
        phase = "unresolvable";
        await route.fulfill({ json: { key: "session" } });
        return;
      }

      if (pathname === "/api/zpage/" && request.method() === "POST") {
        creates.push(JSON.parse(request.postData() || "{}"));
        phase = "expired";
        await route.fulfill({
          status: 401,
          json: { detail: "Authentication credentials were not provided." },
        });
        return;
      }

      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  await page.goto("/edit");
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toBeVisible({ timeout: 30_000 });

  await body.fill("A draft that belongs to draft-owner.");
  await page.keyboard.press("Control+s");
  await expect.poll(() => creates.length, { timeout: 15_000 }).toBe(1);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  await dialog.locator("#username").fill(INTRUDER.username);
  await dialog.locator("#password").fill("correct-password");
  await dialog.getByRole("button", { name: "Log in" }).click();
  // The login POST landed; the identity fetch did not.
  await expect.poll(() => phase, { timeout: 15_000 }).toBe("unresolvable");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+s");
  // Nothing more is sent, whoever that cookie belongs to.
  await expect.poll(() => creates.length, { timeout: 8_000 }).toBe(1);
  await expect(body).toHaveValue("A draft that belongs to draft-owner.");
});

test("a global auth failure requires a confirmed owner before the first editor save", async ({
  page,
}) => {
  let phase: "owner" | "expired" | "unknown" = "owner";
  let creates = 0;
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/auth/user/") {
        await route.fulfill(
          phase === "owner"
            ? { json: OWNER }
            : {
                status: phase === "expired" ? 401 : 503,
                json: { detail: "Identity unavailable" },
              },
        );
        return;
      }
      if (pathname === "/api/auth/login/") {
        phase = "unknown";
        await route.fulfill({
          json: { key: "session" },
          headers: {
            "set-cookie":
              "sessionid=other-account-session; Path=/; SameSite=Lax",
          },
        });
        return;
      }
      if (pathname === "/api/zpage/" && request.method() === "POST") {
        creates += 1;
        await route.fulfill({
          status: 401,
          json: { detail: "Session expired" },
        });
        return;
      }
      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );
  await page.goto("/edit");
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toBeVisible();
  await body.fill("The original owner's unsaved draft.");
  phase = "expired";
  const expired = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/user/") && response.status() === 401,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await (await expired).finished();
  // A different sign-in flow changes the shared cookie before this editor's
  // first save; its own save-401 latch has never fired.
  await page.evaluate(async () => {
    await fetch("/api/auth/login/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "other-account",
        password: "fixture-password",
      }),
    });
  });
  const unresolved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/user/") && response.status() === 503,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await (await unresolved).finished();
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("auth-modal-notice")).toBeVisible();
  expect(creates).toBe(0);
  await expect(body).toHaveValue("The original owner's unsaved draft.");
});

for (const scenario of ["renamed owner", "reused handle"] as const) {
  test(`editor ownership follows immutable identity after ${scenario}`, async ({
    page,
  }) => {
    let identity = {
      id: 8101,
      username: "draft-owner",
      full_name: "Draft Owner",
    };
    let creates = 0;
    await page.route(
      (url) => url.pathname.startsWith("/api/"),
      async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/auth/user/") {
          await route.fulfill({ json: identity });
        } else if (pathname === "/api/zpage/" && request.method() === "POST") {
          creates += 1;
          await route.fulfill({
            status: 400,
            json: { detail: "Recorded fixture save" },
          });
        } else {
          await route.fulfill({ json: { count: 0, results: [] } });
        }
      },
    );
    await page.goto("/edit");
    const body = page.locator("textarea.writing-area-textarea");
    await expect(body).toBeVisible();
    await body.fill("An unsaved draft belonging to immutable account 8101.");
    identity =
      scenario === "renamed owner"
        ? { ...identity, username: "renamed-owner" }
        : { ...identity, id: 8102 };
    await page.evaluate(async (loader) => {
      const { authStore } = await new Function(loader)();
      await authStore.checkAuth({ force: true });
    }, AUTH_STORE_LOADER);
    await page.keyboard.press("Control+s");
    if (scenario === "renamed owner") {
      await expect.poll(() => creates).toBeGreaterThan(0);
    } else {
      await expect(page.getByTestId("auth-modal-notice")).toBeVisible();
      expect(creates).toBe(0);
    }
    await expect(body).toHaveValue(
      "An unsaved draft belonging to immutable account 8101.",
    );
  });
}

for (const resume of ["canonical fallback", "queued manual save"] as const) {
  for (const sameOwner of [false, true]) {
    test(`a ${sameOwner ? "same-owner login permits" : "different-account login blocks"} the ${resume} after waiting`, async ({
      page,
    }) => {
      let identity = OWNER;
      const creates: Array<{
        owner: number;
        payload: Record<string, unknown>;
      }> = [];
      let releaseFirst!: () => void;
      const firstReleased = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      await page.route(
        (url) => url.pathname.startsWith("/api/"),
        async (route) => {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          if (pathname === "/api/auth/user/") {
            await route.fulfill({ json: identity });
          } else if (pathname === "/api/auth/login/") {
            identity = sameOwner ? OWNER : INTRUDER;
            await route.fulfill({
              json: { key: "session" },
              headers: {
                "set-cookie": `sessionid=${identity.username}; Path=/; SameSite=Lax`,
              },
            });
          } else if (
            pathname === "/api/zpage/" &&
            request.method() === "POST"
          ) {
            creates.push({
              owner: identity.id,
              payload: JSON.parse(request.postData() || "{}"),
            });
            if (creates.length === 1) {
              await firstReleased;
              await route.fulfill({
                status: 400,
                json:
                  resume === "canonical fallback"
                    ? { canonical_url: ["Enter a valid URL."] }
                    : { detail: "Delayed rejected save" },
              });
            } else {
              await route.fulfill({
                status: 500,
                json: { detail: "Resumed request recorded" },
              });
            }
          } else {
            await route.fulfill({ json: { count: 0, results: [] } });
          }
        },
      );
      await page.goto("/edit");
      const body = page.locator("textarea.writing-area-textarea");
      await expect(body).toBeVisible();
      await page
        .getByPlaceholder("Article title...")
        .fill("Original owner's draft");
      await body.fill("Only immutable account 8101 may save these words.");
      if (resume === "canonical fallback") {
        await page
          .getByRole("button", { name: "Publish", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Add the original article URL" })
          .click();
        await page
          .getByLabel("Original article URL", { exact: true })
          .fill("https://original.example/article");
        await page.keyboard.press("Escape");
      }
      await expect.poll(() => creates.length).toBe(1);
      if (resume === "canonical fallback") {
        expect(creates[0].payload.canonical_url).toBe(
          "https://original.example/article",
        );
      } else {
        // This call enters handleSave as the owner, then waits for the autosave.
        await page.keyboard.press("Control+s");
      }
      await page.evaluate(
        async ({ loader, username }) => {
          const { authStore } = await new Function(loader)();
          await authStore.loginOnly(username, "fixture-password");
        },
        {
          loader: AUTH_STORE_LOADER,
          username: sameOwner ? OWNER.username : INTRUDER.username,
        },
      );
      const completed = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/zpage/") && response.status() === 400,
      );
      releaseFirst();
      await (await completed).finished();
      // Both the former bad retry and a correct refusal settle the save UI.
      // Assert the actual outgoing ownership before checking the recovery copy.
      await expect(
        page
          .locator('[role="status"]')
          .filter({ hasText: /different account|Failed to save article/ })
          .first(),
      ).toBeVisible();
      expect(creates.map((create) => create.owner)).toEqual(
        sameOwner ? [OWNER.id, OWNER.id] : [OWNER.id],
      );
      const currentIdentity = await page.evaluate(async (loader) => {
        const { authStore } = await new Function(loader)();
        let creatorId: number | undefined;
        const unsubscribe = authStore.subscribe((state: any) => {
          creatorId = state.creator?.id;
        });
        unsubscribe();
        return creatorId;
      }, AUTH_STORE_LOADER);
      expect(currentIdentity).toBe(sameOwner ? OWNER.id : INTRUDER.id);
      await expect(body).toHaveValue(
        "Only immutable account 8101 may save these words.",
      );
      await expect(page).toHaveURL("/edit");
      if (!sameOwner) {
        await expect(
          page
            .locator('[role="status"]')
            .filter({
              hasText: `Sign in as ${OWNER.username} to save this draft.`,
            })
            .first(),
        ).toBeVisible();
      }
    });
  }
}

for (const path of ["save", "reconcile"] as const) {
  for (const session of ["expired", "replaced-same-id"] as const) {
    test(`${path} raw401 ${session} attributes sign-in only to the request's credential session`, async ({
      page,
    }) => {
      const posts: Array<{ key: string | undefined; body: string | null }> = [];
      let held: import("@playwright/test").Route | undefined;
      if (path === "reconcile")
        await page.addInitScript(() =>
          sessionStorage.setItem("f2z.zpageCreateKeyHonored", "1"),
        );
      await page.route(
        (url) => url.pathname.startsWith("/api/"),
        async (route) => {
          const request = route.request(),
            pathname = new URL(request.url()).pathname;
          if (pathname === "/api/auth/user/")
            return route.fulfill({ json: OWNER });
          if (pathname === "/api/auth/login/")
            return route.fulfill({ json: { key: "replacement-session" } });
          if (pathname === "/api/zpage/" && request.method() === "POST") {
            posts.push({
              key: request.headers()["idempotency-key"],
              body: request.postData(),
            });
            if (path === "reconcile" && posts.length === 1)
              return route.fulfill({
                status: 503,
                headers: { "Idempotency-Key-Honored": "true" },
                json: { detail: "Initial ambiguous create" },
              });
            held = route;
            return;
          }
          return route.fulfill({ json: { count: 0, results: [] } });
        },
      );
      await page.goto("/edit");
      const body = page.locator("textarea.writing-area-textarea");
      await expect(body).toBeVisible();
      await body.fill("The original owner keeps this unsaved document.");
      await page.keyboard.press("Control+s");
      if (path === "reconcile") {
        await expect(
          page.getByText("Initial ambiguous create", { exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Control+s");
      }
      await expect.poll(() => Boolean(held)).toBe(true);
      if (session === "replaced-same-id") {
        await page.evaluate(async () => {
          const module = "/src/lib/stores/auth.ts",
            { authStore } = await import(module);
          if (!(await authStore.loginOnly("draft-owner", "password")).success)
            throw new Error("Same-ID credential adoption failed");
          (window as any).replacementEditorOwner =
            authStore.captureRequestOwnership();
        });
      }
      const answered = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/zpage/") && response.status() === 401,
      );
      await held!.fulfill({
        status: 401,
        json: { detail: "Old credential session expired" },
      });
      await (await answered).finished();
      await expect(body).toHaveValue(
        "The original owner keeps this unsaved document.",
      );
      if (session === "expired") {
        await expect(page.getByRole("dialog")).toBeVisible();
        await expect
          .poll(() =>
            page.evaluate(async () => {
              const module = "/src/lib/stores/auth.ts";
              let state: any;
              (await import(module)).authStore.subscribe(
                (value: any) => (state = value),
              )();
              return state.status;
            }),
          )
          .toBe("anonymous");
      } else {
        // Waiting for the actual save outcome observes the handler, not only
        // fetch completion; the replaced session must survive its late 401.
        await expect(
          page
            .locator('[role="status"]:not([data-testid="auth-modal-notice"])')
            .filter({ hasText: /Sign in|sign in/ })
            .first(),
        ).toBeVisible();
        expect(
          await page.evaluate(async () => {
            const module = "/src/lib/stores/auth.ts";
            let state: any;
            (await import(module)).authStore.subscribe(
              (value: any) => (state = value),
            )();
            return {
              status: state.status,
              username: state.creator?.username,
              owned: (window as any).replacementEditorOwner(),
            };
          }),
        ).toEqual({
          status: "authenticated",
          username: OWNER.username,
          owned: true,
        });
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
      expect(posts.length).toBe(path === "reconcile" ? 2 : 1);
      if (path === "reconcile") {
        expect(posts[1].key).toBe(posts[0].key);
        expect(posts[1].body).toBe(posts[0].body);
      }
    });
  }
}
