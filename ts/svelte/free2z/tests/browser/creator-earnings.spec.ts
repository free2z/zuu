import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalScroll } from "./mobile-layout-guards";

const url = "/fixtureowner/dashboard/billing";
const capabilities = {
  policy_version: 1,
  active: true,
  creator_compensation_available: true,
};
const earnings = {
  actor_id: 4301,
  recent_activity: [],
  onboarding_required: false,
  currency: "USD",
  balance: "0.000000000",
  held: "0.000000000",
  available: "0.000000000",
  payment_in_flight: "0.000000000",
  recovery: null,
  recovery_available: false,
  agreement_accepted: true,
  compensation_eligible: true,
  legal_payee: {
    display_name: "Synthetic Verified Creator",
    jurisdiction: "US",
  },
};
const schedules = ["sdk_application", "livestream_ppv"].map((service) => ({
  service,
  version: "test-v1",
  digest: `digest-${service}`,
  text: `Actual synthetic ${service} schedule text.`,
  currency: "USD",
  usd_per_allocated_m2z: "0.000010000",
}));
const agreement = {
  version: "test-agreement-v1",
  digest: "test-digest",
  text: "Canonical synthetic compensation agreement. Separate from the old tax signature.",
  schedules,
};

async function fixture(
  page: Page,
  options: {
    capabilities?: unknown;
    earnings?: unknown;
    status?: number;
    agreement?: unknown;
    handler?: (
      path: string,
      payload: any,
      query: URLSearchParams,
    ) => Promise<any>;
  } = {},
) {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route(
    (target) => target.pathname.startsWith("/api/economy/"),
    async (route) => {
      const parsed = new URL(route.request().url());
      const path = parsed.pathname.replace("/api/economy/", "");
      const payload =
        route.request().method() === "POST"
          ? route.request().postDataJSON()
          : null;
      if (options.handler) {
        const result = await options.handler(
          path,
          payload,
          parsed.searchParams,
        );
        if (result === "abort") {
          await route.abort("failed");
          return;
        }
        if (result !== undefined) {
          await route.fulfill(
            result.httpStatus
              ? { status: result.httpStatus, json: result.body }
              : { json: result },
          );
          return;
        }
      }
      if (path === "earnings/") {
        await route.fulfill({
          status: options.status || 200,
          json: options.earnings || earnings,
        });
        return;
      }
      const body =
        path === "capabilities/"
          ? options.capabilities || capabilities
          : path === "agreement/"
            ? options.agreement || agreement
            : { actor_id: 4301, results: [] };
      await route.fulfill({ json: body });
    },
  );
}

for (const width of [320, 390, 1280]) {
  test(`actual zero USD stays separate from 64k usage credits at ${width}px`, async ({
    page,
  }) => {
    await fixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url);
    await expect(page.getByTestId("earnings-balance")).toContainText(
      "$0.00 USD",
    );
    await expect(page.getByTestId("billing-balance-value")).toContainText(
      "64,672.23",
    );
    await expect(page.getByTestId("creator-earnings")).not.toContainText(
      "$646.72",
    );
    await expect(
      page.getByRole("button", { name: "Authorize and buy credits" }),
    ).toHaveCount(0);
    await expectNoHorizontalScroll(page, `earnings at ${width}`);
    if (process.env.ECONOMY_CAPTURE_DIR) {
      await page.getByTestId("creator-earnings").screenshot({
        path: resolve(
          process.env.ECONOMY_CAPTURE_DIR,
          `earnings-synthetic-zero-${width}.png`,
        ),
      });
    }
  });
}

test("inactive compensation keeps tiny owed USD visible and disables transactions", async ({
  page,
}) => {
  await fixture(page, {
    capabilities: {
      policy_version: 0,
      active: false,
      creator_compensation_available: false,
    },
    earnings: {
      ...earnings,
      balance: "0.000010000",
      available: "0.000010000",
      compensation_eligible: false,
    },
  });
  await page.goto(url);
  await expect(page.getByTestId("earnings-balance")).toContainText(
    "$0.00001 USD",
  );
  await expect(
    page.getByRole("button", { name: "Authorize and request payment" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Recorded earnings remain owed.", { exact: false }),
  ).toBeVisible();
});

for (const [status, body, expected] of [
  [409, { code: "earnings_onboarding_required" }, "Complete verification"],
  [503, { code: "temporary_writer_unavailable" }, "Earnings are unavailable"],
] as const) {
  test(`earnings ${status} never manufactures a zero balance`, async ({
    page,
  }) => {
    await fixture(page, { status, earnings: body });
    await page.goto(url);
    await expect(page.getByTestId("creator-earnings")).toContainText(expected);
    await expect(page.getByTestId("earnings-balance")).toHaveCount(0);
  });
}

test("acceptance captures the displayed canonical agreement and all schedules independently", async ({
  page,
}) => {
  let accepted: any = null;
  await fixture(page, {
    earnings: {
      ...earnings,
      agreement_accepted: false,
      compensation_eligible: false,
      balance: "0.000010000",
      available: "0.000010000",
    },
    capabilities: {
      policy_version: 0,
      active: false,
      creator_compensation_available: false,
    },
    handler: async (path, payload) => {
      if (path === "earnings/" && accepted) {
        return {
          ...earnings,
          agreement_accepted: true,
          compensation_eligible: false,
          balance: "0.000010000",
          available: "0.000010000",
        };
      }
      if (path !== "agreement/accept/") return;
      accepted = payload;
      return {
        version: agreement.version,
        digest: agreement.digest,
        agreement_accepted: true,
        accepted_at: new Date().toISOString(),
      };
    },
  });
  await page.goto(url);
  await expect(
    page.getByRole("button", { name: "Accept agreement" }),
  ).toBeDisabled();
  await page
    .getByText("Read the creator compensation agreement", { exact: false })
    .click();
  await expect(page.getByText(agreement.text)).toBeVisible();
  for (const schedule of schedules) {
    await page
      .getByText(`${schedule.service} (${schedule.version})`, { exact: true })
      .click();
    await expect(page.getByText(schedule.text)).toBeVisible();
  }
  await page
    .getByRole("checkbox", { name: "I have read this agreement", exact: false })
    .check();
  await page.getByRole("button", { name: "Accept agreement" }).click();
  await expect
    .poll(() => accepted)
    .toEqual({
      expected_actor_id: 4301,
      version: agreement.version,
      digest: agreement.digest,
      acknowledged: true,
      schedules: schedules.map(({ service, version, digest }) => ({
        service,
        version,
        digest,
      })),
    });
  const panel = page.getByTestId("creator-earnings");
  await expect(panel).toContainText(
    "This account cannot offer qualifying paid services right now.",
  );
  await expect(panel).toContainText(
    "Payment requests are temporarily unavailable.",
  );
  await expect(page.getByTestId("earnings-balance")).toContainText(
    "$0.00001 USD",
  );
  await expect(
    page.getByRole("button", { name: "Authorize and request payment" }),
  ).toBeDisabled();
});

test("ended future participation preserves tiny owed payment and reports request rather than payment", async ({
  page,
}) => {
  let submitted: any = null;
  await fixture(page, {
    earnings: {
      ...earnings,
      balance: "0.000010000",
      available: "0.000010000",
      compensation_eligible: false,
    },
    handler: async (path, payload) => {
      if (path !== "payments/" || !payload) return;
      submitted = payload;
      return {
        id: "payment-id",
        currency: "USD",
        amount: payload.amount,
        state: "requested",
      };
    },
  });
  await page.goto(url);
  await expect(page.getByTestId("earnings-balance")).toContainText(
    "$0.00001 USD",
  );
  await page
    .getByLabel("Your shielded Zcash payment address")
    .fill("u1syntheticpaymentaddress");
  await page
    .getByRole("button", { name: "Authorize and request payment" })
    .click();
  await expect.poll(() => submitted).not.toBeNull();
  expect(submitted.amount).toBe("0.000010000");
  expect(submitted.address).toBe("u1syntheticpaymentaddress");
  await expect(page.getByTestId("creator-earnings")).toContainText(
    "Payment request recorded",
  );
});

test("actual pending capture is not presented as issued credits", async ({
  page,
}) => {
  await fixture(page, {
    handler: async (path) =>
      path === "funding-resolutions/"
        ? {
            actor_id: 4301,
            results: [
              {
                status: "pending_resolution",
                credited: false,
                resolution_id: "funding:123",
                reason: "issuance_cap",
                created_at: "2026-10-10T00:00:00Z",
              },
            ],
          }
        : undefined,
  });
  await page.goto(url);
  await expect(page.getByTestId("creator-earnings")).toContainText(
    "funding:123",
  );
  await expect(page.getByTestId("creator-earnings")).toContainText(
    "Credit purchases awaiting resolution",
  );
});

test("financial mutation revalidates identity and refuses a switched account", async ({
  page,
}) => {
  let writes = 0;
  await fixture(page, {
    earnings: {
      ...earnings,
      balance: "10.000000000",
      available: "10.000000000",
    },
    handler: async (path, payload) => {
      if (path === "payments/" && payload) {
        writes++;
        return { id: "unexpected" };
      }
    },
  });
  await page.goto(url);
  await expect(page.getByTestId("earnings-balance")).toBeVisible();
  await page
    .getByLabel("Your shielded Zcash payment address")
    .fill("u1syntheticpaymentaddress");
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({
      json: { id: 4302, username: "other-synthetic-account", tuzis: 0 },
    }),
  );
  await page
    .getByRole("button", { name: "Authorize and request payment" })
    .click();
  await expect(page.getByTestId("earnings-balance")).toHaveCount(0);
  expect(writes).toBe(0);
});

test("a request saved in another tab requires reviewing its original displayed amount and destination before retry", async ({
  page,
  context,
}) => {
  const second = await context.newPage();
  const posts: any[] = [];
  const setup = {
    earnings: {
      ...earnings,
      balance: "100.000000000",
      available: "100.000000000",
    },
    handler: async (path: string, payload: any) => {
      if (path !== "payments/" || !payload) return;
      posts.push(payload);
      if (posts.length === 1) return "abort";
      return {
        id: "original-payment",
        currency: "USD",
        amount: payload.amount,
        state: "requested",
      };
    },
  };
  await fixture(page, setup);
  await fixture(second, setup);
  await page.goto(url);
  await second.goto(url);
  await page.getByLabel("Amount in USD", { exact: true }).first().fill("100");
  await page
    .getByLabel("Your shielded Zcash payment address")
    .fill("u1originalrecipient");
  await second.getByLabel("Amount in USD", { exact: true }).first().fill("1");
  await second
    .getByLabel("Your shielded Zcash payment address")
    .fill("u1differentrecipient");
  await page
    .getByRole("button", { name: "Authorize and request payment" })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry original request" }),
  ).toBeEnabled();
  await second
    .getByRole("button", { name: "Authorize and request payment" })
    .click();
  await expect(
    second.getByLabel("Your shielded Zcash payment address"),
  ).toHaveValue("u1originalrecipient");
  await expect(
    second.getByLabel("Amount in USD", { exact: true }).first(),
  ).toHaveValue("100.000000000");
  expect(posts).toHaveLength(1);
  await expect(second.getByTestId("creator-earnings")).toContainText(
    "Review them before retrying",
  );
  await second.getByRole("button", { name: "Retry original request" }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toEqual(posts[0]);
  await second.close();
});

test("a stalled auxiliary history read cannot hide an actual owed balance", async ({
  page,
}) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await fixture(page, {
    earnings: {
      ...earnings,
      balance: "10.000000000",
      available: "10.000000000",
    },
    handler: async (path) => {
      if (path === "funding-resolutions/") {
        await held;
        return { actor_id: 4301, results: [] };
      }
    },
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("earnings-balance")).toContainText(
    "$10.00 USD",
  );
  await expect(
    page.getByRole("button", { name: "Authorize and request payment" }),
  ).toBeEnabled();
  release();
});

test("actual PPV and SDK journal entries explain USD earnings without utility event inference", async ({
  page,
}) => {
  await fixture(page, {
    earnings: {
      ...earnings,
      balance: "0.000020000",
      available: "0.000020000",
      recent_activity: [
        {
          id: "payable:101",
          service: "livestream_ppv",
          currency: "USD",
          amount: "0.000010000",
          created_at: "2026-10-10T12:00:00Z",
        },
        {
          id: "payable:102",
          service: "sdk_application",
          currency: "USD",
          amount: "0.000010000",
          created_at: "2026-10-10T13:00:00Z",
        },
      ],
    },
  });
  await page.goto(url);
  const activity = page.getByTestId("earnings-activity");
  await expect(
    activity.getByText("Pay-per-view livestream", { exact: true }),
  ).toBeVisible();
  await expect(
    activity.getByText("SDK application service", { exact: true }),
  ).toBeVisible();
  await expect(activity.getByText("Reference: payable:101")).toBeVisible();
  await expect(activity).toContainText("0.00001");
});

test("reused financial components clear original actor inputs when owner and session change together", async ({
  page,
}) => {
  await fixture(page, {
    handler: async (path, _payload, query) =>
      path === "earnings/"
        ? {
            ...earnings,
            actor_id: Number(query.get("expected_actor_id")),
            balance: "1.000000000",
            available: "1.000000000",
          }
        : undefined,
  });
  await page.goto(url);
  await expect(page.getByTestId("earnings-balance")).toBeVisible();
  await page.evaluate(async () => {
    // Keep one real form instance in the document; IDs must remain unique.
    document.querySelector("main")?.remove();
    const target = document.createElement("div");
    document.body.append(target);
    const svelteModule = "/tests/browser/svelte-runtime.ts";
    const fixtureModule =
      "/tests/browser/economy-owner-boundary-fixture.svelte";
    const [{ mount }, { default: Fixture }] = await Promise.all([
      import(svelteModule),
      import(fixtureModule),
    ]);
    mount(Fixture, { target });
  });
  const reused = page.getByTestId("economy-reused-owner");
  await reused.getByLabel("Amount in USD").fill("0.250000000");
  await reused
    .getByLabel("Your shielded Zcash payment address")
    .fill("u1original-private-destination");
  await page.evaluate(() => (window as any).switchEconomyFixtureOwner());
  await expect(
    reused.getByLabel("Your shielded Zcash payment address"),
  ).toHaveValue("");
  await expect(reused.getByLabel("Amount in USD")).toHaveValue("1.000000000");
});

test("an excessive USD amount creates no durable intent and an authoritative insufficient refusal allows correction", async ({
  page,
}) => {
  let posts = 0;
  await fixture(page, {
    earnings: {
      ...earnings,
      balance: "10.000000000",
      available: "10.000000000",
    },
    handler: async (path, payload) => {
      if (path === "payments/" && payload && ++posts && posts === 1)
        return {
          httpStatus: 409,
          body: {
            code: "insufficient_payable",
            detail: "Available USD changed; no amount held.",
          },
        };
    },
  });
  await page.goto(url);
  await page.getByLabel("Amount in USD").fill("100");
  await page
    .getByLabel("Your shielded Zcash payment address")
    .fill("u1syntheticdestination");
  await page
    .getByRole("button", { name: "Authorize and request payment" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Enter an amount no greater than your available USD",
  );
  expect(posts).toBe(0);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("f2z:economy-intent:v1:4301:payment"),
    ),
  ).toBeNull();
  await page.getByLabel("Amount in USD").fill("10");
  await page
    .getByRole("button", { name: "Authorize and request payment" })
    .click();
  await expect(page.getByRole("alert")).toContainText("Available USD changed");
  await expect(page.getByLabel("Amount in USD")).toBeEnabled();
  await expect(
    page.getByLabel("Your shielded Zcash payment address"),
  ).toBeEnabled();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("f2z:economy-intent:v1:4301:payment"),
    ),
  ).toBeNull();
});

test("standing payment acceptance preserves payout access and allows independent current-agreement acceptance", async ({
  page,
}) => {
  let acceptedBody: any;
  await fixture(page, {
    earnings: {
      ...earnings,
      balance: "1.000000000",
      available: "1.000000000",
      compensation_eligible: false,
    },
    handler: async (path, payload) => {
      if (path === "agreement/accept/") {
        acceptedBody = payload;
        return {
          version: agreement.version,
          digest: agreement.digest,
          accepted_at: new Date().toISOString(),
          agreement_accepted: true,
        };
      }
    },
  });
  await page.goto(url);
  await expect(
    page.getByRole("button", { name: "Authorize and request payment" }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Review current service agreement" })
    .click();
  await expect(
    page.getByText(agreement.version, { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: /I have read this agreement/ })
    .check();
  await page
    .getByRole("button", { name: "Accept agreement", exact: true })
    .click();
  await expect.poll(() => acceptedBody?.version).toBe(agreement.version);
  expect(acceptedBody.schedules).toEqual(
    schedules.map(({ service, version, digest }) => ({
      service,
      version,
      digest,
    })),
  );
  await expect(
    page.getByRole("button", { name: "Authorize and request payment" }),
  ).toBeEnabled();
});

test("cookie-switch and switch-back private responses cannot display another actor's earnings or records", async ({
  page,
}) => {
  const assertions: string[] = [];
  await fixture(page, {
    handler: async (path, _payload, query) => {
      if (["earnings/", "payments/", "funding-resolutions/"].includes(path)) {
        assertions.push(query.get("expected_actor_id") || "missing");
        // The displayed store remains A; an authenticated read raced cookie B,
        // then the cookie returned to A before the response reached this page.
        await page.context().addCookies([
          {
            name: "sessionid",
            value: "other-synthetic-session",
            domain: "127.0.0.1",
            path: "/",
          },
        ]);
        await page.context().addCookies([
          {
            name: "sessionid",
            value: "billing-fixture-session",
            domain: "127.0.0.1",
            path: "/",
          },
        ]);
        if (path === "earnings/")
          return {
            ...earnings,
            actor_id: 4302,
            balance: "999.000000000",
            available: "999.000000000",
          };
        if (path === "payments/")
          return {
            actor_id: 4302,
            results: [
              {
                id: "other-actor-private-payment",
                currency: "USD",
                amount: "999.000000000",
                state: "requested",
                held: true,
                created_at: "2026-10-10T00:00:00Z",
                updated_at: "2026-10-10T00:00:00Z",
                txid: null,
              },
            ],
          };
        return {
          actor_id: 4302,
          results: [
            {
              status: "pending_resolution",
              credited: false,
              resolution_id: "other-actor-private-resolution",
              reason: "issuance_cap",
              created_at: "2026-10-10T00:00:00Z",
            },
          ],
        };
      }
    },
  });
  await page.goto(url);
  const panel = page.getByTestId("creator-earnings");
  await expect(panel).toContainText("unavailable");
  await expect(page.getByTestId("earnings-balance")).toHaveCount(0);
  await expect(panel).not.toContainText("999");
  await expect(panel).not.toContainText("other-actor-private");
  expect(assertions).toHaveLength(3);
  expect(assertions).toEqual(["4301", "4301", "4301"]);
});
