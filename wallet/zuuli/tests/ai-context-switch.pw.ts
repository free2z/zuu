import { expect, test, type Page } from "@playwright/test";

async function openSignedInAi(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
  });
  await page.goto("/ai");
  await expect(
    page.getByRole("button", { name: "Select AI model" }),
  ).toContainText("GPT-4o");
}

async function sendMessage(page: Page, message: string) {
  await page.getByRole("textbox", { name: "Message" }).fill(message);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByText(/Here's a reply in character/).last()).toBeVisible();
}

async function chooseModel(page: Page, name: string) {
  await page.getByRole("button", { name: "Select AI model" }).click();
  const option = page.getByRole("menuitem", { name: new RegExp(name) });
  // Focus exercises the keyboard-select path even when a long menu places the
  // requested mock model outside Playwright's compact default viewport.
  await option.focus();
  await option.press("Enter");
}

test("model and personality switches start honest, separate chat threads", async ({
  page,
}) => {
  await openSignedInAi(page);
  await sendMessage(page, "Context only the first model received");

  await chooseModel(page, "Claude Haiku 4.5");
  const dialog = page.getByRole("dialog", { name: "Start a new chat?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "The current transcript will be cleared because the new conversation cannot see it.",
  );
  await expect(dialog).toContainText("Claude Haiku 4.5");
  await expect(
    page.getByText("Context only the first model received", { exact: true }),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Select AI model" }),
  ).toContainText("GPT-4o");
  await expect(
    page.getByText("Context only the first model received", { exact: true }),
  ).toBeVisible();

  await chooseModel(page, "Claude Haiku 4.5");
  await dialog.getByRole("button", { name: "Start new chat" }).click();
  await expect(
    page.getByRole("button", { name: "Select AI model" }),
  ).toContainText("Claude Haiku 4.5");
  await expect(
    page.getByText("Context only the first model received", { exact: true }),
  ).toHaveCount(0);

  await sendMessage(page, "Context only Claude received");
  await expect(page.getByText(/Claude Haiku 4\.5/).last()).toBeVisible();

  await page.getByRole("button", { name: "Select AI personality" }).click();
  await page.getByRole("menuitem", { name: /ZK Tutor/ }).click();
  await expect(dialog).toContainText("Claude Haiku 4.5");
  await expect(dialog).toContainText("ZK Tutor");
  await dialog.getByRole("button", { name: "Start new chat" }).click();
  await expect(
    page.getByRole("button", { name: "Select AI personality" }),
  ).toContainText("ZK Tutor");
  await expect(
    page.getByText("Context only Claude received", { exact: true }),
  ).toHaveCount(0);

  await sendMessage(page, "Context only the tutor received");
  await expect(page.getByText(/primed as “ZK Tutor”/).last()).toBeVisible();
});

test("an empty chat switches immediately without a destructive confirmation", async ({
  page,
}) => {
  await openSignedInAi(page);
  await chooseModel(page, "Claude Sonnet 5");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Select AI model" }),
  ).toContainText("Claude Sonnet 5");
});
