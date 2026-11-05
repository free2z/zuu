import { expect, test } from "@playwright/test";
test("RTK translator uses prepared active pack after locale switches", async ({
  page,
}) => {
  await page.goto("/healthz");
  await page.evaluate(async () => {
    const root = document.createElement("main");
    document.body.append(root);
    const p = "/tests/browser/rtk-locale-fixture.svelte";
    const m = "/tests/browser/svelte-mount.ts";
    const fixture = await import(/* @vite-ignore */ p);
    const { mount } = await import(/* @vite-ignore */ m);
    mount(fixture.default, { target: root });
  });
  await page.getByRole("button", { name: "French RTK" }).click();
  await expect(page.getByTestId("rtk-leave")).toHaveText("Quitter");
  await page.getByRole("button", { name: "Spanish RTK" }).click();
  await expect(page.getByTestId("rtk-leave")).toHaveText("Salir");
});
