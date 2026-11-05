import { expect, test } from "@playwright/test";
import { browserAppOrigin } from "./ports";

test("production translator renders ICU and pagination on locale switch", async ({
  page,
}) => {
  await page.goto("about:blank");
  for (const path of [
    "/tests/browser/icu-fixture.svelte",
    "/tests/browser/svelte-mount.ts",
  ]) {
    expect(
      (
        await page.request.get(new URL(path, browserAppOrigin()).toString())
      ).ok(),
    ).toBeTruthy();
  }
  await page.goto("/search");
  await page.evaluate(async () => {
    const root = document.createElement("main");
    document.body.append(root);
    const path = "/tests/browser/icu-fixture.svelte";
    const mountPath = "/tests/browser/svelte-mount.ts";
    const fixture = await import(/* @vite-ignore */ path);
    const { mount } = await import(/* @vite-ignore */ mountPath);
    mount(fixture.default, { target: root });
  });
  await page
    .getByRole("button", { name: "English", exact: true })
    .last()
    .click();
  await expect(page.getByTestId("icu")).toHaveText("Ada has 2 · 2nd · yes");
  await expect(page.getByTestId("pagination")).toHaveText("Page 2 of 4");
  await page
    .getByRole("button", { name: "Français", exact: true })
    .last()
    .click();
  await expect(page.getByTestId("icu")).toHaveText("Ada a 2 · 2e · oui");
  await expect(page.getByTestId("pagination")).toHaveText("Page 2 sur 4");
});
