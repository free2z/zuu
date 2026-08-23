import { expect, test } from "@playwright/test";

test("first-party Rust WASM is instantiated and called by the browser", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-wasm-spike", "42");
});
