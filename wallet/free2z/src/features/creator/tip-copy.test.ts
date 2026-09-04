/**
 * The copy a payer is shown must be true, in every locale, for every outcome.
 *
 * This is the regression test for the defect the reviewer of #924 found: four
 * `CreatorTipFailure` kinds and three toast branches, so `unsendable` and
 * `transport-failed` fell through to "the wallet did not complete this payment"
 * — false when the wallet was never contacted at all.
 *
 * Two properties are asserted, and the second is the one that matters:
 *
 *   1. Every outcome maps to copy, and distinguishable situations get
 *      distinguishable copy.
 *   2. **No message may claim nothing was sent unless this app can prove it.**
 *      Asserted against the real shipped `en`/`es`/`fr` catalogs through a real
 *      i18next instance, not against key names — a reassuring sentence added to
 *      the wrong message by a later translation is exactly the failure that a
 *      key-level assertion sails past.
 */

import { describe, expect, it } from "vitest";
import { IntentErrorCode } from "@free2z/wallet-shared";
import { createTestI18n } from "@/i18n/test-provider";
import { SUPPORTED_LOCALES } from "@/i18n/locale";
import type { CreatorTipOutcome } from "@/lib/bridge/creator-tip";
import { CREATOR_TIP_COPY_STATES, creatorTipCopy } from "./tip-copy";

const OUTCOMES: ReadonlyArray<readonly [string, CreatorTipOutcome]> = [
  ["sent", { kind: "sent", txid: "ab".repeat(32) }],
  ["no-transport", { kind: "no-transport", reason: "no verified link (#461)" }],
  ["unsendable", { kind: "unsendable", error: IntentErrorCode.InvalidValue }],
  ["transport-failed", { kind: "transport-failed", detail: "TypeError" }],
  [
    "refused/NotConfirmed",
    { kind: "refused", error: IntentErrorCode.NotConfirmed },
  ],
  [
    "refused/Unavailable",
    { kind: "refused", error: IntentErrorCode.Unavailable },
  ],
  [
    "refused/Unsolicited",
    { kind: "refused", error: IntentErrorCode.Unsolicited },
  ],
  ["refused/Malformed", { kind: "refused", error: IntentErrorCode.Malformed }],
  ["refused/Expired", { kind: "refused", error: IntentErrorCode.Expired }],
] as const;

/**
 * Sentences that assert no money moved, per locale.
 *
 * Matched on the reassurance rather than on a key, deliberately: the hazard is
 * a translator — or a later edit — moving "nothing was sent" onto a message
 * shown when we do not know.
 */
const REASSURANCES: Record<string, readonly RegExp[]> = {
  en: [/nothing was sent/i, /never asked/i, /untouched/i, /nothing reached/i],
  es: [/no se envió nada/i, /nunca se le pidió/i, /intactos/i],
  fr: [/rien n'a été envoyé/i, /jamais été sollicité/i, /intacts/i],
};

const VALUES = { amount: "0.05 ZEC", creator: "Zooko", txid: "ab…cd" };

describe("every tip outcome maps to copy", () => {
  it.each(OUTCOMES)("maps %s", (_label, outcome) => {
    expect(CREATOR_TIP_COPY_STATES).toContain(creatorTipCopy(outcome));
  });

  it("says something different for each distinguishable situation", () => {
    const titles = CREATOR_TIP_COPY_STATES.map((copy) => copy.titleKey);
    const bodies = CREATOR_TIP_COPY_STATES.map((copy) => copy.bodyKey);
    expect(new Set(titles).size).toBe(CREATOR_TIP_COPY_STATES.length);
    expect(new Set(bodies).size).toBe(CREATOR_TIP_COPY_STATES.length);
  });

  it("never tells the payer the wallet declined when it was never asked", () => {
    // The exact false statement that prompted this test.
    const unsendable = creatorTipCopy({
      kind: "unsendable",
      error: IntentErrorCode.InvalidValue,
    });
    const declined = creatorTipCopy({
      kind: "refused",
      error: IntentErrorCode.NotConfirmed,
    });

    expect(unsendable.titleKey).not.toBe(declined.titleKey);
    expect(unsendable.bodyKey).not.toBe(declined.bodyKey);
  });

  it("treats an ambiguous broadcast as unknown, not as a refusal", () => {
    // `INTENT_UNAVAILABLE` is what ZUULI returns for every `BroadcastStatus`
    // but `Accepted` — including `Unknown`, where a transaction exists locally
    // and may or may not have reached the network.
    const unavailable = creatorTipCopy({
      kind: "refused",
      error: IntentErrorCode.Unavailable,
    });
    const declined = creatorTipCopy({
      kind: "refused",
      error: IntentErrorCode.NotConfirmed,
    });

    expect(unavailable.certainNothingWasSent).toBe(false);
    expect(declined.certainNothingWasSent).toBe(true);
    expect(unavailable.bodyKey).not.toBe(declined.bodyKey);
  });

  it("is certain only where certainty is earned", () => {
    const certain = OUTCOMES.filter(
      ([, outcome]) => creatorTipCopy(outcome).certainNothingWasSent,
    ).map(([label]) => label);

    expect(certain.sort()).toEqual([
      "no-transport",
      "refused/NotConfirmed",
      "unsendable",
    ]);
  });
});

describe("no message claims nothing was sent unless that is provable", () => {
  it.each(SUPPORTED_LOCALES)("holds for the shipped %s catalog", (locale) => {
    const i18n = createTestI18n(locale);
    const patterns = REASSURANCES[locale];
    expect(patterns, `no reassurance list for ${locale}`).toBeDefined();

    for (const [label, outcome] of OUTCOMES) {
      const copy = creatorTipCopy(outcome);
      if (copy.certainNothingWasSent) continue;
      const rendered = `${i18n.t(copy.titleKey, VALUES)} ${i18n.t(copy.bodyKey, VALUES)}`;
      for (const pattern of patterns ?? []) {
        expect(
          pattern.test(rendered),
          `${locale} copy for ${label} claims no funds moved, which this app cannot prove: ${rendered}`,
        ).toBe(false);
      }
    }
  });

  it("selected patterns that really do match, so the matcher is not inert", () => {
    // The negative control (#589's lesson): without it, a typo in every regex
    // above would leave this suite green while proving nothing.
    const i18n = createTestI18n("en");
    const declined = creatorTipCopy({
      kind: "refused",
      error: IntentErrorCode.NotConfirmed,
    });

    expect(declined.certainNothingWasSent).toBe(true);
    const rendered = i18n.t(declined.bodyKey, VALUES);
    expect((REASSURANCES.en ?? []).some((p) => p.test(rendered))).toBe(true);
  });
});
