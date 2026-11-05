import { expect, test } from "@playwright/test";
import { fork, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { browserMockApiOrigin } from "./ports";

test.skip(
  process.env.PLAYWRIGHT_PRODUCTION !== "1",
  "requires built application",
);
function message(child: ChildProcess, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: any) => {
      if (value?.type === type) {
        child.off("exit", onExit);
        child.off("message", onMessage);
        resolve(value);
      }
    };
    const onExit = () =>
      reject(new Error(`policy server exited before ${type}`));
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  if (child.connected) child.send({ type: "stop" });
  else child.kill("SIGTERM");
  await exited;
}

test("new server policy wins over a pending locale switch on client navigation", async ({
  page,
}) => {
  const child = fork("tests/browser/locale-policy-server.mjs", [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: {
      ...process.env,
      PRIVATE_DISABLED_UI_LOCALES: "",
      PRIVATE_API_BASE_URL: browserMockApiOrigin(),
      PUBLIC_API_BASE_URL: "",
    },
  });
  try {
    const ready = await message(child, "ready");
    const origin: string = ready.origin;
    const manifest = JSON.parse(
      readFileSync(".svelte-kit/output/client/.vite/manifest.json", "utf8"),
    );
    const esChunk = manifest["src/lib/locales/rtk/es.json"].file;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.route(`**/${esChunk}`, async (route) => {
      started();
      await gate;
      await route.continue();
    });
    await page.goto(`${origin}/trending?lang=fr`);
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await page.getByRole("button", { name: /^Langue:/ }).click();
    await page.getByText("Español", { exact: true }).click();
    await requested;
    const ack = message(child, "policy-applied");
    child.send({ type: "policy", disabled: "fr,es" });
    await ack;
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.id = "policy-nav";
      link.href = "/trending?lang=en";
      link.textContent = "Continue";
      document.body.append(link);
      (window as any).__policyDocument = true;
    });
    const dataResponse = page.waitForResponse(
      (response) =>
        response.url().includes("__data.json") &&
        response.url().includes("lang=en"),
    );
    await page.locator("#policy-nav").click();
    const response = await dataResponse;
    expect(response.headers()["cache-control"]).toMatch(/private/i);
    expect(response.headers()["vary"]).toMatch(/cookie/i);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByText("Help center").first()).toBeVisible();
    expect(await page.evaluate(() => (window as any).__policyDocument)).toBe(
      true,
    );
    release();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(await page.evaluate(() => document.cookie)).not.toContain(
      "free2z-locale=es",
    );
  } finally {
    await stop(child);
  }
});

test("newer policy navigation prevents an older French response from committing", async ({
  page,
}) => {
  const child = fork("tests/browser/locale-policy-server.mjs", [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: {
      ...process.env,
      PRIVATE_DISABLED_UI_LOCALES: "",
      PRIVATE_API_BASE_URL: browserMockApiOrigin(),
      PUBLIC_API_BASE_URL: "",
    },
  });
  try {
    const { origin } = await message(child, "ready");
    await page.goto(`${origin}/trending?lang=en`);
    await expect
      .poll(async () => {
        const menu = page.getByRole("button", { name: /^Language:/ });
        await menu.click();
        return page.getByText("Français", { exact: true }).isVisible();
      })
      .toBe(true);
    await page.keyboard.press("Escape");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.route("**/trending/__data.json*", async (route) => {
      if (!route.request().url().includes("lang=fr")) return route.continue();
      const old = await route.fetch();
      started();
      await gate;
      try {
        await route.fulfill({ response: old });
      } catch {
        /* a superseded navigation may already be cancelled */
      }
    });
    await page.evaluate(() => {
      for (const [id, locale] of [
        ["old-fr", "fr"],
        ["new-es", "es"],
      ]) {
        const a = document.createElement("a");
        a.id = id;
        a.href = `/trending?lang=${locale}`;
        a.textContent = id;
        document.body.append(a);
      }
    });
    await page.locator("#old-fr").click({ noWaitAfter: true });
    await requested;
    const ack = message(child, "policy-applied");
    child.send({ type: "policy", disabled: "fr" });
    await ack;
    await page.locator("#new-es").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(page.getByText("Centro de ayuda").first()).toBeVisible();
    release();
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    expect(await page.evaluate(() => document.cookie)).not.toContain(
      "free2z-locale=fr",
    );
  } finally {
    await stop(child);
  }
});
