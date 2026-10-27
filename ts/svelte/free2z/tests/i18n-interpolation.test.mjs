import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite;
let i18n;

before(async () => {
  vite = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  i18n = await vite.ssrLoadModule("/src/lib/i18n.ts");
});

after(async () => {
  await vite?.close();
});

test("translate interpolates issue #530 messages in every shipped locale", () => {
  const expectedTitles = {
    en: "alice's Zcash Address",
    es: "Dirección Zcash de alice",
    fr: "Adresse Zcash de alice",
    "pt-BR": "Endereço Zcash de alice",
  };

  for (const [locale, expected] of Object.entries(expectedTitles)) {
    assert.equal(
      i18n.translate(
        locale,
        "pageActions.donate.modalTitle",
        "{username}'s Zcash Address",
        { username: "alice" },
      ),
      expected,
    );
  }

  assert.equal(
    i18n.translate(
      "en",
      "pageActions.share.textX",
      "Check out {title} by {username} on Free2Z",
      { title: "Privacy", username: "alice" },
    ),
    "Check out Privacy by alice on Free2Z",
  );
  assert.equal(
    i18n.translate(
      "en",
      "comments.serverError",
      "Server error: {status} {statusText}",
      { status: 503, statusText: "Service Unavailable" },
    ),
    "Server error: 503 Service Unavailable",
  );
});

test("direct and store translation APIs both forward interpolation params", () => {
  i18n.locale.set("en");

  assert.equal(
    i18n.t("pageActions.donate.title", "Donate to {username}", {
      username: "alice",
    }),
    "Donate to alice",
  );

  let storeTranslation;
  const unsubscribe = i18n.tStore.subscribe((value) => {
    storeTranslation = value;
  });

  assert.equal(
    storeTranslation(
      "pageActions.donate.modalTitle",
      "{username}'s Zcash Address",
      { username: "alice" },
    ),
    "alice's Zcash Address",
  );
  unsubscribe();
});

test("fallbacks interpolate known params and preserve unknown placeholders", () => {
  assert.equal(
    i18n.translate("en", "missing.translation", "{known} {unknown}", {
      known: "resolved",
    }),
    "resolved {unknown}",
  );
});
