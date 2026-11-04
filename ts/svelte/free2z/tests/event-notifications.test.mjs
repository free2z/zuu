import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server;
let formatEventNotification;

// Identity translator: returns the English fallback, so these assertions are
// about which *message* gets chosen, not about the catalogs.
const translate = (_key, fallback, params) =>
  String(fallback ?? _key).replace(/\{([^{}]+)\}/g, (match, name) =>
    params && name in params ? String(params[name]) : match,
  );

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ formatEventNotification } = await server.ssrLoadModule(
    "/src/lib/utils/event-notifications.ts",
  ));
});

after(async () => {
  await server?.close();
});

function event(overrides) {
  return {
    id: "1",
    amount: 3,
    contributor: { username: "alice" },
    payee: null,
    receiving_user: { username: "bob" },
    content_title: "How Zcash Works",
    content_url: "/bob/how-zcash-works",
    read: false,
    created_at: "2026-07-20 00:00:00",
    ...overrides,
  };
}

// The backend writes two PAGE_VOTE rows per vote -- one to the voter, one to
// the page owner -- distinguished only by receiving_user. Rendering the owner
// framing for both tells the voter that they voted on their own page.
test("PAGE_VOTE is framed for whichever recipient is reading it", () => {
  const owner = formatEventNotification(
    event({ type: "PAGE_VOTE" }),
    translate,
    "en",
  );
  assert.equal(owner, "alice voted on “How Zcash Works” with 3 2Z.");

  const voter = formatEventNotification(
    event({ type: "PAGE_VOTE", receiving_user: { username: "alice" } }),
    translate,
    "en",
  );
  assert.equal(voter, "You voted on “How Zcash Works” with 3 2Z.");
  assert.doesNotMatch(voter, /alice/);
  assert.doesNotMatch(voter, /your page/);
});

test("titled event copy degrades to an untitled variant, never to a literal placeholder", () => {
  for (const type of ["PAGE_VOTE", "PAGE_UPDATE", "VOTE_COMMENT_SENT"]) {
    for (const content_title of [null, "", "   "]) {
      const rendered = formatEventNotification(
        event({ type, content_title }),
        translate,
        "en",
      );
      assert.doesNotMatch(
        rendered,
        /\{title\}|“”|“ ”/,
        `${type} with content_title=${JSON.stringify(content_title)}`,
      );
      assert.match(rendered, /\S/);
    }
  }
});

test("event types that name the content include its title", () => {
  assert.equal(
    formatEventNotification(event({ type: "PAGE_UPDATE" }), translate, "en"),
    "“How Zcash Works” by alice was updated.",
  );
  assert.equal(
    formatEventNotification(
      event({ type: "VOTE_COMMENT_SENT", content_title: "Nice post" }),
      translate,
      "en",
    ),
    "You voted on “Nice post” with 3 2Z.",
  );
});

test("redacted content uses the unavailable copy instead of a mention fallback", () => {
  const rendered = formatEventNotification(
    event({
      type: "PAGE_MENTION",
      content_available: false,
      content_title: null,
      message: "This content is no longer available.",
    }),
    translate,
    "en",
  );
  assert.equal(rendered, "This content is no longer available.");
});

test("an unknown event type never leaks the server's English message", () => {
  const rendered = formatEventNotification(
    event({ type: "SOME_FUTURE_TYPE", message: "raw server copy" }),
    translate,
    "en",
  );
  assert.equal(rendered, "You have a new notification.");
});

test("ENCRYPTED_CHAT_REQUEST names the sender and points at e2e2z", () => {
  const rendered = formatEventNotification(
    event({
      type: "ENCRYPTED_CHAT_REQUEST",
      amount: 1,
      content_title: null,
      content_url: "https://free2z.com/bridge/e2e2z/chat/#peer=alice",
      message: "raw server copy",
    }),
    translate,
    "en",
  );
  assert.equal(
    rendered,
    "alice paid 1 2Z to start an encrypted chat with you. Open e2e2z to reply.",
  );
});

test("the payer's own ENCRYPTED_CHAT_REQUEST row is framed as a spend", () => {
  const rendered = formatEventNotification(
    event({
      type: "ENCRYPTED_CHAT_REQUEST",
      amount: 1,
      contributor: { username: "alice" },
      receiving_user: { username: "alice" },
      payee: { username: "bob" },
      content_url: null,
    }),
    translate,
    "en",
  );
  assert.equal(rendered, "You paid 1 2Z to ask bob for an encrypted chat.");
});
