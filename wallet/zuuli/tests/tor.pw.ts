import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
for (const [locale, title, advanced, unavailable] of [
  ["en", "Tor for wallet connections", "Advanced diagnostics", "Available only in the native app"],
  ["es", "Tor para conexiones de la cartera", "Diagnóstico avanzado", "Solo disponible en la aplicación nativa"],
  ["fr", "Tor pour les connexions du portefeuille", "Diagnostic avancé", "Disponible uniquement dans l’application native"],
]) {
  test(`Tor scope and unsupported browser boundary · ${locale}`, async ({ page }) => {
    await page.addInitScript((locale) => localStorage.setItem("free2z-locale", locale), locale);
    await page.goto("/about");
    const section = page.locator('section[aria-labelledby="tor-title"]');
    await expect(section.getByRole("heading", { name: title })).toBeVisible();
    await expect(section.getByRole("status")).toHaveText(unavailable);
    await expect(section.getByRole("button")).toBeDisabled();
    await section.getByText(advanced, { exact: true }).click();
    await expect(section.getByText(/127\.0\.0\.1:9050/)).toBeVisible();
    await expect(section.getByText(/Android.*iOS/)).toBeVisible();
    await page.setViewportSize({ width: 360, height: 780 });
    expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}

test("native command fixture: opt-in, degraded, lifecycle pause, reconnect and disable", async ({ page }) => {
  await page.addInitScript(() => {
    const fixture = { enabled:false, suspended:false, epoch:0, state:"direct" };
    Object.assign(window, { fixtureTorState: fixture });
    let callbackId = 0;
    Object.assign(window, { __TAURI_INTERNALS__: {
      transformCallback: () => ++callbackId,
      unregisterCallback: () => {},
      invoke: async (command: string, args: {enabled?: boolean} = {}) => {
        if (command === "tor_status") return {...fixture};
        if (command === "tor_set") {
          Object.assign(fixture,{enabled:args.enabled,suspended:false,epoch:fixture.epoch+1,state:args.enabled ? "waiting" : "direct"});
          return {...fixture};
        }
        if (command === "tor_suspend" && fixture.enabled) Object.assign(fixture,{suspended:true,epoch:fixture.epoch+1,state:"suspended"});
        return null;
      },
    }});
  });
  await page.goto("/about");
  const card = page.locator('section[aria-labelledby="tor-title"]');
  await expect(card.getByRole("status")).toHaveText("Direct connection");
  await card.getByRole("button",{name:"Enable Tor",exact:true}).click();
  await expect(card.getByRole("status")).toHaveText("Waiting for a wallet request through the proxy");
  await page.evaluate(() => { (window as unknown as {fixtureTorState:{state:string}}).fixtureTorState.state="degraded"; });
  await expect(card.getByRole("status")).toHaveText("Proxy unavailable · no direct fallback");
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(card.getByRole("status")).toHaveText("Connections paused · reconnect to continue");
  await card.getByRole("button",{name:"Reconnect",exact:true}).click();
  await expect(card.getByRole("status")).toHaveText("Waiting for a wallet request through the proxy");
  await card.getByRole("button",{name:"Disable Tor",exact:true}).click();
  await expect(card.getByRole("status")).toHaveText("Direct connection");
});


test("packaged CSP refuses remote fetch before dispatch, with a live allowed negative control", async ({ page }) => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  let requests=0;
  const url="https://free2z.cash/api/__tor_local_fixture__/";
  await page.route(url, async route => { requests++; await route.fulfill({status:200,body:"fixture",headers:{"access-control-allow-origin":"*"}}); });
  await page.goto("/about");
  await page.setContent(`<meta http-equiv="Content-Security-Policy" content="${config.app.security.csp}"><body>fixture</body>`);
  expect(await page.evaluate(async url => { try { await fetch(url); return "dispatched"; } catch { return "refused"; } },url)).toBe("refused");
  expect(requests).toBe(0);
  // Fresh document: the previous remote-connect allowance dispatches the same
  // controlled request. Both runs are local fixtures, never production I/O.
  await page.goto("/about");
  await page.setContent(`<meta http-equiv="Content-Security-Policy" content="connect-src https://free2z.cash"><body>fixture</body>`);
  expect(await page.evaluate(async url => (await fetch(url)).text(),url)).toBe("fixture");
  expect(requests).toBe(1);
});

test("negative control: exact shipping CSP alone still dispatches HTTPS top-level navigation", async ({ page }) => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const target = "https://navigation.fixture.test/leak";
  let dispatched = 0;
  await page.route(target, async route => {
    dispatched++;
    await route.fulfill({ status: 200, contentType: "text/html", body: "controlled navigation fixture" });
  });
  await page.goto("/about");
  await page.setContent(`<meta http-equiv="Content-Security-Policy" content="${config.app.security.csp}"><body>local</body>`);
  await page.evaluate(url => location.assign(url), target);
  await expect(page).toHaveURL(target);
  expect(dispatched).toBe(1);
  await expect(page.getByText("controlled navigation fixture")).toBeVisible();
  // This is deliberately the unguarded Chromium negative control. The actual
  // native factory is exercised with live DNS/TCP counters by navigation_probe.
});

test("direct form submission is refused, with the previous CSP as a dispatch control", async ({ page }) => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const target="https://navigation.fixture.test/form";
  let dispatched=0;
  await page.route(target,async route=>{dispatched++;await route.fulfill({status:200,contentType:"text/html",body:"form dispatch control"});});
  await page.goto("/about");
  await page.setContent(`<meta http-equiv="Content-Security-Policy" content="${config.app.security.csp}"><body></body>`);
  expect(await page.evaluate(url=>new Promise<string>(resolve=>{
    document.addEventListener("securitypolicyviolation",event=>{if(event.violatedDirective==="form-action")resolve("refused");});
    const form=document.createElement("form");form.method="POST";form.action=url;document.body.append(form);form.submit();
  }),target)).toBe("refused");
  expect(dispatched).toBe(0);
  await page.goto("/about");
  await page.setContent(`<meta http-equiv="Content-Security-Policy" content="${config.app.security.csp.replace("form-action 'none';","")}"><body></body>`);
  await page.evaluate(url=>{const form=document.createElement("form");form.method="POST";form.action=url;document.body.append(form);form.submit();},target);
  await expect(page).toHaveURL(target);
  expect(dispatched).toBe(1);
});
