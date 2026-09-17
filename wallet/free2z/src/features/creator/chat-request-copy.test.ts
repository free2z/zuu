/**
 * The chat request copy must be true in every shipped locale for every
 * outcome. Same shape as `tip-copy.test.ts`: the property that matters is that
 * no message claims nothing was charged unless this app can prove it.
 */

import { describe, expect, it } from "vitest";
import { createTestI18n } from "@/i18n/test-provider";
import { SUPPORTED_LOCALES } from "@/i18n/locale";
import type {
  ChatRequestOutcome,
  ChatRequestResult,
} from "@/lib/api/chat-request";
import { CHAT_REQUEST_COPY_STATES, chatRequestCopy } from "./chat-request-copy";

function result(bound: boolean): ChatRequestResult {
  return {
    balance: 9,
    charged: 1,
    replayed: false,
    requestId: "r",
    recipient: bound
      ? { username: "alice", handle: "alice", handleStatus: "bound" }
      : { username: "alice", handle: null, handleStatus: "unclaimed" },
  };
}

const OUTCOMES: ReadonlyArray<readonly [string, ChatRequestOutcome]> = [
  ["started/bound", { kind: "started", result: result(true) }],
  ["started/unclaimed", { kind: "started", result: result(false) }],
  ["insufficient", { kind: "insufficient", balance: 0 }],
  ["insufficient/no-balance", { kind: "insufficient", balance: null }],
  ["not-found", { kind: "not-found" }],
  ["self", { kind: "self" }],
  ["rate-limited", { kind: "rate-limited" }],
  ["signed-out", { kind: "signed-out" }],
  ["refused", { kind: "refused", status: 400 }],
  ["mismatch", { kind: "mismatch" }],
  ["uncertain", { kind: "uncertain" }],
];

const REASSURANCES: Record<string, readonly RegExp[]> = {
  en: [/nothing was charged/i, /not charged/i, /untouched/i, /no charge/i],
  es: [/no se cobró nada/i, /no se cobró/i, /intactos/i],
  fr: [/rien n'a été débité/i, /pas été débité/i, /intacts/i],
};

const VALUES = {
  username: "alice",
  cost: "1 2Z",
  charged: "1 2Z",
  balance: "0 2Z",
};

describe("every chat request outcome maps to copy", () => {
  it.each(OUTCOMES)("maps %s", (_label, outcome) => {
    expect(CHAT_REQUEST_COPY_STATES).toContain(chatRequestCopy(outcome));
  });

  it("says something different for each distinguishable situation", () => {
    const ids = CHAT_REQUEST_COPY_STATES.map((copy) => copy.id);
    const titles = CHAT_REQUEST_COPY_STATES.map((copy) => copy.titleKey);
    const bodies = CHAT_REQUEST_COPY_STATES.map((copy) => copy.bodyKey);
    expect(new Set(ids).size).toBe(CHAT_REQUEST_COPY_STATES.length);
    expect(new Set(titles).size).toBe(CHAT_REQUEST_COPY_STATES.length);
    expect(new Set(bodies).size).toBe(CHAT_REQUEST_COPY_STATES.length);
  });

  it("offers a link only when the recipient has a handle", () => {
    expect(
      chatRequestCopy({ kind: "started", result: result(true) }).id,
    ).toBe("connected");
    expect(
      chatRequestCopy({ kind: "started", result: result(false) }).id,
    ).toBe("awaiting-handle");
  });

  it("is certain only where the server refused before touching money", () => {
    const certain = OUTCOMES.filter(
      ([, outcome]) => chatRequestCopy(outcome).certainNothingWasCharged,
    ).map(([label]) => label);
    expect(certain.sort()).toEqual([
      "insufficient",
      "insufficient/no-balance",
      "not-found",
      "rate-limited",
      "signed-out",
    ]);
  });

  it("retries an unknown outcome as the same attempt, and only that", () => {
    const sameAttempt = OUTCOMES.filter(
      ([, outcome]) => chatRequestCopy(outcome).retry === "same-attempt",
    ).map(([label]) => label);
    expect(sameAttempt).toEqual(["uncertain"]);
    expect(chatRequestCopy({ kind: "mismatch" }).retry).toBeNull();
  });
});

describe("no chat message claims nothing was charged unless that is provable", () => {
  it.each(SUPPORTED_LOCALES)("holds for the shipped %s catalog", (locale) => {
    const i18n = createTestI18n(locale);
    const patterns = REASSURANCES[locale];
    expect(patterns, `no reassurance list for ${locale}`).toBeDefined();

    for (const [label, outcome] of OUTCOMES) {
      const copy = chatRequestCopy(outcome);
      if (copy.certainNothingWasCharged) continue;
      const rendered = `${i18n.t(copy.titleKey, VALUES)} ${i18n.t(copy.bodyKey, VALUES)}`;
      for (const pattern of patterns ?? []) {
        expect(
          pattern.test(rendered),
          `${locale} copy for ${label} claims no 2Z moved, which this app cannot prove: ${rendered}`,
        ).toBe(false);
      }
    }
  });

  it.each(SUPPORTED_LOCALES)(
    "the %s patterns really match a certain message, so the matcher is not inert",
    (locale) => {
      const i18n = createTestI18n(locale);
      const copy = chatRequestCopy({ kind: "not-found" });
      expect(copy.certainNothingWasCharged).toBe(true);
      const rendered = i18n.t(copy.bodyKey, VALUES);
      expect((REASSURANCES[locale] ?? []).some((p) => p.test(rendered))).toBe(
        true,
      );
    },
  );

  it.each(SUPPORTED_LOCALES)(
    "the %s uncertain copy names the payee and the cost",
    (locale) => {
      const i18n = createTestI18n(locale);
      const copy = chatRequestCopy({ kind: "uncertain" });
      const rendered = i18n.t(copy.bodyKey, VALUES);
      expect(rendered).toContain("@alice");
      expect(rendered).toContain("1 2Z");
    },
  );
});
