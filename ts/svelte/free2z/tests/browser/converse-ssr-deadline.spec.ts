import { expect, test } from "@playwright/test";
import { browserAppOrigin, browserMockApiOrigin } from "./ports";

const origin = browserAppOrigin();
const mockOrigin = browserMockApiOrigin();

async function readConverse(heldBody = false, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}/converse`, {
      signal: controller.signal,
      headers: heldBody ? { cookie: "converse-deadline=body" } : {},
    });
    expect(response.status).toBe(200);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

test.beforeAll(async () => {
  test.setTimeout(60000);
  await readConverse(false, 55000);
});

test("ordinary Converse page one remains in the complete SSR response", async () => {
  const html = await readConverse();
  expect(html).toContain("ROOT-A-BODY");
  expect(html).toContain("REPLY-A2-BODY");
  expect(html).toContain("</html>");
});

test("Converse render deadline cancels an upstream body held after headers", async () => {
  const html = await readConverse(true);
  expect(html).toContain("</html>");
  expect(html).not.toContain("ROOT-A-BODY");
  await expect
    .poll(async () => {
      const response = await fetch(`${mockOrigin}/__test/converse-deadline`);
      return response.json();
    })
    .toEqual({ started: true, closed: true });
});
