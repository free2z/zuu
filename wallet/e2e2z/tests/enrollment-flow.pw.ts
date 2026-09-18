// "Enroll with ZUULI" (#1022), end to end in a real browser.
//
// The unmocked build with an iPhone user agent is exactly a phone build: the
// App Link transport installs, the real enrollment client samples keys through
// `e2e2z_device_credential_keys`, builds a real `issue-device-credential`
// request, and hands it to `e2e2z_dispatch_intent`. `tests/support/nativeHost`
// then plays ZUULI, answering over the reply App Link with a real response
// envelope, and the real session judges it.
//
// Every state asserted here is rendered copy, because that is what the person
// holding the phone reads.

import { expect, test, type Page } from "@playwright/test";
import {
  IPHONE_USER_AGENT,
  hostRecord,
  installNativeHost,
  mergeAt,
  unmockedBaseUrl,
  type HostOptions,
} from "./support/nativeHost";

const NOT_CONFIRMED = 9;
const UNAVAILABLE = 12;
/** ADR 0017 §4.1's refusal: the handle is not the signed-in account's. */
const HANDLE_UNAVAILABLE = 13;

const hexOf = (text: string) =>
  [...new TextEncoder().encode(text)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

async function open(page: Page, baseURL: string | undefined, options: HostOptions = {}) {
  await installNativeHost(page, options);
  await page.goto(unmockedBaseUrl(baseURL));
  await expect(
    page.getByRole("heading", { name: "Set up messaging on this device" }),
  ).toBeVisible();
}

async function startEnrollment(page: Page) {
  await page.getByLabel("Your free2z username").fill("Alice");
  await expect(page.locator("[data-enrollment-candidate]")).toHaveText("@alice");
  await page.getByRole("button", { name: "Enroll with ZUULI" }).click();
  await expect(
    page.getByRole("heading", { name: "Waiting for ZUULI" }),
  ).toBeVisible();
}

async function answer(page: Page, status: number) {
  await expect
    .poll(async () => (await hostRecord(page)).dispatched.length)
    .toBe(1);
  await page.evaluate(
    (value) =>
      (
        window as unknown as { __HOST__: { answerIntent(status: number): void } }
      ).__HOST__.answerIntent(value),
    status,
  );
}

test.describe("enroll with ZUULI", () => {
  test.use({ userAgent: IPHONE_USER_AGENT });

  test("asks ZUULI for the handle, installs its answer, and shows the engine's status", async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);

    // Explained before anything is asked.
    await expect(
      page.getByText("e2e2z never holds your wallet's recovery phrase"),
    ).toBeVisible();
    await expect(
      page.getByText("once free2z's directory confirms it belongs to your account"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Enroll with ZUULI" }),
    ).toBeDisabled();

    await page.getByLabel("Your free2z username").fill("a.b");
    await expect(
      page.getByText("can only use the letters a to z", { exact: false }),
    ).toBeVisible();

    await startEnrollment(page);
    await expect(page.getByText("This request expires in")).toBeVisible();
    await expect(page.getByText("ZUULI isn't installed on this device")).toBeVisible();

    const { invoked, dispatched } = await hostRecord(page);
    // Keys are sampled only once a transport exists, then the request leaves.
    expect(invoked.indexOf("e2e2z_device_credential_keys")).toBeLessThan(
      invoked.indexOf("e2e2z_dispatch_intent"),
    );
    // The request carries the lowercase candidate, not the typed text.
    expect(dispatched[0]).toContain(hexOf("alice"));
    expect(dispatched[0]).not.toContain(hexOf("Alice"));

    await answer(page, 0);

    await expect(page.getByText("Submitted, not yet active")).toBeVisible();
    await expect(page.locator("[data-enrollment-submitted]")).toContainText("@alice");
    // The engine's own reason the entry is not merged yet.
    await expect(page.getByText("directory-unreachable")).toBeVisible();
    // Not active, so no first contact yet, and nothing claims otherwise.
    await expect(page.getByText("Handle active")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Start a conversation" }),
    ).toHaveCount(0);

    const { installs } = await hostRecord(page);
    expect(installs).toHaveLength(1);
    // ADR 0016 §4: the handle this session asked for goes with the credential,
    // so the engine can refuse one signed for anyone else.
    expect(installs[0]?.["expectedHandle"]).toBe("alice");
    expect(installs[0]?.["credential"]).toBe("c0ffee00");
  });

  test("carries the endpoint it opened, and goes active only when the log has merged", async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    await startEnrollment(page);

    // ADR 0017 §4.1: the queue is opened before the request leaves, and the
    // request carries the address the relay issued.
    const { dispatched } = await hostRecord(page);
    expect(dispatched[0]).toContain(hexOf("wss://relay.free2z.com/relay/v1"));
    expect(dispatched[0]).toContain("44".repeat(32));
    // Family 4: `issue-device-credential-v2`. version(2) + length(3) + intent.
    expect(dispatched[0]?.slice(10, 14)).toBe("0004");

    await answer(page, 0);
    await expect(page.getByText("Submitted, not yet active")).toBeVisible();
    await expect(page.getByText("Handle active")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Start a conversation" }),
    ).toHaveCount(0);

    // The log merges the entry at an epoch boundary. Nothing tells this device;
    // it re-reads, and the screen moves on its own. Focus is one of the two
    // re-read points (the other is a timer this spec does not wait out), so the
    // re-read is driven rather than awaited once: a single dispatched event
    // that lands while a reconcile is already in flight is a race, not a
    // property.
    await mergeAt(page, 12);
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          return page.getByText("Handle active").count();
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    await expect(page.getByText("is published in the directory")).toBeVisible();
    await expect(page.getByText("Submitted, not yet active")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Start a conversation" }),
    ).toBeVisible();
  });

  test("says whose handle it is when ZUULI cannot vouch for this one", async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    await startEnrollment(page);
    await answer(page, HANDLE_UNAVAILABLE);
    await expect(
      page.getByText("ZUULI couldn't confirm @alice is yours"),
    ).toBeVisible();
    await expect(
      page.getByText("claim your messaging handle if you haven't yet", {
        exact: false,
      }),
    ).toBeVisible();
    // Nothing was installed, and nothing claims a submission.
    expect((await hostRecord(page)).installs).toHaveLength(0);
    await expect(page.getByText("Submitted, not yet active")).toHaveCount(0);
  });

  test("stops before asking when this build has no relay to be reached at", async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL, { keysError: "relay-unreachable" });
    await page.getByLabel("Your free2z username").fill("alice");
    await page.getByRole("button", { name: "Enroll with ZUULI" }).click();
    await expect(
      page.getByText("This build has no messaging service"),
    ).toBeVisible();
    await expect(page.getByText("relay-unreachable")).toBeVisible();
    expect((await hostRecord(page)).dispatched).toHaveLength(0);
  });

  test("says so when the person declines in ZUULI", async ({ page, baseURL }) => {
    await open(page, baseURL);
    await startEnrollment(page);
    await answer(page, NOT_CONFIRMED);
    await expect(page.getByText("You declined in ZUULI")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Try again with ZUULI" }),
    ).toBeEnabled();
    expect((await hostRecord(page)).installs).toHaveLength(0);
  });

  test("says so when ZUULI's wallet is not ready", async ({ page, baseURL }) => {
    await open(page, baseURL);
    await startEnrollment(page);
    await answer(page, UNAVAILABLE);
    await expect(
      page.getByText("ZUULI couldn't vouch for this device"),
    ).toBeVisible();
    await expect(
      page.getByText("make sure your wallet is set up and unlocked"),
    ).toBeVisible();
  });

  test("refuses a credential for a different handle", async ({ page, baseURL }) => {
    await open(page, baseURL, { installError: "handle-ineligible" });
    await startEnrollment(page);
    await answer(page, 0);
    await expect(page.getByText("ZUULI signed a different handle")).toBeVisible();
    await expect(
      page.getByText("This device asked for @alice, but the credential"),
    ).toBeVisible();
    await expect(page.getByText("Submitted, not yet active")).toHaveCount(0);
  });

  test("stops before asking when this device cannot keep a key", async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL, { keysError: "durability-unavailable" });
    await page.getByLabel("Your free2z username").fill("alice");
    await page.getByRole("button", { name: "Enroll with ZUULI" }).click();
    await expect(
      page.getByText("This device can't keep messaging keys safely"),
    ).toBeVisible();
    await expect(page.getByText("durability-unavailable")).toBeVisible();
    // Nothing reached ZUULI.
    expect((await hostRecord(page)).dispatched).toHaveLength(0);
  });

  test("points at installing ZUULI when its link would not open", async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL, { dispatchError: "internal" });
    await page.getByLabel("Your free2z username").fill("alice");
    await page.getByRole("button", { name: "Enroll with ZUULI" }).click();
    await expect(page.getByText("ZUULI didn't open")).toBeVisible();
    await expect(page.getByText("ZUULI isn't installed on this device")).toBeVisible();
  });

  test("cancels, and ignores the answer that arrives afterwards", async ({
    page,
    baseURL,
  }) => {
    await open(page, baseURL);
    await startEnrollment(page);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Enrollment cancelled")).toBeVisible();

    await answer(page, 0);
    // A macrotask for any wrongful install to have happened.
    await page.waitForTimeout(250);
    expect((await hostRecord(page)).installs).toHaveLength(0);
    await expect(page.getByText("Submitted, not yet active")).toHaveCount(0);
  });

  test("expires on the request's own two-minute deadline", async ({
    page,
    baseURL,
  }) => {
    await page.clock.install();
    await open(page, baseURL);
    await startEnrollment(page);
    await expect(page.getByText("This request expires in 2:00")).toBeVisible();

    await page.clock.runFor(30_000);
    await expect(page.getByText("This request expires in 1:30")).toBeVisible();

    await page.clock.runFor(91_000);
    await expect(page.getByText("The request expired")).toBeVisible();
    await expect(page.getByText("within 2 minutes")).toBeVisible();
    await expect(page.getByText("ZUULI isn't installed on this device")).toBeVisible();
  });

  test("names a build with no messaging relay", async ({ page, baseURL }) => {
    await open(page, baseURL, { engine: { relaysConfigured: 0 } });
    await expect(
      page.getByText("Messaging service not configured in this build"),
    ).toBeVisible();
    await expect(page.getByText("None configured in this build.")).toBeVisible();
    // The directory's standing warning stays visible before enrollment too.
    await expect(
      page.getByText("The directory is not independently witnessed yet"),
    ).toBeVisible();
  });

  test.describe("at phone width", () => {
    test.use({ viewport: { width: 360, height: 640 } });

    test("fits every word without a horizontal scroll", async ({ page, baseURL }) => {
      await open(page, baseURL);
      const overflow = () =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth > innerWidth ||
            [...document.querySelectorAll<HTMLElement>(".app-viewport, button")].some(
              (element) => element.scrollWidth > element.clientWidth + 1,
            ),
        );
      expect(await overflow()).toBe(false);
      await startEnrollment(page);
      expect(await overflow()).toBe(false);
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByText("Enrollment cancelled")).toBeVisible();
      expect(await overflow()).toBe(false);
    });
  });
});

test.describe("enroll with ZUULI, mocked data layer", () => {
  test("enrolls through the fixture engine and waits for the log", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("zuuli.mock.f2zmsg-scenario", "not-enrolled");
    });
    await page.goto("/");
    await page.getByLabel("Your free2z username").fill("fixture_user");
    await page.getByRole("button", { name: "Enroll with ZUULI" }).click();
    await expect(page.getByText("Submitted, not yet active")).toBeVisible();
    await expect(page.locator("[data-enrollment-submitted]")).toContainText(
      "@fixture_user",
    );
  });
});
