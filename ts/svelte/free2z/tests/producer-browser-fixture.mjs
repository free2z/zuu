// Controlled provider+SDK browser contract. No production SDK acceptance claim.
import { chromium } from "../node_modules/@playwright/test/index.mjs";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const [url, session, csrf, bundle, labelsPath] = process.argv.slice(2);
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
try {
  const context = await browser.newContext({
    permissions: ["camera", "microphone"],
    viewport: { width: 320, height: 820 },
  });
  await context.addCookies([
    { name: "sessionid", value: session, url },
    { name: "csrftoken", value: csrf, url },
  ]);
  const page = await context.newPage();
  await page.goto(`${url}/api/healthz`);
  await page.setContent('<main><div id="producer"></div></main>');
  await page.addScriptTag({ content: await readFile(bundle, "utf8") });
  const labels = JSON.parse(await readFile(labelsPath, "utf8")).producer;
  await page.evaluate(
    async ({ labels, csrf }) => {
      const user = await (await fetch("/api/auth/user/")).json();
      window.producerPosts = [];
      window.left = 0;
      window.joinStarted = false;
      window.delayJoin = true;
      window.sdkActive = false;
      window.stopProducer = window.Free2zProducer.mountProducer(
        document.querySelector("#producer"),
        {
          actor: user.id,
          labels,
          current: () => true,
          transport: async (method, path, body) => {
            if (body) window.producerPosts.push(body);
            const r = await fetch(path, {
              method,
              headers: {
                "Content-Type": "application/json",
                "X-CSRFToken": csrf,
              },
              body: body ? JSON.stringify(body) : undefined,
            });
            const value = await r.json();
            if (!r.ok) throw new Error("refused");
            return value;
          },
          connect: async () => ({
            join: async () => {
              window.joinStarted = true;
              if (window.delayJoin) {
                window.delayJoin = false;
                await new Promise((resolve) => {
                  window.releaseProducerJoin = resolve;
                });
              }
              window.sdkActive = true;
            },
            leave: async () => {
              window.left++;
              window.sdkActive = false;
            },
            audio: async () => {},
            video: async () => {},
            device: async () => {},
            preview: () => {},
            onLeft: () => () => {},
            media: () => ({ audio: false, video: true }),
            onMedia: () => () => {},
          }),
        },
      );
    },
    { labels, csrf },
  );
  await page
    .getByRole("button", { name: "Check readiness and status", exact: true })
    .click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Real Django browser stream");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Controlled provider fixture");
  assert.equal(
    await page
      .getByRole("button", { name: "Prepare stream", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("button", { name: "Set up camera and microphone" })
    .click();
  await page
    .getByRole("button", { name: "Prepare stream", exact: true })
    .click();
  await page.getByText("Ready — not live", { exact: false }).waitFor();
  await page.waitForFunction(() => window.joinStarted);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    window.releaseProducerJoin();
  });
  await page.getByText("Interrupted — reconnect", { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.sdkActive), false);
  assert.equal(await page.evaluate(() => window.left), 2);
  const interruptedHistory = await page.evaluate(
    async () => await (await fetch("/api/dyte/producer/v1/history")).json(),
  );
  assert.equal(interruptedHistory[0].state, "interrupted");
  assert.equal(
    await page.evaluate(() =>
      window.producerPosts.some((b) => b.action === "publish"),
    ),
    false,
  );
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.waitForFunction(() => window.sdkActive);
  await page
    .getByRole("button", { name: "Confirm go live", exact: true })
    .click();
  await page.getByText("Live (server confirmed)", { exact: false }).waitFor();
  await page.getByRole("button", { name: "End stream", exact: true }).click();
  await page.getByText("Ended — cleanup confirmed", { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.left), 3);
  const history = await page.evaluate(
    async () => await (await fetch("/api/dyte/producer/v1/history")).json(),
  );
  assert.equal(history[0].state, "cleaned_up");
  assert.ok(history[0].ended_at);
  const discovery = await page.evaluate(
    async () => await (await fetch("/api/dyte/public/")).json(),
  );
  assert.equal(discovery.count, 0);
  const posts = await page.evaluate(() => window.producerPosts);
  assert.deepEqual(
    posts.map((b) => b.action),
    ["draft", "provision", "refresh", "interrupt", "refresh", "publish", "end"],
  );
  assert.equal(new Set(posts.map((b) => b.idempotency_key)).size, 7);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= 320),
    true,
  );
  await page.evaluate(() => window.stopProducer());
  console.log(
    "Controlled browser → Django → PostgreSQL → fake provider: delayed join cancellation, durable interruption, explicit resume, live, end, history and discovery passed.",
  );
} finally {
  await browser.close();
}
