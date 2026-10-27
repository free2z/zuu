//the billing page's Update and Unsubscribe actions validate the
// creator username they put into `/api/tuzis/subscribe/{username}`. The rule
// was `^[a-zA-Z0-9_]{1,64}$`, narrower than Django's (`[\w.@+-]`, Unicode
// `\w`, max 150), so a subscriber to `jane-doe` could not cancel a recurring
// charge. This pins the rule to Django's and keeps the path-segment guard.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  isSubscriptionUsername,
  SUBSCRIPTION_USERNAME_MAX_LENGTH,
} from "../src/lib/subscription-username.ts";

test("accepts every shape Django's UnicodeUsernameValidator stores", () => {
  for (const name of [
    "mutation_target",
    "state-inactive",
    "jane-doe",
    "a.b",
    "x@y",
    "p+q",
    "_",
    "a..b",
    ".hidden",
    "José",
    "名前",
    "a".repeat(65),
    "a".repeat(SUBSCRIPTION_USERNAME_MAX_LENGTH),
    // Code points, not UTF-16 units: Django counts 150 of these as 150.
    "𝒜".repeat(SUBSCRIPTION_USERNAME_MAX_LENGTH),
  ]) {
    assert.equal(isSubscriptionUsername(name), true, `should accept ${name}`);
  }
});

test("refuses what Django refuses and what would escape the path segment", () => {
  assert.equal(SUBSCRIPTION_USERNAME_MAX_LENGTH, 150);
  for (const name of [
    "",
    ".",
    "..",
    "../x",
    "a/b",
    "a b",
    "a%2Fb",
    "a?b",
    "a#b",
    "a\\b",
    " jane",
    "a".repeat(SUBSCRIPTION_USERNAME_MAX_LENGTH + 1),
    null,
    undefined,
    42,
  ]) {
    assert.equal(
      isSubscriptionUsername(name),
      false,
      `should refuse ${JSON.stringify(name)}`,
    );
  }
});

test("the billing actions use this rule, not a narrower local pattern", async () => {
  const source = await readFile(
    new URL(
      "../src/routes/[username]/dashboard/billing/+page.server.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    source,
    /import\s*\{\s*isSubscriptionUsername\s*\}\s*from\s*["']\$lib\/subscription-username["']/,
  );
  assert.match(
    source,
    /function validateStarUsername\(value: string\)\s*\{\s*return isSubscriptionUsername\(value\);/,
  );
  assert.doesNotMatch(source, /\[a-zA-Z0-9_\]\{1,64\}/);
  assert.match(source, /subscribe\/\$\{encodeURIComponent\(starUsername\)\}/);
});
