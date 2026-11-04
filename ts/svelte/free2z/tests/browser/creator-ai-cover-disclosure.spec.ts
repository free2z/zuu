import { expect, test } from "@playwright/test";

const CREATOR = {
  id: 8104,
  username: "ai-cover-user",
  full_name: "AI Cover User",
};
const OPTIONS = {
  cover: [
    {
      id: "openai-image",
      provider: "openai",
      model: "gpt-image-fixture",
      display_name: "Image model A",
      destination: "OpenAI",
      privacy_policy_url: "https://openai.com/policies/privacy-policy/",
      snapshot_token: "openai-snapshot-a",
      price_basis: "fixed",
      price_2z: 6,
      availability: "Configured; checked again at submission.",
      queue: "Processed synchronously; no queue position or SLA.",
    },
    {
      id: "alternate-image",
      provider: "anthropic",
      model: "Image model B",
      display_name: "Image model B",
      destination: "Anthropic",
      privacy_policy_url: "https://www.anthropic.com/legal/privacy",
      snapshot_token: "anthropic-snapshot-a",
      price_basis: "fixed",
      price_2z: 9,
      availability: "Configured; checked again at submission.",
      queue: "Processed synchronously; no queue position or SLA.",
    },
  ],
  completion: [],
};

test("text completion quotes a chosen model and requires preview acceptance", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const calls: Record<string, unknown>[] = [];
  const requestKeys: string[] = [];
  let promptAttempts = 0;
  const textChoices = [
    {
      id: "text-a",
      provider: "openai",
      display_name: "Text model A",
      destination: "OpenAI",
      privacy_policy_url: "https://openai.com/policies/privacy-policy/",
      availability: "Configured",
      queue: "Synchronous",
    },
    {
      id: "text-b",
      provider: "anthropic",
      display_name: "Text model B",
      destination: "Anthropic",
      privacy_policy_url: "https://www.anthropic.com/legal/privacy",
      availability: "Configured",
      queue: "Synchronous",
    },
  ];
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "creator-ai-text-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === "/api/auth/user/")
        await route.fulfill({ json: CREATOR });
      else if (
        pathname === "/api/ai/creator-options/" &&
        request.method() === "GET"
      )
        await route.fulfill({ json: { cover: [], completion: textChoices } });
      else if (
        pathname === "/api/ai/creator-options/" &&
        request.method() === "POST"
      ) {
        const body = JSON.parse(request.postData() || "{}");
        calls.push(body);
        const selected =
          textChoices.find((choice) => choice.id === body.model) ??
          textChoices[0];
        await route.fulfill({
          json: {
            choice: selected,
            model: selected.id,
            max_output_tokens: 128,
            requested_output_tokens: 256,
            max_charge_2z: 4,
            quote_token: "quote-bound-to-prompt",
            availability: "Configured",
            queue: "Synchronous",
          },
        });
      } else if (
        pathname === "/api/ai/prompt/" &&
        request.method() === "POST"
      ) {
        const body = JSON.parse(request.postData() || "{}");
        calls.push(body);
        requestKeys.push(request.headers()["idempotency-key"] ?? "");
        if (promptAttempts++ === 0) {
          await route.fulfill({
            status: 503,
            json: { detail: "Temporary provider failure" },
          });
          return;
        }
        if (promptAttempts === 2) {
          await route.fulfill({
            status: 402,
            json: {
              code: "insufficient_funds",
              key_resolved: true,
              detail: "No charge was made.",
            },
          });
          return;
        }
        await route.fulfill({
          json: {
            response: "A reviewed paragraph.",
            provider: "anthropic",
            model: "text-b",
            display_name: "Text model B",
            tuzis_charged: 2,
            input_tokens: 8,
            output_tokens: 10,
          },
        });
      } else await route.fulfill({ json: { count: 0, results: [] } });
    },
  );
  await page.goto("/edit");
  await expect(page.locator("textarea.writing-area-textarea")).toBeVisible({
    timeout: 30_000,
  });
  const editor = page.locator("textarea.writing-area-textarea");
  await editor.fill("Existing draft stays here.");
  await page.getByText("Draft with AI").click();
  await page
    .getByLabel("Prompt (sent to the selected provider)")
    .fill("Write one paragraph about gardens.");
  const modelChoice = page.getByRole("combobox");
  await expect(modelChoice.locator('option[value="text-b"]')).toHaveCount(1);
  await modelChoice.selectOption("text-b");
  await page
    .getByRole("button", { name: "Show price and destination" })
    .click();
  await expect(page.getByText(/Maximum charge: 4 2Z/)).toBeVisible();
  await expect(
    page.getByText(/Reply cap for this prompt: 128 tokens \(requested: 256\)/),
  ).toBeVisible();
  await expect(
    page.getByText(/Your prompt will be sent to Anthropic/),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Provider privacy and retention policy" }),
  ).toHaveAttribute("href", textChoices[1].privacy_policy_url);
  expect(calls[0]).toMatchObject({
    model: "text-b",
    prompt: "Write one paragraph about gardens.",
  });
  await page
    .getByRole("button", { name: "Generate text (up to 4 2Z)" })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry exact request" });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(retry).toHaveCount(0);
  await modelChoice.selectOption("text-a");
  await page
    .getByRole("button", { name: "Show price and destination" })
    .click();
  await expect(
    page.getByText(/Your prompt will be sent to OpenAI/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Generate text (up to 4 2Z)" })
    .click();
  await expect(page.getByText("A reviewed paragraph.")).toBeVisible();
  await expect(editor).toHaveValue("Existing draft stays here.");
  expect(calls.at(-1)).toMatchObject({
    model: "text-a",
    prompt: calls[0].prompt,
    quote_token: "quote-bound-to-prompt",
    max_output_tokens: 256,
  });
  expect(calls[1]).toEqual(calls[2]);
  expect(requestKeys[0]).toBe(requestKeys[1]);
  expect(calls[1]).toMatchObject({ model: "text-b", prompt: calls[0].prompt });
  await page.getByRole("button", { name: "Insert text" }).click();
  await expect(editor).toHaveValue(
    "Existing draft stays here.\n\nA reviewed paragraph.",
  );
  await page
    .getByLabel("Prompt (sent to the selected provider)")
    .fill("Discard this result");
  await page
    .getByRole("button", { name: "Show price and destination" })
    .click();
  await page.getByRole("button", { name: /Generate text/ }).click();
  await expect(page.getByText("A reviewed paragraph.")).toBeVisible();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByText("A reviewed paragraph.")).toHaveCount(0);
  await expect(editor).toHaveValue(
    "Existing draft stays here.\n\nA reviewed paragraph.",
  );
  await page.getByRole("button", { name: /Generate text/ }).click();
  await expect(page.getByText("A reviewed paragraph.")).toBeVisible();
  await editor.fill("Changed after preview");
  await expect(page.getByText("A reviewed paragraph.")).toHaveCount(0);
  await expect(editor).toHaveValue("Changed after preview");
});

test("text completion keeps the newest quote when responses arrive out of order", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const choices = [
    {
      id: "quote-a",
      provider: "openai",
      display_name: "Quote A",
      destination: "OpenAI",
      privacy_policy_url: "https://openai.com/policies/privacy-policy/",
      availability: "Ready",
      queue: "Now",
    },
    {
      id: "quote-b",
      provider: "anthropic",
      display_name: "Quote B",
      destination: "Anthropic",
      privacy_policy_url: "https://www.anthropic.com/legal/privacy",
      availability: "Ready B",
      queue: "Queued B",
    },
  ];
  let releaseA!: () => void;
  let quoteAStarted!: () => void;
  const quoteA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const startedA = new Promise<void>((resolve) => {
    quoteAStarted = resolve;
  });
  const quoteBodies: Record<string, unknown>[] = [];
  const paid: Record<string, unknown>[] = [];
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "quote-race-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (path === "/api/auth/user/") return route.fulfill({ json: CREATOR });
      if (path === "/api/ai/creator-options/" && req.method() === "GET")
        return route.fulfill({ json: { cover: [], completion: choices } });
      if (path === "/api/ai/creator-options/" && req.method() === "POST") {
        const body = JSON.parse(req.postData() || "{}");
        quoteBodies.push(body);
        if (body.prompt === "prompt A") {
          quoteAStarted();
          await quoteA;
          return route.fulfill({
            json: {
              choice: choices[0],
              model: choices[0].id,
              requested_output_tokens: 256,
              max_output_tokens: 100,
              max_charge_2z: 11,
              quote_token: "token-A",
              availability: "A",
              queue: "A",
            },
          });
        }
        return route.fulfill({
          json: {
            choice: choices[1],
            model: choices[1].id,
            requested_output_tokens: 256,
            max_output_tokens: 128,
            max_charge_2z: 22,
            quote_token: "token-B",
            availability: "Ready B",
            queue: "Queued B",
          },
        });
      }
      if (path === "/api/ai/prompt/" && req.method() === "POST") {
        paid.push(JSON.parse(req.postData() || "{}"));
        return route.fulfill({
          json: {
            response: "B result",
            provider: "anthropic",
            model: "model-b",
            display_name: "Quote B",
            tuzis_charged: 3,
            input_tokens: 1,
            output_tokens: 1,
          },
        });
      }
      return route.fulfill({ json: {} });
    },
  );
  await page.goto("/edit");
  await expect(page.locator("textarea.writing-area-textarea")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByText("Draft with AI").click();
  const prompt = page.getByLabel("Prompt (sent to the selected provider)");
  const model = page.getByRole("combobox");
  await expect(model.locator('option[value="quote-b"]')).toHaveCount(1);
  await model.selectOption("quote-a");
  await prompt.fill("prompt A");
  const quoteButton = page.getByRole("button", {
    name: "Show price and destination",
  });
  await quoteButton.click();
  await startedA;
  await model.selectOption("quote-b");
  await prompt.fill("prompt B");
  await quoteButton.click();
  await expect(page.getByText(/Maximum charge: 22 2Z/)).toBeVisible();
  releaseA();
  await expect(page.getByText(/Maximum charge: 22 2Z/)).toBeVisible();
  await expect(
    page.getByText(/Your prompt will be sent to Anthropic/),
  ).toBeVisible();
  await expect(page.getByText(/Maximum charge: 11 2Z/)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Generate text (up to 22 2Z)" })
    .click();
  await expect(page.getByText("B result")).toBeVisible();
  expect(quoteBodies).toHaveLength(2);
  expect(paid).toEqual([
    {
      model: "quote-b",
      prompt: "prompt B",
      max_output_tokens: 256,
      quote_token: "token-B",
    },
  ]);
});

test("text quote refusal is visible and only an explicit retry can submit", async ({
  page,
}) => {
  test.setTimeout(120_000);
  let quotes = 0,
    paid = 0;
  const choice = {
    id: "retry-model",
    provider: "openai",
    display_name: "Retry model",
    destination: "OpenAI",
    privacy_policy_url: "https://openai.com/policies/privacy-policy/",
    availability: "Ready",
    queue: "Now",
  };
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "quote-error-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (path === "/api/auth/user/") return route.fulfill({ json: CREATOR });
      if (path === "/api/ai/creator-options/" && req.method() === "GET")
        return route.fulfill({ json: { cover: [], completion: [choice] } });
      if (path === "/api/ai/creator-options/" && req.method() === "POST") {
        if (quotes++ === 0)
          return route.fulfill({
            status: 409,
            json: { detail: "Model unavailable" },
          });
        return route.fulfill({
          json: {
            choice,
            model: choice.id,
            requested_output_tokens: 256,
            max_output_tokens: 256,
            max_charge_2z: 5,
            quote_token: "fresh-quote",
            availability: "Ready",
            queue: "Now",
          },
        });
      }
      if (path === "/api/ai/prompt/" && req.method() === "POST") {
        paid++;
        return route.fulfill({
          json: {
            response: "Recovered",
            provider: "openai",
            model: "m",
            display_name: "Retry model",
            tuzis_charged: 1,
            input_tokens: 1,
            output_tokens: 1,
          },
        });
      }
      return route.fulfill({ json: {} });
    },
  );
  await page.goto("/edit");
  await expect(page.locator("textarea.writing-area-textarea")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByText("Draft with AI").click();
  await page
    .getByLabel("Prompt (sent to the selected provider)")
    .fill("Only my explicit prompt");
  await page
    .getByRole("button", { name: "Show price and destination" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not price this prompt",
  );
  await expect(page.getByRole("button", { name: /Generate text/ })).toHaveCount(
    0,
  );
  expect(paid).toBe(0);
  await page
    .getByRole("button", { name: "Show price and destination" })
    .click();
  await expect(page.getByText(/Maximum charge: 5 2Z/)).toBeVisible();
  await page.getByRole("button", { name: /Generate text/ }).click();
  await expect(page.getByText("Recovered")).toBeVisible();
  expect(quotes).toBe(2);
  expect(paid).toBe(1);
});

test("draft edits invalidate a pending generated response", async ({
  page,
}) => {
  test.setTimeout(120_000);
  let release!: () => void, started!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const choice = {
    id: "pending",
    provider: "openai",
    display_name: "Pending",
    destination: "OpenAI",
    privacy_policy_url: "https://openai.com/policies/privacy-policy/",
    availability: "Ready",
    queue: "Now",
  };
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "pending-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (path === "/api/auth/user/") return route.fulfill({ json: CREATOR });
      if (path === "/api/ai/creator-options/" && req.method() === "GET")
        return route.fulfill({ json: { cover: [], completion: [choice] } });
      if (path === "/api/ai/creator-options/" && req.method() === "POST")
        return route.fulfill({
          json: {
            choice,
            model: choice.id,
            requested_output_tokens: 256,
            max_output_tokens: 256,
            max_charge_2z: 2,
            quote_token: "q",
            availability: "Ready",
            queue: "Now",
          },
        });
      if (path === "/api/ai/prompt/" && req.method() === "POST") {
        started();
        await responseGate;
        return route.fulfill({
          json: {
            response: "Stale output",
            provider: "openai",
            model: "m",
            display_name: "Pending",
            tuzis_charged: 1,
            input_tokens: 1,
            output_tokens: 1,
          },
        });
      }
      return route.fulfill({ json: {} });
    },
  );
  await page.goto("/edit");
  await expect(page.locator("textarea.writing-area-textarea")).toBeVisible({
    timeout: 30_000,
  });
  const editor = page.locator("textarea.writing-area-textarea");
  await editor.fill("Initial body");
  await page.getByText("Draft with AI").click();
  await page
    .getByLabel("Prompt (sent to the selected provider)")
    .fill("explicit input");
  await page
    .getByRole("button", { name: "Show price and destination" })
    .click();
  await page.getByRole("button", { name: /Generate text/ }).click();
  await requestStarted;
  await editor.fill("Edited while pending");
  await page.evaluate(async () => {
    const modulePath = "/src/lib/stores/auth.ts";
    const { authStore } = await import(/* @vite-ignore */ modulePath);
    authStore.updateCreator({
      id: 8105,
      username: "different-account",
      full_name: "Different Account",
    });
  });
  release();
  await expect(page.getByText("Stale output")).toHaveCount(0);
  await expect(editor).toHaveValue("Edited while pending");
  await expect(
    page.getByRole("button", { name: /Retry exact request/ }),
  ).toHaveCount(0);
});

test("empty catalogue has accessible retry and blocks paid submission", async ({
  page,
}) => {
  test.setTimeout(120_000);
  let loads = 0,
    paid = 0;
  const choice = {
    id: "available",
    provider: "openai",
    display_name: "Available",
    destination: "OpenAI",
    privacy_policy_url: "https://openai.com/policies/privacy-policy/",
    availability: "Ready",
    queue: "Now",
  };
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "empty-catalog",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (path === "/api/auth/user/") return route.fulfill({ json: CREATOR });
      if (path === "/api/ai/creator-options/" && req.method() === "GET") {
        loads++;
        return route.fulfill({
          json: { cover: [], completion: loads < 3 ? [] : [choice] },
        });
      }
      if (path === "/api/ai/creator-options/" && req.method() === "POST")
        return route.fulfill({
          json: {
            choice,
            model: choice.id,
            requested_output_tokens: 256,
            max_output_tokens: 256,
            max_charge_2z: 2,
            quote_token: "fresh",
            availability: "Ready",
            queue: "Now",
          },
        });
      if (path === "/api/ai/prompt/" && req.method() === "POST") {
        paid++;
        return route.fulfill({
          json: {
            response: "ok",
            provider: "openai",
            model: "m",
            display_name: "Available",
            tuzis_charged: 1,
            input_tokens: 1,
            output_tokens: 1,
          },
        });
      }
      return route.fulfill({ json: {} });
    },
  );
  await page.goto("/edit");
  await expect(page.locator("textarea.writing-area-textarea")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByText("Draft with AI").click();
  await expect(
    page.getByRole("status").filter({ hasText: "No text models" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Generate text/ })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Retry model list" }).click();
  await expect(
    page.getByRole("combobox").locator('option[value="available"]'),
  ).toHaveCount(1);
  await page
    .getByLabel("Prompt (sent to the selected provider)")
    .fill("explicit prompt");
  await page
    .getByRole("button", { name: "Show price and destination" })
    .click();
  await expect(page.getByText(/Maximum charge: 2 2Z/)).toBeVisible();
  await page.getByRole("button", { name: /Generate text/ }).click();
  await expect(page.getByText("ok", { exact: true })).toBeVisible();
  expect(loads).toBeGreaterThanOrEqual(2);
  expect(paid).toBe(1);
});

test("same-account auth epoch changes invalidate an in-flight completion", async ({
  page,
}) => {
  test.setTimeout(120_000);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const choice = {
    id: "auth-epoch",
    provider: "openai",
    display_name: "Auth model",
    destination: "OpenAI",
    privacy_policy_url: "https://openai.com/policies/privacy-policy/",
    availability: "Ready",
    queue: "Now",
  };
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "auth-epoch",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (path === "/api/auth/user/") return route.fulfill({ json: CREATOR });
      if (path === "/api/ai/creator-options/" && req.method() === "GET")
        return route.fulfill({ json: { cover: [], completion: [choice] } });
      if (path === "/api/ai/creator-options/" && req.method() === "POST")
        return route.fulfill({
          json: {
            choice,
            model: choice.id,
            requested_output_tokens: 256,
            max_output_tokens: 256,
            max_charge_2z: 2,
            quote_token: "auth-quote",
            availability: "Ready",
            queue: "Now",
          },
        });
      if (path === "/api/ai/prompt/" && req.method() === "POST") {
        started();
        await held;
        return route.fulfill({
          json: {
            response: "old session result",
            provider: "openai",
            model: "m",
            display_name: "Auth model",
            tuzis_charged: 1,
            input_tokens: 1,
            output_tokens: 1,
          },
        });
      }
      return route.fulfill({ json: {} });
    },
  );
  await page.goto("/edit");
  await expect(page.locator("textarea.writing-area-textarea")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByText("Draft with AI").click();
  await page
    .getByLabel("Prompt (sent to the selected provider)")
    .fill("account-owned prompt");
  await page
    .getByRole("button", { name: "Show price and destination" })
    .click();
  await page.getByRole("button", { name: /Generate text/ }).click();
  await began;
  await page.evaluate(async () => {
    const path = "/src/lib/stores/auth.ts";
    const { authStore } = await import(/* @vite-ignore */ path);
    authStore.clear();
    authStore.updateCreator({
      id: 8104,
      username: "ai-cover-user",
      full_name: "AI Cover User",
    });
  });
  release();
  await expect(page.getByText("old session result")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Generating/ })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Show price and destination" }),
  ).toBeEnabled();
});

test("cover generation discloses destination and price and gates explicit fallback", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const imageRequests: Array<Record<string, unknown>> = [];
  const imageRequestKeys: string[] = [];
  let options = OPTIONS;
  let generationFailuresRemaining = 2;

  await page.clock.install();

  await page.context().addCookies([
    {
      name: "sessionid",
      value: "creator-ai-cover-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
      } else if (pathname === "/api/ai/creator-options/") {
        await route.fulfill({ json: options });
      } else if (
        pathname === "/api/openai/image" &&
        request.method() === "POST"
      ) {
        imageRequests.push(JSON.parse(request.postData() || "{}"));
        imageRequestKeys.push(request.headers()["idempotency-key"] || "");
        if (generationFailuresRemaining > 0) {
          generationFailuresRemaining -= 1;
          await route.fulfill({ status: 503, json: { detail: "model busy" } });
        } else {
          await route.fulfill({
            json: {
              url: "/fixture/cover.webp",
              provider: "anthropic",
              model: "Image model B",
            },
          });
        }
      } else if (pathname === "/api/zpage/") {
        await route.fulfill({
          status: 201,
          json: {
            id: 1173,
            free2zaddr: "ai-cover-fixture",
            vanity: "ai-cover-fixture",
            title: "Cover fixture",
            content: "A saved draft body.",
            creator: CREATOR,
            is_published: false,
          },
        });
      } else {
        await route.fulfill({ json: { count: 0, results: [] } });
      }
    },
  );
  await page.route("**/fixture/cover.webp", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/webp",
      body: "fixture",
    });
  });

  await page.goto("/edit");
  await expect(page.locator("textarea.writing-area-textarea")).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: "Add or change the cover image" })
    .click();
  await page.getByRole("tab", { name: "AI" }).click();

  await expect(page.getByText("Free2Z charge: 6 2Z")).toBeVisible();
  await expect(page.getByText("Prompt sent to OpenAI")).toBeVisible();
  await expect(
    page.getByText("Processed synchronously; no queue position or SLA."),
  ).toBeVisible();
  await expect(
    page.getByText("Availability: Configured; checked again at submission."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Provider policy" }),
  ).toHaveAttribute("href", "https://openai.com/policies/privacy-policy/");
  const prompt = page.getByRole("textbox", {
    name: "Describe your cover image",
  });
  await prompt.fill("A calm green valley");
  const consent = page.getByRole("checkbox");
  const generate = page.getByRole("button", { name: "Generate Image" });
  await expect(generate).toBeDisabled();
  await consent.check();

  options = {
    ...OPTIONS,
    cover: OPTIONS.cover.map((choice) =>
      choice.id === "openai-image"
        ? {
            ...choice,
            model: "gpt-image-refreshed",
            display_name: "Image model refreshed",
            price_2z: 7,
            snapshot_token: "openai-snapshot-b",
          }
        : choice,
    ),
  };
  await page.clock.fastForward(60_000);
  await expect(page.getByText("Free2Z charge: 7 2Z")).toBeVisible();
  await expect(consent).not.toBeChecked();
  await expect(generate).toBeDisabled();
  await consent.check();
  await generate.click();
  await expect(page.getByRole("alert")).toContainText("model busy");
  expect(imageRequests[0].choice).toBe("openai-image");
  expect(imageRequests[0].prompt).toContain("A calm green valley");
  expect(imageRequests[0].choice_snapshot).toBe("openai-snapshot-b");
  await generate.click();
  await expect(page.getByRole("alert")).toContainText("model busy");
  expect(imageRequests[1]).toEqual(imageRequests[0]);
  expect(imageRequestKeys[1]).toBe(imageRequestKeys[0]);

  await prompt.fill("New unsent draft after the uncertain request");
  await page.evaluate(async (creator) => {
    const authModulePath = "/src/lib/stores/auth.ts";
    const { authStore } = await import(authModulePath);
    authStore.updateCreator({ ...creator, tuzis: "21.000" });
  }, CREATOR);
  await expect(prompt).toHaveValue(
    "New unsent draft after the uncertain request",
  );
  await prompt.fill("A calm green valley");

  const modelPicker = page.getByLabel("Image model");
  await modelPicker.selectOption("alternate-image");
  await expect(page.getByText("Prompt sent to Anthropic")).toBeVisible();
  await expect(page.getByText("Free2Z charge: 9 2Z")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Provider policy" }),
  ).toHaveAttribute("href", "https://www.anthropic.com/legal/privacy");
  await expect(consent).not.toBeChecked();
  await expect(generate).toBeDisabled();
  await consent.check();
  await generate.click();
  await expect(
    page.getByRole("img", { name: "Generated cover preview" }),
  ).toBeVisible();
  await expect(
    page.getByText("Generated with anthropic / Image model B"),
  ).toBeVisible();
  expect(imageRequests[1]).toEqual(imageRequests[0]);
  expect(imageRequests[2].choice).toBe("alternate-image");
  expect(imageRequests[2].prompt).toContain("A calm green valley");
  expect(imageRequests[2].choice_snapshot).toBe("anthropic-snapshot-a");
  expect(imageRequestKeys[2]).not.toBe(imageRequestKeys[0]);
  // A different account can claim a former username. It must not hydrate
  // that username's retained private prompt from this shared browser.
  await page.evaluate(async (creator) => {
    const authModulePath = "/src/lib/stores/auth.ts";
    const { authStore } = await import(authModulePath);
    authStore.updateCreator({ ...creator, id: 99991 });
  }, CREATOR);
  await expect(prompt).toHaveValue("");
});

test("unknown provider outcomes require an acknowledged fresh attempt", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const requestKeys: string[] = [];
  let attempts = 0;
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "creator-ai-cover-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
      } else if (pathname === "/api/ai/creator-options/") {
        await route.fulfill({ json: OPTIONS });
      } else if (
        pathname === "/api/openai/image" &&
        route.request().method() === "POST"
      ) {
        attempts += 1;
        requestKeys.push(route.request().headers()["idempotency-key"] || "");
        if (attempts === 1) {
          await route.fulfill({
            status: 409,
            json: {
              code: "provider_outcome_unknown",
              detail:
                "The original cover request may have reached its provider, so it was not sent again. Review your balance before starting a new request.",
            },
          });
        } else {
          await route.fulfill({
            json: {
              url: "/fixture/cover.webp",
              provider: "openai",
              model: "fixture",
            },
          });
        }
      } else {
        await route.fulfill({ json: { count: 0, results: [] } });
      }
    },
  );
  await page.route("**/fixture/cover.webp", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/webp",
      body: "fixture",
    });
  });

  await page.goto("/edit");
  await page.locator("textarea.writing-area-textarea").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: "Add or change the cover image" })
    .click();
  await page.getByRole("tab", { name: "AI" }).click();
  await page
    .getByRole("textbox", { name: "Describe your cover image" })
    .fill("A quiet forest");
  const consent = page.getByRole("checkbox");
  await consent.check();
  await page.getByRole("button", { name: "Generate Image" }).click();
  await expect(page.getByRole("alert")).toContainText("Review your balance");
  await page
    .getByRole("button", {
      name: "Allow a new paid attempt after reviewing my balance",
    })
    .click();
  await expect(consent).not.toBeChecked();
  await consent.check();
  await page.getByRole("button", { name: "Generate Image" }).click();
  await expect(
    page.getByRole("img", { name: "Generated cover preview" }),
  ).toBeVisible();
  expect(requestKeys).toHaveLength(2);
  expect(requestKeys[1]).not.toBe(requestKeys[0]);
});

test("a saved cover receipt remains recoverable after its model leaves the catalogue", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const requests: Array<Record<string, unknown>> = [];
  const keys: string[] = [];
  let options = OPTIONS;
  let firstAttempt = true;
  await page.clock.install();
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "creator-ai-cover-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
      } else if (pathname === "/api/ai/creator-options/") {
        await route.fulfill({ json: options });
      } else if (
        pathname === "/api/openai/image" &&
        request.method() === "POST"
      ) {
        requests.push(JSON.parse(request.postData() || "{}"));
        keys.push(request.headers()["idempotency-key"] || "");
        if (firstAttempt) {
          firstAttempt = false;
          await route.fulfill({ status: 503, json: { detail: "model busy" } });
        } else {
          await route.fulfill({
            json: {
              url: "/fixture/cover.webp",
              provider: "openai",
              model: "gpt-image-fixture",
            },
          });
        }
      } else {
        await route.fulfill({ json: { count: 0, results: [] } });
      }
    },
  );
  await page.route("**/fixture/cover.webp", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/webp",
      body: "fixture",
    });
  });

  await page.goto("/edit");
  await page.locator("textarea.writing-area-textarea").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: "Add or change the cover image" })
    .click();
  await page.getByRole("tab", { name: "AI" }).click();
  await page
    .getByRole("textbox", { name: "Describe your cover image" })
    .fill("A quiet mountain lake");
  const consent = page.getByRole("checkbox");
  await consent.check();
  await page.getByRole("button", { name: "Generate Image" }).click();
  await expect(page.getByRole("alert")).toContainText("model busy");

  const prompt = page.getByRole("textbox", {
    name: "Describe your cover image",
  });
  await prompt.fill("An edited prompt that should remain visible");
  await page.clock.fastForward(60_000);
  await expect(prompt).toHaveValue(
    "An edited prompt that should remain visible",
  );

  options = {
    ...OPTIONS,
    cover: [
      {
        ...OPTIONS.cover[0],
        model: "replacement-image-model",
        display_name: "Replacement image model",
        destination: "Replacement provider",
        privacy_policy_url: "https://example.com/replacement-policy",
        snapshot_token: "replacement-snapshot",
        price_2z: 99,
      },
    ],
  };
  await page.reload();
  await page.locator("textarea.writing-area-textarea").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: "Add or change the cover image" })
    .click();
  await page.getByRole("tab", { name: "AI" }).click();
  const disclosure = page.locator('div[aria-live="polite"].space-y-1');
  await expect(disclosure).toContainText("openai / gpt-image-fixture");
  await expect(disclosure).toContainText("Free2Z charge: 6 2Z");
  await expect(disclosure).not.toContainText("Replacement image model");

  options = { ...OPTIONS, cover: [] };
  await page.reload();
  await page.locator("textarea.writing-area-textarea").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: "Add or change the cover image" })
    .click();
  await page.getByRole("tab", { name: "AI" }).click();
  await expect(
    page.getByRole("textbox", { name: "Describe your cover image" }),
  ).toHaveValue("A quiet mountain lake");
  await expect(page.getByText("Free2Z charge: 6 2Z")).toBeVisible();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Generate Image" }).click();
  await expect(
    page.getByRole("img", { name: "Generated cover preview" }),
  ).toBeVisible();
  await expect(
    page.getByText("Generated with openai / gpt-image-fixture"),
  ).toBeVisible();
  expect(requests[1]).toEqual(requests[0]);
  expect(keys[1]).toBe(keys[0]);
});

test("a delayed refusal for the prior account preserves the current account recovery record", async ({
  page,
}) => {
  test.setTimeout(120_000);
  let releaseImageResponse!: () => void;
  let imageRequestStarted!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseImageResponse = resolve;
  });
  const requestStarted = new Promise<void>((resolve) => {
    imageRequestStarted = resolve;
  });
  await page.clock.install();
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "creator-ai-cover-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
      } else if (pathname === "/api/ai/creator-options/") {
        await route.fulfill({ json: OPTIONS });
      } else if (
        pathname === "/api/openai/image" &&
        request.method() === "POST"
      ) {
        imageRequestStarted();
        await responseGate;
        await route.fulfill({
          status: 409,
          json: { detail: "This image model is no longer available." },
        });
      } else {
        await route.fulfill({ json: { count: 0, results: [] } });
      }
    },
  );

  await page.goto("/edit");
  await page.locator("textarea.writing-area-textarea").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: "Add or change the cover image" })
    .click();
  await page.getByRole("tab", { name: "AI" }).click();
  await page
    .getByRole("textbox", { name: "Describe your cover image" })
    .fill("A request owned by the previous account");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Generate Image" }).click();
  await requestStarted;

  const nextActor = "ai-cover-user-b";
  const nextIntentKey = `f2z:creator-cover-intent:v1:${encodeURIComponent(nextActor)}`;
  const priorIntentKey = `f2z:creator-cover-intent:v1:${encodeURIComponent(CREATOR.username)}`;
  await page.evaluate(
    async ({ actor, key }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          actor,
          actorId: "8105",
          prompt: "B's unresolved cover",
          generationPrompt: "B's unresolved cover",
          choice: {
            id: "openai-image",
            provider: "openai",
            model: "gpt-image-fixture",
            display_name: "Image model A",
            destination: "OpenAI",
            privacy_policy_url: "https://openai.com/policies/privacy-policy/",
            snapshot_token: "openai-snapshot-a",
            price_basis: "fixed",
            price_2z: 6,
            availability: "Configured; checked again at submission.",
            queue: "Processed synchronously; no queue position or SLA.",
          },
          choiceSnapshot: "b-original-snapshot",
        }),
      );
      const authModulePath = "/src/lib/stores/auth.ts";
      const { authStore } = await import(authModulePath);
      authStore.updateCreator({
        id: 8105,
        username: actor,
        full_name: "User B",
      });
    },
    { actor: nextActor, key: nextIntentKey },
  );
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const authModulePath = "/src/lib/stores/auth.ts";
        const { currentUser } = await import(authModulePath);
        let username = "";
        const unsubscribe = currentUser.subscribe((creator: any) => {
          username = creator?.username ?? "";
        });
        unsubscribe();
        return username;
      }),
    )
    .toBe(nextActor);

  releaseImageResponse();
  await expect
    .poll(() =>
      page.evaluate((key) => localStorage.getItem(key), priorIntentKey),
    )
    .toBeNull();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), nextIntentKey),
  ).not.toBeNull();
});

test("cover submissions from two tabs reuse the paid key while the first request is pending", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const requests: Array<{ body: Record<string, unknown>; key: string }> = [];
  let releaseFirstRequest!: () => void;
  const firstRequestGate = new Promise<void>((resolve) => {
    releaseFirstRequest = resolve;
  });
  await page.clock.install();
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "creator-ai-cover-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.context().route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
      } else if (pathname === "/api/ai/creator-options/") {
        await route.fulfill({ json: OPTIONS });
      } else if (
        pathname === "/api/openai/image" &&
        request.method() === "POST"
      ) {
        requests.push({
          body: JSON.parse(request.postData() || "{}"),
          key: request.headers()["idempotency-key"] || "",
        });
        if (requests.length === 1) await firstRequestGate;
        else if (requests.length === 2) {
          await route.fulfill({
            status: 409,
            json: {
              code: "request_in_progress",
              detail: "Original request is still pending",
            },
          });
          return;
        }
        await route.fulfill({
          json: {
            url: "/fixture/cover.webp",
            provider: "openai",
            model: "gpt-image-fixture",
          },
        });
      } else {
        await route.fulfill({ json: { count: 0, results: [] } });
      }
    },
  );
  await page.context().route("**/fixture/cover.webp", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/webp",
      body: "fixture",
    });
  });

  await page.goto("/edit");
  await page.locator("textarea.writing-area-textarea").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: "Add or change the cover image" })
    .click();
  await page.getByRole("tab", { name: "AI" }).click();
  await page
    .getByRole("textbox", { name: "Describe your cover image" })
    .fill("The same request from two tabs");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Generate Image" }).click();
  await expect.poll(() => requests.length).toBe(1);

  const secondTab = await page.context().newPage();
  secondTab.on("pageerror", (error) => pageErrors.push(error.message));
  await secondTab.clock.install();
  await secondTab.goto("/edit");
  await secondTab.locator("textarea.writing-area-textarea").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await secondTab
    .getByRole("button", { name: "Add or change the cover image" })
    .click();
  await secondTab.getByRole("tab", { name: "AI" }).click();
  await expect(
    secondTab.getByRole("textbox", { name: "Describe your cover image" }),
  ).toHaveValue("The same request from two tabs");
  await secondTab.getByRole("checkbox").check();
  await secondTab.getByRole("button", { name: "Generate Image" }).click();
  await expect.poll(() => requests.length).toBe(2);

  await expect(
    secondTab.getByText("Original request is still pending"),
  ).toBeVisible();
  const savedRequest = await secondTab.evaluate(() =>
    JSON.parse(
      localStorage.getItem("f2z:creator-cover-intent:v1:ai-cover-user")!,
    ),
  );
  releaseFirstRequest();
  await expect(
    page.getByRole("img", { name: "Generated cover preview" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("f2z:creator-cover-intent:v1:ai-cover-user"),
      ),
    )
    .toBeNull();
  const newerSavedRequest = {
    ...savedRequest,
    key: "66666666-6666-4666-8666-666666666666",
  };
  await secondTab.evaluate(
    (saved) =>
      localStorage.setItem(
        "f2z:creator-cover-intent:v1:ai-cover-user",
        JSON.stringify(saved),
      ),
    newerSavedRequest,
  );
  await secondTab.clock.runFor(60_001);
  await secondTab.getByRole("button", { name: "Generate Image" }).click();
  await expect.poll(() => requests.length).toBe(3);
  await expect(
    secondTab.getByRole("img", { name: "Generated cover preview" }),
  ).toBeVisible();
  expect(requests[1].key).toBe(requests[0].key);
  expect(requests[1].body).toEqual(requests[0].body);
  expect(requests[2]).toEqual(requests[0]);
  expect(pageErrors).toEqual([]);
  await expect
    .poll(() =>
      secondTab.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem("f2z:creator-cover-intent:v1:ai-cover-user")!,
          ).key,
      ),
    )
    .toBe(newerSavedRequest.key);
});

for (const adoptSavedTerms of [false, true]) {
  test(`fal moderation ends the paid intent and requires fresh consent (changed saved terms: ${adoptSavedTerms})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const fal = {
      ...OPTIONS.cover[0],
      id: "fal-flux-schnell",
      provider: "fal",
      model: "fal-ai/flux/schnell",
      display_name: "FLUX.1 [schnell]",
      destination: "fal",
      privacy_policy_url: "https://fal.ai/legal/privacy-policy",
      snapshot_token: "fal-snapshot-a",
    };
    const requests: Array<{ key: string; body: Record<string, unknown> }> = [];
    await page.context().addCookies([
      {
        name: "sessionid",
        value: "creator-ai-cover-session",
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    await page.route(
      (url) => url.pathname.startsWith("/api/"),
      async (route) => {
        const request = route.request();
        const { pathname } = new URL(request.url());
        if (pathname === "/api/auth/user/")
          await route.fulfill({ json: CREATOR });
        else if (pathname === "/api/ai/creator-options/")
          await route.fulfill({ json: { cover: [fal], completion: [] } });
        else if (
          pathname === "/api/openai/image" &&
          request.method() === "POST"
        ) {
          requests.push({
            key: request.headers()["idempotency-key"] || "",
            body: request.postDataJSON(),
          });
          await route.fulfill({
            status: 400,
            json: {
              code: "moderation_blocked",
              key_resolved: true,
              detail:
                "Your prompt was rejected by the provider's safety system.",
            },
          });
        } else await route.fulfill({ json: { count: 0, results: [] } });
      },
    );
    await page.goto("/edit");
    await page
      .locator("textarea.writing-area-textarea")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page
      .getByRole("button", { name: "Add or change the cover image" })
      .click();
    await page.getByRole("tab", { name: "AI" }).click();
    await page
      .getByRole("textbox", { name: "Describe your cover image" })
      .fill("A quiet mountain lake");
    await expect(
      page.getByRole("link", { name: "Provider policy", exact: true }),
    ).toHaveAttribute("href", fal.privacy_policy_url);
    await page.getByRole("checkbox").check();
    if (adoptSavedTerms) {
      await page.evaluate(
        ({ actor, choice }) => {
          localStorage.setItem(
            `f2z:creator-cover-intent:v1:${encodeURIComponent(actor)}`,
            JSON.stringify({
              actor,
              actorId: "8104",
              key: "77777777-7777-4777-8777-777777777777",
              prompt: "A quiet mountain lake",
              generationPrompt: "Original accepted prompt",
              choice: {
                ...choice,
                price_2z: 9,
                snapshot_token: "fal-original-higher-price",
              },
              choiceSnapshot: "fal-original-higher-price",
            }),
          );
        },
        { actor: CREATOR.username, choice: fal },
      );
      await page.getByRole("button", { name: "Generate Image" }).click();
      await expect(
        page.getByText(
          "The saved request has different provider or pricing terms. Review them and agree before retrying.",
        ),
      ).toBeVisible();
      await expect(page.getByRole("checkbox")).not.toBeChecked();
      await expect(page.getByText("Free2Z charge: 9 2Z")).toBeVisible();
      expect(requests).toHaveLength(0);
      await page.getByRole("checkbox").check();
    }
    await page.getByRole("button", { name: "Generate Image" }).click();
    await expect(
      page.getByText(
        "Your prompt was rejected by the provider's safety system.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("checkbox")).not.toBeChecked();
    await expect(
      page.getByRole("button", { name: "Generate Image" }),
    ).toBeDisabled();
    expect(requests).toHaveLength(1);
    expect(requests[0].body.choice).toBe(fal.id);
    expect(requests[0].body.choice_snapshot).toBe(
      adoptSavedTerms ? "fal-original-higher-price" : fal.snapshot_token,
    );
    await expect
      .poll(() =>
        page.evaluate(
          (actor) =>
            localStorage.getItem(
              `f2z:creator-cover-intent:v1:${encodeURIComponent(actor)}`,
            ),
          CREATOR.username,
        ),
      )
      .toBeNull();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Generate Image" }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].key).not.toBe(requests[0].key);
  });
}
