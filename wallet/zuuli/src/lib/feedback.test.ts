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

      const handoff = buildFeedbackHandoffUrl(
        "github",
        { subject: DEFAULT_SUBJECT, body: `Observed failure: ${attack}` },
        REDACTED_VALUE,
      );
      expect(handoff.status).toBe("unsafe");
      expect("url" in handoff).toBe(false);
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
    "the app crashed when i opened settings and tried to go back",
    "THISISANERRORMESSAGE",
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
