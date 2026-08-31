import { describe, expect, it } from "vitest";
import {
  FEEDBACK_GITHUB_NEW_ISSUE_URL,
  FEEDBACK_SUPPORT_EMAIL,
  HANDOFF_URL_LIMIT,
  buildFeedbackHandoffUrl,
  captureFeedbackDiagnostics,
  createFeedbackDraft,
  feedbackDraftText,
  reviewFeedbackDraft,
  scrubFeedbackText,
  type FeedbackDraft,
} from "./feedback";
import { isValidEnglishBip39Mnemonic } from "./bip39";

const BUILD_BLOCK =
  "ZUULI\nVersion: 0.1.0\nBuild: 17\nChannel: Internal\nPlatform: iOS\nSource commit: 0123456789ab";
const DEFAULT_SUBJECT = "ZUULI feedback";
const REDACTED_VALUE = "[removed: sensitive value]";
const SUBJECT_PREFIX = "Subject";

describe("feedback privacy boundary", () => {
  it("has no diagnostics input or traceback capture path", () => {
    expect(captureFeedbackDiagnostics.length).toBe(0);
    expect(captureFeedbackDiagnostics()).toBeNull();
    // JavaScript callers can violate the TypeScript arity at runtime. Even in
    // that case the implementation ignores the nested native/web exception.
    expect(
      (captureFeedbackDiagnostics as (...input: unknown[]) => null)({
        name: "Error",
        message: "password: correct horse battery staple",
        stack: "at /Users/alice/wallet.ts:42",
        cause: {
          kind: "TauriInvokeError",
          payload: {
            rust_backtrace: "seed: abandon ability able about above absent",
          },
        },
      }),
    ).toBeNull();
  });

  it.each([
    "seed: abandon ability able about above absent absorb abstract absurd abuse access accident",
    "spending key: secret-extended-key-main1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    "viewing key: uview1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    "password=correct-horse-battery-staple",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.0123456789",
    "session: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature123",
    "TOTP: JBSWY3DPEHPK3PXP",
    "address u1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    `txid ${"a".repeat(64)}`,
    "memo: payment for Alice",
    "balance: 42.000 ZEC",
    "host: wallet.internal.example",
    "network 192.168.1.44",
    "device id: 00000000-1111-2222-3333-444444444444",
    "path: /Users/alice/Library/Application Support/cash.free2z.zuuli/wallet.db",
    "crash.log",
    "clipboard: copied wallet seed",
  ])("removes prohibited secret-shaped input: %s", (secret) => {
    const reviewed = createFeedbackDraft(
      `The app failed. ${secret}`,
      BUILD_BLOCK,
      DEFAULT_SUBJECT,
      REDACTED_VALUE,
    );
    expect(reviewed.findings.length).toBeGreaterThan(0);
    expect(feedbackDraftText(reviewed.draft, SUBJECT_PREFIX)).not.toContain(secret);
    expect(feedbackDraftText(reviewed.draft, SUBJECT_PREFIX)).toContain(
      REDACTED_VALUE,
    );
  });

  it.each([
    encodeURIComponent("password: super-secret-value"),
    encodeURIComponent(encodeURIComponent("memo: private transfer")),
    btoa("Authorization: Bearer very-secret-token"),
    "p\u0430ssword: unicode-confusable-secret",
    "password:\u200bhidden-with-zero-width",
    "https://example.invalid/report?token=secret-token#private",
    "Error\u0000password: hidden-control-secret",
  ])("scrubs encoded, Unicode, URL and control-character attacks", (attack) => {
    const result = scrubFeedbackText(attack, REDACTED_VALUE);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.text).not.toContain("secret-token");
    expect(result.text).not.toContain("private transfer");
    expect(result.text).not.toContain("unicode-confusable-secret");
    expect(result.text).not.toContain("hidden-with-zero-width");
  });

  const percentEncode = (value: string, passes: number) => {
    let encoded = value;
    for (let pass = 0; pass < passes; pass += 1) {
      encoded = encodeURIComponent(encoded);
    }
    return encoded;
  };

  const encodedPassword = btoa("password: hunter2");
  const exactReviewerCorpus = [
    "auth token ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    "oauth token ya29.a0AfH6SMabcdefghijklmnopqrstuvwxyz",
    "session 550e8400-e29b-41d4-a716-446655440000",
    btoa(encodedPassword),
    encodedPassword.replace(/(.{8})/gu, "$1 \n"),
    "pαssword: hunter2",
    "abandon, ability, able, about, above, absent, absorb, abstract, absurd, abuse, access, accident",
    "password hunter2",
    percentEncode("password: hunter2", 4),
    "0123456789abcdef0123456789abcdef",
    "0123456789abcdef0123456789abcdef01234567",
    "example.com?access_token=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    "p\u{E0001}assword: hunter2",
    "p\u0336assword: hunter2",
    "paѕѕword: hunter2",
    "pαssword: hunter2",
    "p&#97;ssword: hunter2",
    "p&#x61;ssword: hunter2",
    "p\\u0061ssword: hunter2",
    "p%26%2397%3Bssword%3A%20hunter2",
    "pass-word: hunter2",
    "p4ssword: hunter2",
    "JBSWYDPFGEZDGNBV",
    "I have 42.000 ZEC available",
    "Sent from Alice iPhone 15 Pro",
    "Crash at /etc/zuuli/config",
    "Screenshot IMG_1234.PNG",
    "Saved in /opt/zuuli/wallet.dat",
    "Read \\\\server\\share\\wallet.bin",
    "TauriInvokeError { code: 7, rust_backtrace: src/main.rs:42 }",
    "раѕѕԝогԁ: hunter2",
    "p\\x61ssword: hunter2",
    "C:/Users/Alice/Wallet/config",
    "~/Library/Application Support/Wallet",
    "../wallet/config",
    ".env",
    "Crash on Alice iPhone 15 Pro",
    "01941f2e-7cc4-7a1d-9c88-0123456789ab",
    "sk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
    "glpat-abcdefghijklmnopqrstuvwxyz1234567890",
    "github_pat_abcdefghijklmnopqrstuvwxyz1234567890",
    "U1L8XUNEZSVPNTQ2SNZ67H6MD2EQ09U09VV3XH6Z8KQVXG7PDVZ4QC9X2U84KQMPC0MZ0KMVEXZ",
    `0x${"a".repeat(64)}`,
    "Payment for Alice birthday gift",
    "Copied text was hunter2",
    "I have ZEC 42 available",
    "Connected to localhost",
    "zc8E5gYid86n4bo2Usdq1cpr7PpfoJGzttwBHEEgGhGkLUg7SPPVFNB2AkRFXZ7usfphup5426dt1buMmY3fkYeRrQGLa8y",
    "tm9iMLAuYMzJ6jtFLcA7rzUmfreGuKvr7Ma",
    "t26YoyZ1iPgiMEWL4zGUm74eVWfhyDMXzY2",
    "5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf",
    "npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "IMEI: 490154203237518",
    "Android ID: 9774d56d682e549c",
    "contraseña: hunter2",
    "ztJ1EWLKcGwF2S4NA17pAJVdco8Sdkz4AQPxt1cLTEfNuyNswJJc2BbBqYrsRZsp31xbVZwhF7c7a2L9jsF3p3ZwRWpqqyS",
    "9213qJab2HNEpMpYNBa7wHGFKKbkDn24jpANDs2huN3yi4J11ko",
    "cTpB4YiyKiBcPxnefsDpbnDxFDffjqJob8wGCEDXxgQ7zQoMXJdH",
    "utest10c5kutapazdnf8ztl3pu43nkfsjx89fy3uuff8tsmxm6s86j37pe7uz94z5jhkl49pqe8yz75rlsaygexk6jpaxwx0esjr8wm5ut7d5s",
    "uregtest15xk7vj4grjkay6mnfl93dhsflc2yeunhxwdh38rul0rq3dfhzzxgm5szjuvtqdha4t4p2q02ks0jgzrhjkrav70z9xlvq0plpcjkd5z3",
    "uviewtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    "uviewregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    "uivk1z28yg638vjwusmf0zc9ad2j0mpv6s42wc5kqt004aaqfu5xxxgu7mdcydn9qf723fnryt34s6jyxyw0jt7spq04c3v9ze6qe9gjjc5aglz8zv5pqtw58czd0actynww5n85z3052kzgy6cu0fyjafyp4sr4kppyrrwhwev2rr0awq6m8d66esvk6fgacggqnswg5g9gkv6t6fj9ajhyd0gmel4yzscprpzduncc0e2lywufup6fvzf6y8cefez2r99pgge5yyfuus0r60khgu895pln5e7nn77q6s9kh2uwf6lrfu06ma2kd7r05jjvl4hn6nupge8fajh0cazd7mkmz23t79w",
    "uivktest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    "uivkregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    "contraseña: hunter",
    "IMEI 490154203237518",
    "Android ID = 9774d56d682e549c",
    "LNiZqQdeOqqL5ghssJ8QT5yDElWh5vJQaqEfNpu9cHM=",
    "LNiZqQdeOqqL5ghssJ8QT5yDElWh5vJQaqEfNpu9cHM",
    "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=",
    "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo",
    "Z2dnZ2dnZ2dnZ2dnZ2dnZ2dnZ2dnZ2dnZ2dnZ2dnZ2c=",
    "jbswy3dpehpk3pxp",
    "JbSwY3DpEhPk3PxP",
    "例え.テスト",
    "Serial number: C02ZQ0ABC123",
    "Library/Application Support/Wallet",
    "Documents/Wallet/config",
    "Pasteboard: hunter2",
    "Error reference aaaaaaaaaaaaaaaaaaaaaaaaaaaa1234",
    "%AA".repeat(32),
    "%67".repeat(32),
    encodeURIComponent("%AA".repeat(32)),
    Array.from({ length: 32 }, () => "%AA").join(" \n"),
    "\\xAA".repeat(32),
    "\\x67".repeat(32),
    "\\u00AA".repeat(32),
    "\\u0067".repeat(32),
    "\\x7e\\u007e".repeat(16),
    Array.from({ length: 32 }, (_, index) =>
      index % 2 === 0 ? "\\x7e" : "\\u007e",
    ).join(" \n"),
    "&#126;".repeat(32),
    "&#126;&#x7e;".repeat(16),
    Array.from({ length: 32 }, (_, index) =>
      index % 2 === 0 ? "&#126;" : "&#x7e;",
    ).join(" \n"),
    "&amp;#126;".repeat(32),
    "&#000126;".repeat(32),
    "&#x00007e;".repeat(32),
    Array.from({ length: 32 }, (_, index) =>
      index % 2 === 0 ? "&#000126;" : "&#x00007e;",
    ).join(" \n"),
    "&amp;#000126;".repeat(32),
  ] as const;

  it.each(exactReviewerCorpus)(
    "fails closed for the exact reviewer corpus: %s",
    (attack) => {
      const reviewed = reviewFeedbackDraft(
        { subject: DEFAULT_SUBJECT, body: `Observed failure: ${attack}` },
        REDACTED_VALUE,
      );
      expect(reviewed.findings.length).toBeGreaterThan(0);
      expect(reviewed.draft.body).toContain(REDACTED_VALUE);
      expect(reviewed.draft.body).not.toContain(attack);

      for (const channel of ["email", "github"] as const) {
        const handoff = buildFeedbackHandoffUrl(
          channel,
          { subject: DEFAULT_SUBJECT, body: `Observed failure: ${attack}` },
          REDACTED_VALUE,
        );
        expect(handoff.status).toBe("unsafe");
        expect("url" in handoff).toBe(false);
      }
    },
  );

  it("recurses through mixed percent and whitespace-wrapped base64 nesting", () => {
    const nested = percentEncode(
      btoa(btoa("Authorization: Bearer deepest-secret-token")),
      5,
    ).replace(/(.{9})/gu, "$1\n");
    const reviewed = reviewFeedbackDraft(
      { subject: DEFAULT_SUBJECT, body: nested },
      REDACTED_VALUE,
    );
    expect(reviewed.findings).toContain("encoded-sensitive-value");
    expect(reviewed.draft.body).toBe(REDACTED_VALUE);
  });

  const validTwelveWordMnemonic = `${"abandon ".repeat(11)}about`.trim();
  const validTwentyFourWordMnemonic = `${"abandon ".repeat(23)}art`.trim();

  it("matches the shipping English BIP39 dictionary and checksum", () => {
    expect(isValidEnglishBip39Mnemonic(validTwelveWordMnemonic.split(" "))).toBe(
      true,
    );
    expect(
      isValidEnglishBip39Mnemonic(validTwentyFourWordMnemonic.split(" ")),
    ).toBe(true);
    expect(
      isValidEnglishBip39Mnemonic(
        `${"abandon ".repeat(11)}ability`.trim().split(" "),
      ),
    ).toBe(false);
  });

  it.each([
    validTwelveWordMnemonic,
    validTwentyFourWordMnemonic,
    "abandon ability able about above absent absorb abstract absurd abuse access accident",
    "abandon;ability;able;about;above;absent;absorb;abstract;absurd;abuse;access;accident",
    validTwelveWordMnemonic.replace(/ /gu, "\n"),
    percentEncode(validTwelveWordMnemonic, 3),
    btoa(validTwelveWordMnemonic),
  ])("removes unlabeled BIP39-shaped material at review and transport: %s", (phrase) => {
    const draft = { subject: DEFAULT_SUBJECT, body: phrase };
    const reviewed = reviewFeedbackDraft(draft, REDACTED_VALUE);
    expect(reviewed.findings.length).toBeGreaterThan(0);
    expect(reviewed.draft.body).toBe(REDACTED_VALUE);
    for (const channel of ["email", "github"] as const) {
      const handoff = buildFeedbackHandoffUrl(channel, draft, REDACTED_VALUE);
      expect(handoff.status).toBe("unsafe");
      expect("url" in handoff).toBe(false);
    }
  });

  it.each([
    "Saved in /opt/zuuli/wallet.dat",
    "Read \\\\server\\share\\wallet.bin",
    "TauriInvokeError { code: 7, rust_backtrace: src/main.rs:42 }",
  ])("is stable and leaves no second-pass path or trace residual: %s", (attack) => {
    const first = reviewFeedbackDraft(
      { subject: DEFAULT_SUBJECT, body: attack },
      REDACTED_VALUE,
    );
    expect(first.draft.body).toBe(REDACTED_VALUE);
    const second = reviewFeedbackDraft(first.draft, REDACTED_VALUE);
    expect(second.findings).toEqual([]);
    expect(second.draft).toEqual(first.draft);
    expect(
      buildFeedbackHandoffUrl("github", first.draft, REDACTED_VALUE).status,
    ).toBe("ready");
  });

  it.each(["email", "github"] as const)(
    "blocks %s secrets split across subject and body",
    (channel) => {
      for (const draft of [
        { subject: "password", body: "hunter2" },
        {
          subject: "abandon abandon abandon abandon abandon abandon",
          body: "abandon abandon abandon abandon abandon about",
        },
        { subject: "cGF", body: "zc3dvcmQ6IGh1bnRlcjI=" },
        { subject: "%70%61%73%73", body: "%77%6f%72%64%3a%20hunter2" },
        { subject: "p\\x61ss", body: "word: hunter2" },
      ]) {
        const reviewed = reviewFeedbackDraft(draft, REDACTED_VALUE);
        expect(reviewed.findings.length).toBeGreaterThan(0);
        expect(reviewed.draft).toEqual({
          subject: REDACTED_VALUE,
          body: REDACTED_VALUE,
        });
        expect(
          buildFeedbackHandoffUrl(channel, draft, REDACTED_VALUE).status,
        ).toBe("unsafe");
      }
    },
  );

  it.each(["\uD800", "\uDC00"])(
    "canonicalizes an unpaired surrogate before preview and preserves both handoffs: %s",
    (surrogate) => {
      const firstReview = reviewFeedbackDraft(
        {
          subject: `Report ${surrogate}`,
          body: `Scalar text ${surrogate} remains visibly canonical`,
        },
        REDACTED_VALUE,
      );
      expect(firstReview.findings).toContain("unsafe-control-character");
      expect(firstReview.draft.subject).not.toContain(surrogate);
      expect(firstReview.draft.body).not.toContain(surrogate);

      for (const channel of ["email", "github"] as const) {
        const handoff = buildFeedbackHandoffUrl(
          channel,
          firstReview.draft,
          REDACTED_VALUE,
        );
        expect(handoff.status).toBe("ready");
        if (handoff.status !== "ready") continue;
        const query = handoff.url.slice(handoff.url.indexOf("?") + 1);
        const parameters = new URLSearchParams(query);
        expect(
          parameters.get(channel === "email" ? "subject" : "title"),
        ).toBe(firstReview.draft.subject);
        expect(parameters.get("body")).toBe(firstReview.draft.body);
      }
    },
  );

  it("allows a username or email only when the user explicitly enters it", () => {
    const result = createFeedbackDraft(
      "Please reply to Alice Example at alice@example.com.",
      BUILD_BLOCK,
      DEFAULT_SUBJECT,
      REDACTED_VALUE,
    );
    expect(result.findings).toEqual([]);
    expect(result.draft.body).toContain("alice@example.com");
  });

  it.each([
    "Please reply to alice12345678901234567890@example.com",
    "Please reply to alice+feedback12345678901234567890@mail.example.com",
    "username alice12345678901234567890",
    "Crash reference issue-1234",
  ])("preserves explicitly typed identity or ordinary reference text: %s", (text) => {
    const reviewed = createFeedbackDraft(
      text,
      BUILD_BLOCK,
      DEFAULT_SUBJECT,
      REDACTED_VALUE,
    );
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.draft.body).toContain(text);
    for (const channel of ["email", "github"] as const) {
      const handoff = buildFeedbackHandoffUrl(
        channel,
        reviewed.draft,
        REDACTED_VALUE,
      );
      expect(handoff.status).toBe("ready");
      if (handoff.status !== "ready") continue;
      const fields = new URLSearchParams(handoff.url.slice(handoff.url.indexOf("?") + 1));
      expect(fields.get("body")).toBe(reviewed.draft.body);
    }
  });

  it.each([
    "the app crashed when i opened settings and tried to go back",
    "THISISANERRORMESSAGE",
    "ABCDEFGHIJKLMNOP",
    "please open account page again click transfer close screen help error report",
    "Status: settings screen failed to open",
    "Versión: beta123",
    "Aplicación: crashes2",
    "VGhpcyBpcyBhIHNhZmUgc3VwcG9ydCByZWZlcmVuY2Uu",
    "Support reference -_v7-_v7-_v7-_v7-_v7",
    "The serial number field is empty",
    "Use the pasteboard button to retry",
    "Open settings/privacy and try again",
    "the app stopped now",
    "settings screen failed",
    "settings screen stopped now",
    "the app stopped responding again",
    "the app crashed when opening settings",
    "Progress is 20% complete",
    "Use %20 only as an example",
    "One entity &#126; is a tilde",
    "One entity &#000126; is still a tilde",
    "Ошибка при запуске",
    "Σφάλμα κατά την εκκίνηση",
  ])("preserves ordinary user prose: %s", (description) => {
    const result = createFeedbackDraft(
      description,
      BUILD_BLOCK,
      DEFAULT_SUBJECT,
      REDACTED_VALUE,
    );
    expect(result.findings).toEqual([]);
    expect(result.draft.body).toContain(description);
  });

  it.each([
    "the app stopped now",
    "settings screen failed",
    "settings screen stopped now",
    "the app stopped responding again",
    "the app crashed when opening settings",
  ])("preserves ordinary editable-preview prose at both handoffs: %s", (body) => {
    const draft = { subject: DEFAULT_SUBJECT, body };
    const reviewed = reviewFeedbackDraft(draft, REDACTED_VALUE);
    expect(reviewed).toEqual({ draft, findings: [] });
    for (const channel of ["email", "github"] as const) {
      const handoff = buildFeedbackHandoffUrl(channel, draft, REDACTED_VALUE);
      expect(handoff.status).toBe("ready");
    }
  });

  it("revalidates edits and returns the changed preview instead of approving it", () => {
    const edited = reviewFeedbackDraft(
      {
        subject: "wallet failed",
        body: `Safe preview\npassword: added-after-preview\n${BUILD_BLOCK}`,
      },
      REDACTED_VALUE,
    );
    expect(edited.findings).toContain("secret-or-wallet-data");
    expect(edited.draft.body).not.toContain("added-after-preview");
  });
});

describe("feedback handoff", () => {
  const draft: FeedbackDraft = {
    subject: "Unicode + reserved ? & # / title",
    body: "Line one\nLínea dos 💡\n&body=fake#fragment",
  };

  it.each(["email", "github"] as const)(
    "encodes %s subject and body exactly once and preserves newlines",
    (channel) => {
      const result = buildFeedbackHandoffUrl(channel, draft, REDACTED_VALUE);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;

      if (channel === "email") {
        expect(result.url.startsWith(`mailto:${FEEDBACK_SUPPORT_EMAIL}?`)).toBe(true);
        expect(result.url).toContain("subject=Unicode%20%2B%20reserved");
        expect(result.url).not.toContain("subject=Unicode+");
        const fields = Object.fromEntries(
          result.url
            .slice(result.url.indexOf("?") + 1)
            .split("&")
            .map((field) => {
              const separator = field.indexOf("=");
              return [
                field.slice(0, separator),
                decodeURIComponent(field.slice(separator + 1)),
              ];
            }),
        );
        expect(fields.subject).toBe(draft.subject);
        expect(fields.body).toBe(draft.body);
      } else {
        expect(result.url.startsWith(`${FEEDBACK_GITHUB_NEW_ISSUE_URL}?`)).toBe(true);
      }
      const query = result.url.slice(result.url.indexOf("?") + 1);
      const parameters = new URLSearchParams(query);
      expect(parameters.get(channel === "email" ? "subject" : "title")).toBe(
        draft.subject,
      );
      expect(parameters.get("body")).toBe(draft.body);
      expect(parameters.get("body")).not.toContain("%25");
    },
  );

  it("rejects over-limit GitHub URLs without truncating the reviewed report", () => {
    const longDraft = { subject: "ZUULI feedback", body: "💡".repeat(700) };
    const result = buildFeedbackHandoffUrl(
      "github",
      longDraft,
      REDACTED_VALUE,
    );
    expect(result.status).toBe("too-long");
    expect(longDraft.body).toHaveLength(1_400);
    expect(feedbackDraftText(longDraft, SUBJECT_PREFIX)).toContain(
      longDraft.body,
    );
    if (result.status === "too-long") {
      expect(result.maximumCharacters).toBe(HANDOFF_URL_LIMIT.characters);
      expect(result.maximumBytes).toBe(HANDOFF_URL_LIMIT.bytes);
      expect(result.actualBytes).toBeGreaterThan(result.maximumBytes);
    }
  });
});
