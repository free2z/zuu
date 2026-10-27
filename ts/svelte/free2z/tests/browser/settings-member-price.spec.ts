import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * Settings: the membership price and the server's refusals.
 *
 * The page told creators "Set to 0 for free access." and sent `"0"`; the
 * server refused anything below 1 from 2023 until  made 0 a FREE
 * membership (2026-10-06), and the page threw the 400's body away for "Failed to save settings." — 32 failed saves by 6 creators in
 * 30 days, every one of them blind. The price was also labelled ZEC while it
 * is charged in 2Z.
 *
 * Every assertion here is POSITIVE: what the PATCH carried, what the page
 * says. "No error toast" proves nothing on a page whose failure mode was
 * silence.
 *
 * Fixture literals are duplicated in tests/browser/mock-api.mjs; keep in sync.
 * The billing fixture creator's `member_price` is "50".
 */
const SESSION = "billing-fixture-session";
const USER = "fixtureowner";
const SETTINGS_URL = `/${USER}/dashboard/settings`;
const MB = 1024 * 1024;

async function openSettings(page: Page) {
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([
      { name: "sessionid", value: SESSION, domain: "127.0.0.1", path: "/" },
    ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SETTINGS_URL);
  // A pre-hydration click is a no-op and looks exactly like the bug.
  await page.waitForLoadState("networkidle");
}

/**
 * Answer the profile PATCH with `respond`, recording every body sent. GETs
 * fall through to the shared mock API.
 */
async function routeProfilePatch(
  page: Page,
  respond: (body: Record<string, unknown>) => {
    status: number;
    body: unknown;
  },
) {
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/auth/user/", async (route) => {
    const request: Request = route.request();
    if (request.method() !== "PATCH") return route.fallback();
    const body = request.postDataJSON() as Record<string, unknown>;
    sent.push(body);
    const answer = respond(body);
    return route.fulfill({
      status: answer.status,
      contentType: "application/json",
      body: JSON.stringify(answer.body),
    });
  });
  return sent;
}

/** What the real serializer answers on success: the creator, updated. */
function saved(body: Record<string, unknown>) {
  return {
    status: 200,
    body: {
      username: USER,
      full_name: body.full_name ?? "",
      description: body.description ?? "",
      p2paddr: body.p2paddr ?? "",
      member_price: body.member_price ?? null,
      avatar_image: null,
      banner_image: null,
    },
  };
}

test("the price is labelled 2Z, and 0 is explained as a free follow", async ({
  page,
}) => {
  await openSettings(page);
  const field = page.getByLabel("Membership price (2Z per 30 days)");
  await expect(field).toHaveValue("50");
  await expect(
    page.getByText(
      "A whole number of 2Z credits, from 0 to 999,999, charged to each member every 30 days. Set it to 0 to make membership a free follow: followers get your members-only posts and streams at no cost.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Membership Price (ZEC)")).toHaveCount(0);
});

test("a negative or empty price is refused on the page, named, and nothing is sent", async ({
  page,
}) => {
  await openSettings(page);
  const sent = await routeProfilePatch(page, saved);

  const field = page.getByLabel("Membership price (2Z per 30 days)");
  await field.fill("-1");
  await page.getByTestId("settings-save-mobile").click();

  const inline = page.getByTestId("member-price-error");
  await expect(inline).toContainText("can't be negative");
  await expect(inline).toContainText("Use 0 for a free membership");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  const banner = page.getByTestId("settings-save-error");
  await expect(banner).toContainText("Membership price: ");
  await expect(banner).not.toContainText("Failed to save settings.");

  //the price is NOT NULL, so empty no longer means "no membership".
  await field.fill("");
  await page.getByTestId("settings-save-mobile").click();
  await expect(inline).toContainText("Enter a membership price");
  expect(sent, "a price the server refuses must never be sent").toHaveLength(0);
});

test('0 is a free membership and is sent as "0" (#2510)', async ({ page }) => {
  await openSettings(page);
  const sent = await routeProfilePatch(page, saved);

  const field = page.getByLabel("Membership price (2Z per 30 days)");
  await expect(page.locator("#memberPrice-help")).toContainText(
    "Set it to 0 to make membership a free follow",
  );
  await field.fill("0");
  await page.getByTestId("settings-save-mobile").click();

  await expect(page.getByTestId("settings-save-success")).toContainText(
    "Profile updated successfully.",
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]).toHaveProperty("member_price", "0");
});

test("a valid price is sent as a canonical whole number of 2Z", async ({
  page,
}) => {
  await openSettings(page);
  const sent = await routeProfilePatch(page, saved);

  await page.getByLabel("Membership price (2Z per 30 days)").fill(" 25.0 ");
  await page.getByTestId("settings-save-mobile").click();

  await expect(page.getByTestId("settings-save-success")).toBeVisible();
  expect(sent).toHaveLength(1);
  // "25.0" would be a 400 ("no more than 0 decimal places"); "25" is not.
  expect(sent[0]).toHaveProperty("member_price", "25");
});

test("the server's field errors are shown, named, next to the field", async ({
  page,
}) => {
  await openSettings(page);
  // Any field, not just the price: the page used to read none of them.
  const sent = await routeProfilePatch(page, () => ({
    status: 400,
    body: {
      p2paddr: ["Enter a valid shielded Zcash address."],
      username: ["A user with that username already exists!"],
    },
  }));

  await page.getByTestId("settings-save-mobile").click();

  await expect(page.getByTestId("p2paddr-error")).toHaveText(
    "Enter a valid shielded Zcash address.",
  );
  const banner = page.getByTestId("settings-save-error");
  await expect(banner).toContainText(
    "Zcash Address: Enter a valid shielded Zcash address.",
  );
  // A field this page has no input for still reaches the creator, by name.
  await expect(banner).toContainText(
    "username: A user with that username already exists!",
  );
  await expect(banner).not.toContainText("Failed to save settings.");
  expect(sent).toHaveLength(1);
});

test("the server's own member_price refusal is shown, not discarded", async ({
  page,
}) => {
  await openSettings(page);
  // The exact 69-byte body prod answered 32 times.
  await routeProfilePatch(page, () => ({
    status: 400,
    body: {
      member_price: ["Ensure this value is greater than or equal to 1."],
    },
  }));

  await page.getByTestId("settings-save-mobile").click();

  await expect(page.getByTestId("member-price-error")).toHaveText(
    "Ensure this value is greater than or equal to 1.",
  );
  await expect(page.getByTestId("settings-save-error")).toContainText(
    "Membership price: Ensure this value is greater than or equal to 1.",
  );
});

test("an image over 5 MB is accepted when the creator's tier allows it", async ({
  page,
}) => {
  // The page used to refuse anything over a hardcoded 5 MB, whatever the
  // creator's tier. The limit is the server's now.
  await page.route("**/api/uploads/limits/", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tuzis: 100,
        max_bytes: 250 * MB,
        tiers: [
          { min_tuzis: 0, max_bytes: 5 * MB },
          { min_tuzis: 1, max_bytes: 250 * MB },
        ],
      }),
    }),
  );
  await openSettings(page);
  let uploads = 0;
  await page.route("**/uploads/single-public", (route) => {
    uploads += 1;
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ id: 77, url: "/media/avatar.png" }),
    });
  });
  const sent = await routeProfilePatch(page, saved);

  const header = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.getByLabel("Upload avatar").setInputFiles({
    name: "big-avatar.png",
    mimeType: "image/png",
    buffer: Buffer.concat([header, Buffer.alloc(6 * MB - header.length)]),
  });
  // The preview switches to the picked file only once it passed validation.
  await expect(page.getByAltText("Profile avatar")).toHaveAttribute(
    "src",
    /^blob:/,
  );
  await expect(page.getByTestId("settings-save-error")).toHaveCount(0);

  await page.getByTestId("settings-save-mobile").click();
  await expect(page.getByTestId("settings-save-success")).toBeVisible();
  expect(uploads).toBe(1);
  expect(sent[0]).toHaveProperty("avatar_image", 77);
});

test("Save pressed while a picked image is still being checked waits for it", async ({
  page,
}) => {
  // Codex review of: the limit check made the pick asynchronous, and a
  // Save pressed inside that window PATCHed without the image, said
  // "updated", and then showed the unsaved image as the avatar.
  let releaseLimit = () => {};
  const limitHeld = new Promise<void>((resolve) => {
    releaseLimit = resolve;
  });
  let limitAsked = () => {};
  const limitRequested = new Promise<void>((resolve) => {
    limitAsked = resolve;
  });
  await page.route("**/api/uploads/limits/", async (route) => {
    limitAsked();
    await limitHeld;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tuzis: 0,
        max_bytes: 5 * MB,
        tiers: [{ min_tuzis: 0, max_bytes: 5 * MB }],
      }),
    });
  });
  await openSettings(page);
  let uploads = 0;
  await page.route("**/uploads/single-public", (route) => {
    uploads += 1;
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ id: 88, url: "/media/avatar.png" }),
    });
  });
  const sent = await routeProfilePatch(page, saved);

  const header = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.getByLabel("Upload avatar").setInputFiles({
    name: "small-avatar.png",
    mimeType: "image/png",
    buffer: Buffer.concat([header, Buffer.alloc(64 * 1024)]),
  });
  await limitRequested;
  const save = page.getByTestId("settings-save-mobile");
  await save.click();
  await expect(save).toBeDisabled();
  expect(sent, "nothing is saved while the pick is unchecked").toHaveLength(0);

  releaseLimit();
  await expect(page.getByTestId("settings-save-success")).toBeVisible();
  expect(uploads).toBe(1);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toHaveProperty("avatar_image", 88);
});

test("an image replaced while Save waits is the one that is saved", async ({
  page,
}) => {
  // Codex review round 2 of: Save awaited only the checks pending when
  // it was pressed. A replacement picked meanwhile, whose check needs a
  // second (refresh) limit read, was left behind: PATCH without the image,
  // "updated", then the unsaved preview.
  const gates: (() => void)[] = [];
  const asked: number[] = [];
  let answered = 0;
  await page.route("**/api/uploads/limits/", async (route) => {
    const call = asked.length;
    asked.push(call);
    await new Promise<void>((resolve) => gates.push(resolve));
    answered += 1;
    // First read: 5 MB (image B looks oversize, so a refresh is made).
    // Second read: the tier went up; B fits.
    const max = call === 0 ? 5 * MB : 250 * MB;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tuzis: call === 0 ? 0 : 100,
        max_bytes: max,
        tiers: [
          { min_tuzis: 0, max_bytes: 5 * MB },
          { min_tuzis: 1, max_bytes: 250 * MB },
        ],
      }),
    });
  });
  await openSettings(page);
  const uploaded: number[] = [];
  await page.route("**/uploads/single-public", (route) => {
    const size = route.request().postDataBuffer()?.length ?? 0;
    uploaded.push(size);
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ id: 99, url: "/media/avatar.png" }),
    });
  });
  const sent = await routeProfilePatch(page, saved);

  const header = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const avatar = page.getByLabel("Upload avatar");
  await avatar.setInputFiles({
    name: "a.png",
    mimeType: "image/png",
    buffer: Buffer.concat([header, Buffer.alloc(64 * 1024)]),
  });
  await expect.poll(() => asked.length).toBe(1);
  await page.getByTestId("settings-save-mobile").click();
  await avatar.setInputFiles({
    name: "b.png",
    mimeType: "image/png",
    buffer: Buffer.concat([header, Buffer.alloc(6 * MB)]),
  });

  gates[0]();
  // B looked oversize against the first read, so a fresh one is made.
  await expect.poll(() => asked.length).toBe(2);
  await expect.poll(() => answered).toBe(1);
  expect(sent, "Save must still be waiting for B's check").toHaveLength(0);

  gates[1]();
  await expect(page.getByTestId("settings-save-success")).toBeVisible();
  expect(uploaded).toHaveLength(1);
  expect(uploaded[0]).toBeGreaterThan(6 * MB);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toHaveProperty("avatar_image", 99);
});

test("a price edited while a save is in flight is not overwritten", async ({
  page,
}) => {
  // Codex review of: the saved response used to be written back into
  // the field unconditionally, replacing a newer edit with the older price.
  await openSettings(page);
  let releasePatch = () => {};
  const patchHeld = new Promise<void>((resolve) => {
    releasePatch = resolve;
  });
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/auth/user/", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    await patchHeld;
    const answer = saved(body);
    return route.fulfill({
      status: answer.status,
      contentType: "application/json",
      body: JSON.stringify(answer.body),
    });
  });

  const field = page.getByLabel("Membership price (2Z per 30 days)");
  await field.fill("60");
  await page.getByTestId("settings-save-mobile").click();
  await expect.poll(() => sent.length).toBe(1);
  await field.fill("500");
  releasePatch();

  await expect(page.getByTestId("settings-save-success")).toBeVisible();
  expect(sent[0]).toHaveProperty("member_price", "60");
  await expect(field).toHaveValue("500");
});
