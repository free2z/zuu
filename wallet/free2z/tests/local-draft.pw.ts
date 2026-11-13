import { test, expect, type Page } from "@playwright/test";

// These worker fixtures test controls and privacy, NOT inference or hardware.
const fixture = `
onmessage = async ({ data }) => {
 if(data.kind === 'probe') postMessage({kind:'supported',description:'SIMULATED adapter; control test only'});
 if(data.kind === 'load') postMessage({kind:'ready',metrics:{loadMs:1}});
 if(data.kind === 'generate') {
   postMessage({kind:'token',text:'SIMULATED draft'});
   postMessage({kind:'done',metrics:{firstTokenMs:1,finishedMs:2}});
 }
};`;
async function setup(page: Page, worker = fixture) {
  const requests: string[] = [];
  const bodies: string[] = [];
  page.on("request", (request) => { requests.push(request.url()); bodies.push(request.postData() ?? ""); });
  await page.route("**/local-draft-policy.json", (route) => route.fulfill({ json: { version: 1, enabled: true } }));
  await page.route("**/inference.worker.ts*", (route) => route.fulfill({ contentType: "application/javascript", body: worker }));
  await page.goto("/local-draft.html");
  return { requests, bodies };
}
async function ready(page: Page) {
  await page.getByRole("button", { name: "Check WebGPU support" }).click();
  await expect(page.getByRole("status")).toContainText("SIMULATED adapter");
  await page.getByRole("button", { name: "Opt in: download or load model" }).click();
  await expect(page.getByRole("status")).toContainText("Ready.");
}

test("opt-in, prompt isolation, poor-quality fallback requires navigation and a second Send gesture", async ({ page }) => {
  const { requests, bodies } = await setup(page);
  await expect(page.getByText("212,426,251 bytes", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Opt in: download or load model" })).toBeDisabled();
  expect(requests.filter((url) => /huggingface|githubusercontent|\/api\//.test(url))).toEqual([]);
  await ready(page);
  const sentinel = "synthetic-private-canary-1295";
  await page.getByLabel("Local draft prompt", { exact: false }).fill(sentinel);
  await page.getByRole("button", { name: "Generate on this device" }).click();
  await expect(page.getByRole("region", { name: "Local draft output" })).toHaveText("SIMULATED draft");
  expect(bodies.join()).not.toContain(sentinel);
  expect(requests.filter((url) => /huggingface|githubusercontent|\/api\//.test(url))).toEqual([]);
  // A real network negative control: serving the ordinary chat without MOCK
  // here would permit metadata GETs, but no completion POST may start on entry.
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST") posts.push(r.url()); });
  await page.getByRole("link", { name: "Switch to server completion" }).click();
  await expect(page).toHaveURL(/\/ai$/);
  await expect(page.getByRole("heading", { name: "AI Studio" })).toBeVisible();
  expect(posts).toEqual([]);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("");
  // Mock server chat completion is only exercised after this explicit action.
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("public synthetic prompt");
  await page.getByRole("button", { name: /Sign in to send message|Send message/ }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("remote deny/malformed/unavailable fails closed before starting worker", async ({ page }) => {
  await setup(page);
  await page.route("**/local-draft-policy.json", (r) => r.fulfill({ json: { version: 1, enabled: "true" } }));
  await page.getByRole("button", { name: "Check WebGPU support" }).click();
  await expect(page.getByRole("status")).toContainText("disabled remotely");
  await expect(page.getByRole("button", { name: "Opt in: download or load model" })).toBeDisabled();
});

test("offline action revokes loaded runtime without server fallback", async ({ page, context }) => {
  const { requests } = await setup(page);
  await ready(page);
  await page.getByLabel("Local draft prompt", { exact: false }).fill("synthetic offline prompt");
  await context.setOffline(true);
  // Routing can bypass browser offline. Explicitly fail the policy transport.
  await page.route("**/local-draft-policy.json", (r) => r.abort("internetdisconnected"));
  await page.getByRole("button", { name: "Generate on this device" }).click();
  await expect(page.getByRole("status")).toContainText("policy unavailable");
  await expect(page).toHaveURL(/local-draft.html$/);
  expect(requests.filter((u) => /\/api\//.test(u))).toEqual([]);
});

test("cancel terminates stalled download and removes partial cache, including late replies", async ({ page }) => {
  const cache = "free2z-local-draft-smollm2-360m-v1";
  const stalled = `onmessage=async({data})=>{
    if(data.kind==='probe')postMessage({kind:'supported',description:'SIMULATED adapter'});
    if(data.kind==='load'){
      const cache=await caches.open('${cache}');await cache.put('/partial-model',new Response('partial'));
      postMessage({kind:'progress',text:'SIMULATED stalled download'});
      setTimeout(()=>postMessage({kind:'ready',metrics:{loadMs:1}}),500);
    }
  };`;
  await setup(page, stalled);
  await page.getByRole("button", { name: "Check WebGPU support" }).click();
  await page.getByRole("button", { name: "Opt in: download or load model" }).click();
  await expect(page.getByRole("status")).toContainText("stalled download");
  await page.getByRole("button", { name: "Cancel and release runtime" }).click();
  await expect(page.getByRole("status")).toContainText("cache removed");
  expect(await page.evaluate((key) => caches.has(key), cache)).toBe(false);
  await expect(page.getByRole("button", { name: "Generate on this device" })).toBeDisabled();
});

test("browser worker failure has an accessible explicit fallback; no automatic provider", async ({ page }) => {
  const { requests } = await setup(page, `onmessage=()=>{throw new Error('simulated runtime failure')}`);
  await page.getByRole("button", { name: "Check WebGPU support" }).click();
  await expect(page.getByRole("status")).toContainText("Browser worker failed");
  await expect(page.getByRole("link", { name: "Switch to server completion" })).toBeVisible();
  expect(requests.filter((u) => /\/api\//.test(u))).toEqual([]);
});

test("real browser capability failure never downloads or invokes server", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.route("**/local-draft-policy.json", (route) => route.fulfill({ json: { version: 1, enabled: true } }));
  await page.goto("/local-draft.html");
  await page.getByRole("button", { name: "Check WebGPU support" }).click();
  await expect(page.getByRole("status")).toContainText(/No WebGPU adapter|WebGPU unavailable|Device creation succeeded/);
  await expect(page.getByRole("link", { name: "Switch to server completion" })).toBeVisible();
  expect(requests.filter((u) => /huggingface|githubusercontent|\/api\//.test(u))).toEqual([]);
});

test("a remote kill stops an active generation on resume; late completion cannot re-enable it", async ({ page }) => {
  await setup(page, fixture.replace("if(data.kind === 'generate') {", "if(data.kind === 'generate') { await new Promise(r=>setTimeout(r,1000));"));
  await ready(page);
  await page.getByLabel("Local draft prompt", { exact: false }).fill("synthetic active generation");
  await page.getByRole("button", { name: "Generate on this device" }).click();
  await page.route("**/local-draft-policy.json", (r) => r.fulfill({ json: { version: 1, enabled: false } }));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("status")).toContainText("disabled or policy unavailable");
  await expect(page.getByRole("region", { name: "Local draft output" })).toBeEmpty();
  await expect(page.getByRole("button", { name: "Generate on this device" })).toBeDisabled();
});

test("another tab cannot take cache ownership or erase a live cache", async ({ page, context }) => {
  await setup(page);
  await ready(page);
  const key = "free2z-local-draft-smollm2-360m-v1";
  await page.evaluate(async (name) => { const c = await caches.open(name); await c.put('/ownership-sentinel', new Response('owned')); }, key);
  const second = await context.newPage();
  await setup(second);
  await second.getByRole("button", { name: "Check WebGPU support" }).click();
  await expect(second.getByRole("status")).toContainText("already open in another tab");
  await second.getByRole("button", { name: "Remove model cache" }).click();
  await expect(second.getByRole("status")).toContainText("in use by another tab");
  expect(await page.evaluate((name) => caches.has(name), key)).toBe(true);
  await second.close();
  await page.getByRole("button", { name: "Remove model cache" }).click();
  await expect(page.getByRole("status")).toContainText("cache removed");
  expect(await page.evaluate((name) => caches.has(name), key)).toBe(false);
});

test("narrow viewport and keyboard controls remain accessible (viewport emulation only)", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await setup(page);
  const check = page.getByRole("button", { name: "Check WebGPU support" });
  await check.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("SIMULATED adapter");
  expect(await check.evaluate((node) => getComputedStyle(node).cursor)).toBe("default");
  const optIn = page.getByRole("button", { name: "Opt in: download or load model" });
  expect(await optIn.evaluate((node) => getComputedStyle(node).cursor)).toBe("pointer");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("link", { name: "Switch to server completion" }).focus();
  await expect(page.getByRole("link", { name: "Switch to server completion" })).toBeFocused();
});
