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
      const result = buildFeedbackHandoffUrl(channel, draft);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;

      if (channel === "email") {
        expect(result.url.startsWith(`mailto:${FEEDBACK_SUPPORT_EMAIL}?`)).toBe(true);
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
    const result = buildFeedbackHandoffUrl("github", longDraft);
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
