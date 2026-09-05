/**
 * Creator ZEC tip — the destination snapshot, without a transport.
 *
 * In ZUULI this module's counterpart (`src/lib/wallet/creator-tip.ts`) issues a
 * nonce-keyed route state and the creator page navigates to
 * `/wallet/send/creator-tip`. That was the ONE import crossing from the social
 * surface into the wallet (#904), and it is the edge this app deliberately does
 * not have: there is no `/wallet` route here, no `zcash:*` capability, and no
 * plugin that could sign anything.
 *
 * So this validates the destination and stops. It does NOT invent a deep link,
 * and it must not grow one here: custom-scheme links are not an authenticated
 * channel, and #911 — the versioned intent protocol — deliberately ships no
 * transport either, because #461 (verified App Links / Universal Links) is a
 * hard prerequisite.
 *
 * ## Why this is not `createIntentSession` from `@free2z/wallet-shared`
 *
 * It will be. #911's `ExecutePayment` family is exactly this intent, and #905's
 * acceptance criterion — one implementation, no second copy — is the right one.
 * What is missing is an *amount*: `encodeExecutePaymentPayload` refuses
 * `amountZatoshis <= 0`, and neither ZUULI's tip dialog nor this one collects a
 * ZEC amount. ZUULI's own `creator-tip.ts` carries only `{username, label,
 * recipient}` for the same reason — the amount and the memo are entered on the
 * wallet's Send review screen, which is the surface that can show the payer what
 * they are approving. Minting an amount here to satisfy the encoder would be
 * inventing the number a human is supposed to choose.
 *
 * So this file holds the pre-request half only, and it holds it the way the
 * bridge's own session does — frozen, bounded, in memory. It declares none of
 * the five single-implementation names `project-boundary.mjs` reserves
 * (`INTENT_PROTOCOL_VERSION`, `createIntentSession`, `decodeIntentResponse`,
 * `encodeIntentRequest`, `parseVisibleText`), mints no label in the
 * `free2z/intent/v1/` namespace, and re-implements no encoder, no version gate
 * and no response matcher. When the ZEC amount is collected on this screen, the
 * `continueWithZec` handler calls the shared session and this file's validation
 * becomes its argument check — not a second protocol.
 *
 * The validation below is kept byte-for-byte equivalent to ZUULI's so the shape
 * that eventually crosses the bridge is the shape this surface already refuses
 * to malform — an unusable address fails here, in the renderer, rather than
 * reaching a signer.
 *
 * The snapshot lives in module memory only. Reloads lose it and fail closed;
 * creator payment details never enter web storage.
 */

// The same bound the bridge's own outstanding-question map uses
// (`MAX_PENDING_INTENTS` in wallet/shared/src/intent/session.ts). Kept as a
// local literal rather than an import so this app takes on no dependency for a
// number; it moves to the shared constant with the call that needs it.
const MAX_RECORDED_INTENTS = 32;

export interface CreatorTipIntent {
  readonly username: string;
  readonly label: string;
  readonly recipient: string;
}

const pendingCreatorTips: CreatorTipIntent[] = [];

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    codePointLength(value) <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

/** The same acceptance ZUULI applies before a tip may reach Wallet Send. */
export function isCreatorTipSource(value: CreatorTipIntent): boolean {
  return (
    isBoundedText(value.username, 150) &&
    isBoundedText(value.label, 128) &&
    isBoundedText(value.recipient, 255) &&
    !/\s/u.test(value.recipient)
  );
}

/**
 * Validate and retain a tip intent that cannot be executed on this surface.
 *
 * Throws for the same inputs ZUULI rejects, so the creator page's error path is
 * unchanged: a creator without a usable ZEC address is reported as such rather
 * than being offered a handoff that would fail later.
 */
export function recordCreatorTipIntent(
  source: CreatorTipIntent,
): CreatorTipIntent {
  if (!isCreatorTipSource(source)) {
    throw new Error("Creator ZEC tip details are missing or malformed");
  }

  const intent = Object.freeze({
    username: source.username,
    label: source.label,
    recipient: source.recipient,
  });
  pendingCreatorTips.push(intent);
  while (pendingCreatorTips.length > MAX_RECORDED_INTENTS) {
    pendingCreatorTips.shift();
  }
  return intent;
}

/** The intents recorded this session, oldest first. Bounded, never persisted. */
export function pendingCreatorTipIntents(): readonly CreatorTipIntent[] {
  return Object.freeze([...pendingCreatorTips]);
}

/** Drop every recorded intent (sign-out, and the test seam). */
export function clearCreatorTipIntents(): void {
  pendingCreatorTips.length = 0;
}
