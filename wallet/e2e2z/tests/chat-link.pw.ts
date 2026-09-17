// Contract B (#1022): `https://free2z.com/bridge/e2e2z/chat/#peer=<handle>`.
//
// Proved in the unmocked build, with `tests/support/nativeHost` playing the
// operating system: `getCurrent` answers the link that launched the app, and
// `openUrl` delivers one while it runs. What must hold everywhere: the link
// fills in first contact and **never sends anything**.

import { expect, test, type Page } from "@playwright/test";
import {
  ACTIVE_ENROLLMENT,
  IPHONE_USER_AGENT,
  hostRecord,
  installNativeHost,
  unmockedBaseUrl,
  type HostOptions,
} from "./support/nativeHost";

const link = (fragment: string) =>
  `https://free2z.com/bridge/e2e2z/chat/${fragment}`;

const RUNNING: HostOptions["engine"] = {
  state: "running",
  enrolled: true,
  handle: "self",
  relaysConnected: 1,
  witnessThresholdMet: true,
  independentWitnesses: 1,
};

async function openUrl(page: Page, url: string) {
  await page.evaluate(
    (value) =>
      (
        window as unknown as { __HOST__: { openUrl(url: string): void } }
      ).__HOST__.openUrl(value),
    url,
  );
}

function handleField(page: Page) {
  return page.locator("#first-contact-handle");
}

async function expectNothingSent(page: Page) {
  const { invoked } = await hostRecord(page);
  expect(invoked).not.toContain("plugin:f2zmsg|start_conversation");
  expect(invoked).not.toContain("plugin:f2zmsg|send_message");
  expect(invoked).not.toContain("plugin:f2zmsg|accept_contact_request");
}

test.describe("the chat link", () => {
  test.use({ userAgent: IPHONE_USER_AGENT });

  test("fills in first contact on a cold start, and sends nothing", async ({
    page,
    baseURL,
  }) => {
    await installNativeHost(page, {
      engine: RUNNING,
      enrollment: ACTIVE_ENROLLMENT,
      launchUrls: [link("#peer=alice")],
    });
    await page.goto(unmockedBaseUrl(baseURL));

    await expect(handleField(page)).toHaveValue("alice");
    await expect(handleField(page)).toBeFocused();
    await expect(page.getByText("Filled in from a chat link")).toBeVisible();
    await expect(page.getByText("Nothing has been sent")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start chat" })).toBeEnabled();
    // Consumed: no second notice waiting.
    await expect(page.locator("[data-pending-peer]")).toHaveCount(0);

    await page.waitForTimeout(250);
    await expectNothingSent(page);
  });

  test("fills in first contact on a warm start", async ({ page, baseURL }) => {
    await installNativeHost(page, {
      engine: RUNNING,
      enrollment: ACTIVE_ENROLLMENT,
    });
    await page.goto(unmockedBaseUrl(baseURL));
    await expect(handleField(page)).toHaveValue("");

    await openUrl(page, link("#peer=bob_2"));
    await expect(handleField(page)).toHaveValue("bob_2");

    // A second link replaces the first; still nothing sent.
    await openUrl(page, link("#peer=carol"));
    await expect(handleField(page)).toHaveValue("carol");
    await expectNothingSent(page);
  });

  test("refuses a malformed link and says so", async ({ page, baseURL }) => {
    await installNativeHost(page, {
      engine: RUNNING,
      enrollment: ACTIVE_ENROLLMENT,
    });
    await page.goto(unmockedBaseUrl(baseURL));
    await expect(handleField(page)).toBeVisible();

    for (const refused of [
      link("#peer=Alice"),
      link("#peer=alice&peer=bob"),
      "https://free2z.com/bridge/e2e2z/chat/?peer=alice",
    ]) {
      await openUrl(page, refused);
      await expect(page.getByText("That chat link didn't work")).toBeVisible();
      await expect(handleField(page)).toHaveValue("");
      await page
        .locator("[data-chat-link-rejected]")
        .getByRole("button", { name: "Dismiss" })
        .click();
      await expect(page.getByText("That chat link didn't work")).toHaveCount(0);
    }
    await expectNothingSent(page);
  });

  test("ignores links for other routes, including intent replies", async ({
    page,
    baseURL,
  }) => {
    await installNativeHost(page, {
      engine: RUNNING,
      enrollment: ACTIVE_ENROLLMENT,
    });
    await page.goto(unmockedBaseUrl(baseURL));
    await expect(handleField(page)).toBeVisible();

    for (const other of [
      "https://free2z.com/bridge/e2e2z/#peer=alice",
      "https://free2z.com/bridge/e2e2z/#res=00&rid=00",
      "https://evil.example/bridge/e2e2z/chat/#peer=alice",
      "cash.free2z.e2e2z://bridge/e2e2z/chat/#peer=alice",
    ]) {
      await openUrl(page, other);
    }
    await page.waitForTimeout(250);
    await expect(handleField(page)).toHaveValue("");
    await expect(page.getByText("That chat link didn't work")).toHaveCount(0);
  });

  test("waits through enrollment, then resumes into first contact", async ({
    page,
    baseURL,
  }) => {
    await installNativeHost(page, {
      launchUrls: [link("#peer=alice")],
      mergeOnInstall: true,
    });
    await page.goto(unmockedBaseUrl(baseURL));

    await expect(page.getByText("Chat with @alice is waiting")).toBeVisible();
    await expect(
      page.getByText("Set up messaging on this device first"),
    ).toBeVisible();
    await expect(handleField(page)).toHaveCount(0);

    // Enroll as someone else; the pending peer is the other person.
    await page.getByLabel("Your free2z username").fill("bob");
    await page.getByRole("button", { name: "Enroll with ZUULI" }).click();
    await expect
      .poll(async () => (await hostRecord(page)).dispatched.length)
      .toBe(1);
    // ZUULI confirms; the host's install reports the handle already merged,
    // which is the moment first contact becomes available.
    await page.evaluate(() =>
      (
        window as unknown as { __HOST__: { answerIntent(status: number): void } }
      ).__HOST__.answerIntent(0),
    );

    await expect(page.getByText("Handle active")).toBeVisible();
    await expect(handleField(page)).toHaveValue("alice");
    await expect(page.getByText("Filled in from a chat link")).toBeVisible();
    await expect(page.locator("[data-pending-peer]")).toHaveCount(0);
    await expectNothingSent(page);
  });

  test("survives a relaunch before enrollment finishes", async ({
    page,
    baseURL,
  }) => {
    await installNativeHost(page, { launchUrls: [link("#peer=alice")] });
    await page.goto(unmockedBaseUrl(baseURL));
    await expect(page.getByText("Chat with @alice is waiting")).toBeVisible();

    await page.reload();
    await expect(page.getByText("Chat with @alice is waiting")).toBeVisible();

    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByText("Chat with @alice is waiting")).toHaveCount(0);
    // Dismissed means gone, including across a reload whose launch link is
    // the one already shown.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Set up messaging on this device" }),
    ).toBeVisible();
    await expect(page.getByText("Chat with @alice is waiting")).toHaveCount(0);
  });
});
