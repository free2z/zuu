import { expect, test } from "@playwright/test";

test("card purchase shows exact charged total before opening and resumes the original after reload", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("zuuli.knox.token", "mock-knox-token"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  let checkoutNavigations = 0;
  await page.route("https://checkout.stripe.com/**", async (route) => {
    checkoutNavigations++;
    await route.fulfill({
      contentType: "text/html",
      body: "Synthetic Stripe checkout",
    });
  });
  await page.goto("/wallet/fund");
  await page.getByLabel("Custom amount (2Z)").fill("2000");
  await expect(page.getByText("Face value before card fees")).toBeVisible();
  await page.getByRole("button", { name: "Review card purchase" }).click();
  const pay = page.getByRole("button", {
    name: "Pay with card $22.00 USD",
    exact: true,
  });
  await expect(pay).toBeVisible();
  await expect(
    page.getByText(
      "Exact server quote: 2,000 2Z for $22.00 USD, including fees.",
    ),
  ).toBeVisible();
  expect(checkoutNavigations).toBe(0);
  const original = await page.evaluate(
    () =>
      Object.entries(localStorage).find(([key]) =>
        key.startsWith("zuuli.card-purchase."),
      )?.[1],
  );
  await page.reload();
  await page.getByLabel("Custom amount (2Z)").fill("1");
  await page.getByRole("button", { name: "Review card purchase" }).click();
  await expect(pay).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        Object.entries(localStorage).find(([key]) =>
          key.startsWith("zuuli.card-purchase."),
        )?.[1],
    ),
  ).toBe(original);
  await pay.click();
  await expect(page).toHaveURL(
    "https://checkout.stripe.com/c/pay/cs_test_mockcheckout",
  );
  expect(checkoutNavigations).toBe(1);
});

test("an expired quote keeps the original receipt check and cannot open checkout", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("zuuli.knox.token", "mock-knox-token"),
  );
  await page.goto("/wallet/fund");
  await page.getByRole("button", { name: "Review card purchase" }).waitFor();
  await page.evaluate(async () => {
    const source = "/src/lib/api/free2z.ts";
    const { tuzi } = await import(source);
    const original = tuzi.buyCheckout;
    tuzi.buyCheckout = async (...args: unknown[]) => ({
      ...(await original(...args)),
      expires_at: 1,
    });
  });
  await page.getByRole("button", { name: "Review card purchase" }).click();
  await expect(
    page.getByText("This checkout quote expired.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Pay with card $22.00 USD", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Check payment receipt" }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => localStorage.getItem("zuuli.card-purchase.1")),
  ).not.toBeNull();
});

test("receipt retries use backend quantity and refresh instead of incrementing locally", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("zuuli.knox.token", "mock-knox-token"),
  );
  await page.goto("/wallet/fund");
  await page.getByRole("button", { name: "Review card purchase" }).click();
  await page.getByRole("button", { name: "Check payment receipt" }).waitFor();
  await page.evaluate(async () => {
    const source = "/src/lib/api/free2z.ts";
    const { tuzi } = await import(source);
    let attempts = 0;
    tuzi.checkoutReturnStatus = async () =>
      ++attempts === 1
        ? { status: "processing" }
        : { status: "credited", tuzisCredited: 2000 };
  });
  await page.getByRole("button", { name: "Check payment receipt" }).click();
  await expect(
    page.getByText("Payment processing", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("zuuli.card-purchase.1")),
  ).not.toBeNull();
  await page.getByRole("button", { name: "Check payment receipt" }).click();
  await expect(
    page.getByText("2,000 2Z purchase confirmed", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("zuuli.card-purchase.1")),
  ).toBeNull();
  await expect(
    page.getByRole("link", { name: "Buy 2Zs. Balance 4,210 2Z", exact: true }),
  ).toBeVisible();
});

test("rendered mobile fallback persists web terms before creation and survives opener failure and reload", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("zuuli.knox.token", "mock-knox-token"),
  );
  async function installMobileProvider() {
    await page.evaluate(async () => {
      const source = "/src/lib/api/free2z.ts",
        httpSource = "/src/lib/api/http.ts";
      const { tuzi } = await import(source),
        { ApiError } = await import(httpSource);
      const original = tuzi.buyCheckout;
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: { url?: string }) => {
            if (command === "oauth_callback_transport") return "mobile";
            if (command === "plugin:opener|open_url") {
              const attempts =
                Number(localStorage.getItem("opener-attempts") ?? 0) + 1;
              localStorage.setItem("opener-attempts", String(attempts));
              if (attempts === 1) throw new Error("Synthetic opener refusal");
              localStorage.setItem("opened-original", args.url!);
              return;
            }
            throw new Error(`Unexpected fixture command: ${command}`);
          },
        },
      });
      tuzi.buyCheckout = async (
        quantity: number,
        mode: string,
        pending: { key: string },
      ) => {
        const existing = localStorage.getItem("synthetic-provider-order");
        if (existing) {
          const stored = JSON.parse(existing);
          if (mode !== "web" || pending.key !== stored.key)
            throw new ApiError(409, "terms changed");
          return stored.order;
        }
        if (mode === "zuuli_mobile")
          throw new ApiError(503, "native gate", {
            code: "native_checkout_unavailable",
          });
        const saved = JSON.parse(
          localStorage.getItem("zuuli.card-purchase.1")!,
        );
        if (saved.key !== pending.key || saved.returnMode !== "web")
          throw new Error(
            "Fallback was not persisted before the provider write",
          );
        const order = await original(quantity, mode, pending);
        localStorage.setItem(
          "synthetic-provider-order",
          JSON.stringify({ key: pending.key, order }),
        );
        localStorage.setItem(
          "synthetic-sessions",
          String(Number(localStorage.getItem("synthetic-sessions") ?? 0) + 1),
        );
        return order;
      };
    });
  }
  await page.goto("/wallet/fund");
  await page.getByRole("button", { name: "Review card purchase" }).waitFor();
  await installMobileProvider();
  await page.getByRole("button", { name: "Review card purchase" }).click();
  const pay = page.getByRole("button", {
    name: "Pay with card $22.00 USD",
    exact: true,
  });
  await expect(pay).toBeEnabled();
  const pending = await page.evaluate(() =>
    localStorage.getItem("zuuli.card-purchase.1"),
  );
  expect(JSON.parse(pending!).returnMode).toBe("web");
  await pay.click();
  await expect(
    page.getByText("Synthetic opener refusal", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Review card purchase" }).waitFor();
  await installMobileProvider();
  await page.getByRole("button", { name: "Review card purchase" }).click();
  await expect(pay).toBeEnabled();
  await pay.click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("opened-original")))
    .toBe("https://checkout.stripe.com/c/pay/cs_test_mockcheckout");
  expect(
    await page.evaluate(() => localStorage.getItem("zuuli.card-purchase.1")),
  ).toBe(pending);
  expect(
    await page.evaluate(() => localStorage.getItem("synthetic-sessions")),
  ).toBe("1");
  expect(
    await page.evaluate(() => localStorage.getItem("opener-attempts")),
  ).toBe("2");
});

for (const transition of ["B", "ABA", "unmount"]) {
  test(`confirmed receipt refresh cannot publish or toast after ${transition}`, async ({
    page,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem("zuuli.knox.token", "mock-knox-token"),
    );
    await page.goto("/wallet/fund");
    await page.getByRole("button", { name: "Review card purchase" }).click();
    await page.getByRole("button", { name: "Check payment receipt" }).waitFor();
    await page.evaluate(async () => {
      const source = "/src/lib/api/free2z.ts",
        sessionSource = "/src/store/session.ts";
      const { tuzi, auth } = await import(source),
        { useSession } = await import(sessionSource);
      const owner = useSession.getState().user;
      tuzi.checkoutReturnStatus = async () => ({
        status: "credited",
        tuzisCredited: 2000,
      });
      auth.me = async () =>
        new Promise((resolve) => {
          Object.assign(window, {
            finishReceiptRefresh: () => resolve({ ...owner, tuzis: 6210 }),
            receiptRefreshing: true,
          });
        });
    });
    await page.getByRole("button", { name: "Check payment receipt" }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).receiptRefreshing))
      .toBe(true);
    expect(
      await page.evaluate(() => localStorage.getItem("zuuli.card-purchase.1")),
    ).toBeNull();
    await page.evaluate(async (change) => {
      const source = "/src/store/session.ts",
        httpSource = "/src/lib/api/http.ts";
      const { useSession } = await import(source),
        { setToken } = await import(httpSource);
      const owner = useSession.getState().user;
      if (change === "unmount") {
        window.history.pushState({}, "", "/about");
        window.dispatchEvent(new PopStateEvent("popstate"));
      } else {
        setToken("account-B");
        useSession
          .getState()
          .setUser({ ...owner, id: 2, username: "account-B", tuzis: 300 });
        if (change === "ABA") {
          setToken("mock-knox-token");
          useSession.getState().setUser(owner);
        }
      }
    }, transition);
    if (transition === "unmount")
      await expect(
        page.getByRole("heading", { name: "About & Feedback" }),
      ).toBeVisible();
    await page.evaluate(async () => {
      (window as any).finishReceiptRefresh();
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(
      await page.evaluate(async () => {
        const source = "/src/store/session.ts",
          httpSource = "/src/lib/api/http.ts";
        const { useSession } = await import(source),
          { getTokenSnapshot } = await import(httpSource);
        const state = useSession.getState();
        return {
          id: state.user.id,
          balance: state.tuzis,
          token: getTokenSnapshot().token,
        };
      }),
    ).toEqual(
      transition === "B"
        ? { id: 2, balance: 300, token: "account-B" }
        : { id: 1, balance: 4210, token: "mock-knox-token" },
    );
    await expect(
      page.getByText("2,000 2Z purchase confirmed", { exact: true }),
    ).toHaveCount(0);
  });
}

test("a generic mobile 503 cannot change saved terms or issue a fallback purchase", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
    localStorage.setItem(
      "zuuli.card-purchase.1",
      JSON.stringify({
        actorId: 1,
        key: "bfeefbbf-e9bf-44b2-912b-5cadad399811",
        quantity: 2000,
        returnMode: "zuuli_mobile",
      }),
    );
  });
  await page.goto("/wallet/fund");
  await page.getByRole("button", { name: "Review card purchase" }).waitFor();
  await page.evaluate(async () => {
    const source = "/src/lib/api/free2z.ts",
      httpSource = "/src/lib/api/http.ts";
    const { tuzi } = await import(source),
      { ApiError } = await import(httpSource);
    tuzi.buyCheckout = async () => {
      const count = Number(localStorage.getItem("synthetic-calls") ?? 0) + 1;
      localStorage.setItem("synthetic-calls", String(count));
      throw new ApiError(503, "checkout staged off", {
        code: "checkout_not_activated",
      });
    };
  });
  await page.getByRole("button", { name: "Review card purchase" }).click();
  await expect(
    page.getByText("Checkout unavailable", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("synthetic-calls")),
  ).toBe("1");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("zuuli.card-purchase.1")!).returnMode,
    ),
  ).toBe("zuuli_mobile");
  await expect(
    page.getByRole("button", { name: "Pay with card $22.00 USD", exact: true }),
  ).toHaveCount(0);
});
