/* eslint testing-library/prefer-screen-queries: off -- Playwright uses page locators, not Testing Library. */
import { expect, test, type Page } from "@playwright/test";

const openai = {
  id: "text-a",
  provider: "openai",
  model: "gpt-fixture-a",
  display_name: "GPT Fixture A",
  destination: "OpenAI",
  privacy_policy_url: "https://openai.com/policies/privacy-policy/",
  availability: "Configured; checked again at submission.",
  queue: "Processed synchronously; no queue position or SLA.",
};
const anthropic = {
  ...openai,
  id: "text-b",
  provider: "anthropic",
  model: "claude-fixture-b",
  display_name: "Claude Fixture B",
  destination: "Anthropic",
  privacy_policy_url: "https://www.anthropic.com/legal/privacy",
};
const draft = "Existing private draft.";

async function mockEditor(page: Page) {
  const state = {
    choices: [openai, anthropic],
    quoteFails: false,
    catalogueReads: 0,
    submissions: [] as {
      body: Record<string, unknown>;
      key: string;
      actor: string;
    }[],
    unexpectedWrites: [] as string[],
  };
  // Only the local built application and mocked API are reachable.
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort()
  );
  await page.routeWebSocket("**/*", (socket) => socket.close());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/auth/user/") {
      return json({
        id: 8104,
        username: "text-ai-user",
        full_name: "Text AI User",
        tuzis: "1000",
        stars: [],
        star_ids: [],
        fans: [],
        avatar_image: null,
        member_price: "1",
        zpages: 0,
      });
    }
    if (path === "/api/ai/creator-options/") {
      if (request.method() === "GET") {
        state.catalogueReads++;
        return json({ cover: [], completion: state.choices });
      }
      if (state.quoteFails) return json({ detail: "Quote unavailable" }, 503);
      const body = request.postDataJSON();
      const choice = state.choices.find((item) => item.id === body.model);
      if (!choice) return json({ detail: "Model unavailable" }, 400);
      return json({
        choice,
        model: choice.id,
        max_output_tokens: 4096,
        requested_output_tokens: 4096,
        max_charge_2z: choice.id === openai.id ? 7 : 12,
        quote_token: `quote-${choice.id}`,
        availability: choice.availability,
        queue: choice.queue,
      });
    }
    if (path === "/api/ai/prompt/" && request.method() === "POST") {
      const body = request.postDataJSON();
      state.submissions.push({
        body,
        key: request.headers()["idempotency-key"],
        actor: request.headers()["x-expected-actor"],
      });
      if (body.model === openai.id) return json({ detail: "Model busy" }, 503);
      return json({
        response: "A concise completion.",
        ...anthropic,
        tuzis_charged: 9,
      });
    }
    if (request.method() !== "GET") {
      state.unexpectedWrites.push(`${request.method()} ${path}`);
      return json({ detail: "Unexpected test request" }, 500);
    }
    if (path === "/api/events/has/") return json(false);
    if (path === "/api/events/unread_count/") return json(0);
    return json({ count: 0, results: [] });
  });
  return state;
}

async function openTextDialog(page: Page) {
  await page.goto("/edit/new");
  const editor = page.locator("textarea.w-md-editor-text-input");
  await editor.fill(draft);
  await editor.press("Home");
  await editor.press("Shift+End");
  await page.locator('button[title="AI (ctrl + a)"]').click();
  await expect(
    page.getByRole("dialog").getByLabel("Prompt", { exact: true })
  ).toHaveValue(draft);
  return editor;
}

test("text disclosure precedes submission and cross-provider fallback needs explicit consent", async ({
  page,
}) => {
  const state = await mockEditor(page);
  const editor = await openTextDialog(page);
  const dialog = page.getByRole("dialog");
  const submit = dialog.getByRole("button", {
    name: "Get AI Text",
    exact: true,
  });
  await expect(
    dialog.getByText(
      "Free2Z AI · Prompt sent to OpenAI · openai / gpt-fixture-a"
    )
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "Maximum hold: 7 2Z; final charge may be lower and is shown after generation."
    )
  ).toBeVisible();
  await expect(
    dialog.getByText(`Availability: ${openai.availability}`)
  ).toBeVisible();
  await expect(dialog.getByText(openai.queue)).toBeVisible();
  await expect(
    dialog.getByText(/Provider retention follows its published policy/)
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Provider privacy policy" })
  ).toHaveAttribute("href", openai.privacy_policy_url);
  await expect(
    dialog.getByRole("link", { name: "Free2Z privacy policy" })
  ).toHaveAttribute("href", "/docs/legal/privacy-policy/");
  await expect(submit).toBeDisabled();
  expect(state.submissions).toEqual([]);
  await dialog
    .getByRole("checkbox", { name: /I agree to send this prompt to OpenAI/ })
    .check();
  await submit.click();
  await expect(
    page.getByText(
      "Text generation failed. The selected model was not changed; review its availability and retry or choose another model."
    )
  ).toBeVisible();
  const retry = dialog.getByRole("button", { name: "Retry original request" });
  await expect(retry).toBeEnabled();
  expect(state.submissions).toHaveLength(1);
  expect(state.submissions[0]).toMatchObject({
    body: {
      model: "text-a",
      prompt: draft,
      max_output_tokens: 4096,
      quote_token: "quote-text-a",
    },
    actor: "8104",
  });
  expect(state.submissions[0].key).toBeTruthy();
  await retry.click();
  await expect(retry).toBeEnabled();
  expect(state.submissions).toHaveLength(2);
  expect(state.submissions[1]).toEqual(state.submissions[0]);

  // Native keyboard interaction with the actual MUI model selector.
  await dialog.getByRole("combobox", { name: "Text model" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(
    dialog.getByText(
      "Free2Z AI · Prompt sent to Anthropic · anthropic / claude-fixture-b"
    )
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "Maximum hold: 12 2Z; final charge may be lower and is shown after generation."
    )
  ).toBeVisible();
  const consent = dialog.getByRole("checkbox", {
    name: /I agree to send this prompt to Anthropic/,
  });
  await expect(consent).not.toBeChecked();
  await expect(submit).toBeDisabled();
  await expect(
    dialog.getByRole("link", { name: "Provider privacy policy" })
  ).toHaveAttribute("href", anthropic.privacy_policy_url);
  expect(state.submissions).toHaveLength(2);
  await consent.focus();
  await page.keyboard.press("Space");
  await submit.click();
  await expect(dialog).toHaveCount(0);
  expect(state.submissions).toHaveLength(3);
  expect(state.submissions[2]).toMatchObject({
    body: { model: "text-b", prompt: draft, quote_token: "quote-text-b" },
    actor: "8104",
  });
  expect(state.submissions[2].key).not.toBe(state.submissions[0].key);
  await expect(editor).toHaveValue("A concise completion.");
  await expect(
    page.getByText(
      "Free2Z AI · Claude Fixture B (anthropic / claude-fixture-b) · charged 9 2Z"
    )
  ).toBeVisible();
  expect(state.unexpectedWrites).toEqual([]);
});

test("catalogue refresh removes the selected model without silently choosing a replacement", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockEditor(page);
  await openTextDialog(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Maximum hold: 7 2Z/)).toBeVisible();
  await dialog.getByRole("checkbox").check();
  const reads = state.catalogueReads;
  state.choices = [anthropic];
  await page.clock.fastForward(60_000);
  await expect.poll(() => state.catalogueReads).toBeGreaterThan(reads);
  await expect(
    dialog.getByText(
      "The previous model is no longer available. Select another model to continue."
    )
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Get AI Text" })
  ).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Text model" }).click();
  await expect(page.getByRole("option", { name: /GPT Fixture A/ })).toHaveCount(
    0
  );
  await page
    .getByRole("option", { name: "Claude Fixture B · anthropic" })
    .click();
  await expect(dialog.getByText(/Maximum hold: 12 2Z/)).toBeVisible();
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Get AI Text" })
  ).toBeDisabled();
  expect(state.submissions).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("unavailable catalogue and failed price quote prevent prompt submission", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockEditor(page);
  state.choices = [];
  await openTextDialog(page);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(
      "No text models are currently available. No prompt was sent."
    )
  ).toBeVisible();
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Get AI Text" })
  ).toBeDisabled();
  state.choices = [openai];
  state.quoteFails = true;
  await page.clock.fastForward(60_000);
  await dialog.getByRole("combobox", { name: "Text model" }).click();
  await page.getByRole("option", { name: "GPT Fixture A · openai" }).click();
  await expect(
    dialog.getByText(
      "Could not price this prompt for the selected model. No prompt was sent."
    )
  ).toBeVisible();
  await dialog.getByRole("checkbox").check();
  await expect(
    dialog.getByRole("button", { name: "Get AI Text" })
  ).toBeDisabled();
  expect(state.submissions).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});
