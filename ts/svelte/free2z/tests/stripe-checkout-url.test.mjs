import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Source-text assertions, deliberately. Both browser clients navigate to a URL
// that the *provider* chose, and the only thing standing between "Stripe
// returned something odd" and "we drove a signed-in user's browser there" is
// an exact-origin check on each client plus the same check on the server.
// There is no runtime harness here that can exercise a React component and a
// Svelte page and a SvelteKit form action, so pin the shape of the check and
// the shape of the navigation instead. The failure this guards against is a
// refactor quietly reintroducing `stripe.redirectToCheckout` (which takes only
// a session id, so the URL check becomes dead code) or dropping the origin
// check while keeping the assign().
const billingServer = await readFile(
  new URL(
    "../src/routes/[username]/dashboard/billing/+page.server.ts",
    import.meta.url,
  ),
  "utf8",
);
const billingPage = await readFile(
  new URL(
    "../src/routes/[username]/dashboard/billing/+page.svelte",
    import.meta.url,
  ),
  "utf8",
);
const classicCheckout = await readFile(
  new URL(
    "../../../react/free2z/src/components/StripeCheckoutButton.tsx",
    import.meta.url,
  ),
  "utf8",
);

const backendSettings = await readFile(
  new URL("../../../../py/free2z/dj/free2z/settings.py", import.meta.url),
  "utf8",
);

const sources = [
  ["billing +page.server.ts", billingServer],
  ["billing +page.svelte", billingPage],
  ["StripeCheckoutButton.tsx", classicCheckout],
];

test("every client that redirects checks the hosted origin exactly", () => {
  for (const [name, source] of sources) {
    assert.match(
      source,
      /function isStripeHostedCheckoutUrl/,
      `${name} must define the hosted-origin check`,
    );
    assert.match(
      source,
      /parsed\.hostname === "[^"]+"/,
      `${name} must compare the hostname exactly, never a suffix`,
    );
    // Userinfo is the shape that makes `checkout.stripe.com@evil.example`
    // read as trusted to a human; a port is never present on a real one.
    assert.match(source, /parsed\.port === ""/, `${name} must reject a port`);
    assert.match(
      source,
      /parsed\.username === ""/,
      `${name} must reject userinfo`,
    );
    assert.match(
      source,
      /parsed\.password === ""/,
      `${name} must reject userinfo`,
    );
  }
});

// The host is pinned in five places and CI can only see four (native ZUULI
// lives in free2z/zuu). The expensive direction is widening the BACKEND first:
// it opens a CheckoutIntent and creates a live Session on a host that every
// already-loaded tab, cached bundle and un-upgraded ZUULI install then refuses
// to navigate to, so no card completes and abandoned Sessions accumulate.
// Widening a CLIENT first costs nothing. So the invariant is a subset in one
// direction, not equality: the compatibility release ships first, and a client
// is allowed to accept more than one host while a migration is in flight.
// Only literals inside the RETURN EXPRESSION of isStripeHostedCheckoutUrl
// count. "The new host appears somewhere in the file" is not evidence the
// client would navigate there -- a comment, a dead branch or a CHECKOUT_HOSTS
// array the predicate never consults would all read as acceptance, which is
// how a compatibility PR could widen the deployed allowlist on the strength of
// a change that does nothing. A two-host release writes two comparisons inside
// that expression.
const CLIENT_PIN = /parsed\.hostname === "([^"]+)"/g;
const PREDICATE = "function isStripeHostedCheckoutUrl";

function balanced(source, start, opener, closer) {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === opener) depth += 1;
    else if (source[i] === closer) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function predicateReturnExpression(name, source) {
  const at = source.indexOf(PREDICATE);
  assert.ok(at !== -1, `${name} no longer defines ${PREDICATE}`);
  const body = balanced(source, source.indexOf("{", at), "{", "}");
  assert.ok(body, `${name}: unbalanced braces in ${PREDICATE}`);
  const ret = body.indexOf("return (");
  assert.ok(
    ret !== -1,
    `${name}: ${PREDICATE} no longer returns a single parenthesised ` +
      "expression; update this guard in the same PR so it still reads the " +
      "predicate that gates navigation",
  );
  const expression = balanced(body, body.indexOf("(", ret), "(", ")");
  assert.ok(expression, `${name}: unbalanced parentheses in ${PREDICATE}`);
  return expression;
}

function acceptedHosts(name, source) {
  const expression = predicateReturnExpression(name, source);
  return new Set([...expression.matchAll(CLIENT_PIN)].map((m) => m[1]));
}

test("the Svelte billing action only forwards a validated hosted URL", () => {
  assert.match(billingServer, /!isStripeHostedCheckoutUrl\(payload\?\.url\)/);
  assert.match(billingServer, /checkoutSessionId: payload\.id/);
  assert.match(billingServer, /checkoutUrl: payload\.url/);
});

test("both browser clients navigate to the validated hosted URL", () => {
  assert.match(billingPage, /const original = reviewedCheckout;/);
  assert.match(billingPage, /!original \|\| original\.url !== checkoutUrl/);
  assert.match(billingPage, /window\.location\.assign\(original\.url\)/);
  assert.match(
    billingPage,
    /isStripeHostedCheckoutUrl\(actionData\?\.checkoutUrl\)/,
  );
  assert.match(
    classicCheckout,
    /window\.location\.assign\(checkoutSession\.url\)/,
  );
  assert.match(classicCheckout, /isStripeHostedCheckoutUrl\(session\.url\)/);
  // Stripe.js's redirectToCheckout takes a session id, not a URL, so it would
  // route around every check above without changing a single line of them.
  assert.doesNotMatch(billingPage, /redirectToCheckout/);
  assert.doesNotMatch(classicCheckout, /redirectToCheckout/);
});
