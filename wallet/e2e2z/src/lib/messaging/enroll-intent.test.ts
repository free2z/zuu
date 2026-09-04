// @vitest-environment jsdom
//
// The negative control that matters most, run against the *best* case.
//
// `enrollment-gap.test.ts` proves `enroll` refuses when there is nowhere to
// send an intent. This file proves something stronger and less obvious: even
// when a transport exists, even when it answers with a perfectly framed,
// correctly correlated `issue-device-credential` response carrying a
// credential, `enroll` **still** refuses — because a `DeviceCredential` is not
// an `EnrollmentStatus`, and this app has no command that could install one.
//
// That is the shape of the mistake this whole boundary exists to prevent: a
// client that gets a plausible answer and renders itself enrolled. `docs/e2ee/
// CLIENT-CONTRACT.md` §2.4 states the rule — nothing in e2e2z may fabricate an
// `EnrollmentStatus` — and a rule that is only true because the happy path is
// unreachable is a rule that breaks the day the path opens.
//
// jsdom, because this exercises the shipping path end to end: the real lazy
// `@tauri-apps/api/core` import, the real app-crate command, the real shared
// encoder, and the real session.

import { afterEach, describe, expect, it } from "vitest";
import {
  INTENT_PROTOCOL_VERSION,
  IntentFamily,
  decodeIntentRequest,
} from "@free2z/wallet-shared";
import {
  E2E2Z_CALLER,
  ISSUE_DEVICE_CREDENTIAL_PURPOSE,
} from "../enrollment/issueDeviceCredential";
import {
  resetIntentTransport,
  setIntentTransport,
  type IntentTransport,
} from "../enrollment/transport";
import { DEVICE_CREDENTIAL_KEYS_COMMAND } from "../enrollment/deviceKeys";
import { EnrollmentUnavailableError, enrollment } from "./bridge";

const DEVICE_PK_HEX = "ab".repeat(32);
const KEM_HEX = "22".repeat(1216);
const CREDENTIAL = new Uint8Array(96).fill(0x33);

function be(value: number, width: number): number[] {
  const out: number[] = [];
  for (let shift = (width - 1) * 8; shift >= 0; shift -= 8) {
    out.push((value >>> shift) & 0xff);
  }
  return out;
}

/** A response the wallet authority would be entitled to send. */
function fulfilled(requestId: Uint8Array): Uint8Array {
  const payload = [...be(CREDENTIAL.length, 3), ...CREDENTIAL];
  const body = [
    ...requestId,
    ...be(IntentFamily.IssueDeviceCredential, 2),
    ...be(0, 2),
    ...be(payload.length, 3),
    ...payload,
  ];
  return Uint8Array.from([
    ...be(INTENT_PROTOCOL_VERSION, 2),
    ...be(body.length, 3),
    ...body,
  ]);
}

function installTauriHost(): string[] {
  const invoked: string[] = [];
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    writable: true,
    value: {
      invoke(cmd: string) {
        invoked.push(cmd);
        if (cmd === DEVICE_CREDENTIAL_KEYS_COMMAND) {
          return Promise.resolve({
            devicePk: DEVICE_PK_HEX,
            deviceKemPk: KEM_HEX,
          });
        }
        return Promise.reject(new Error(`Command ${cmd} not found`));
      },
    },
  });
  return invoked;
}

afterEach(() => {
  resetIntentTransport();
  Reflect.deleteProperty(
    window as unknown as Record<string, unknown>,
    "__TAURI_INTERNALS__",
  );
});

describe("enroll builds a real intent and still cannot enroll", () => {
  it("sends the wallet authority the request #905 specifies", async () => {
    const invoked = installTauriHost();
    const sent: Uint8Array[] = [];
    const transport: IntentTransport = {
      id: "wallet-stand-in",
      available: true,
      async dispatch(request) {
        sent.push(request);
        const decoded = decodeIntentRequest(request);
        if (!decoded.ok) throw new Error("undecodable request");
        return fulfilled(decoded.value.requestId);
      },
    };
    setIntentTransport(transport);

    // Still a rejection. The whole point.
    await expect(enrollment.enroll("alice")).rejects.toBeInstanceOf(
      EnrollmentUnavailableError,
    );

    // …and it got that far by doing the real work.
    expect(invoked).toEqual([DEVICE_CREDENTIAL_KEYS_COMMAND]);
    expect(sent).toHaveLength(1);
    const decoded = decodeIntentRequest(sent[0] as Uint8Array);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.intent).toBe(IntentFamily.IssueDeviceCredential);
    expect(decoded.value.caller).toBe(E2E2Z_CALLER);
    expect(decoded.value.purpose).toBe(ISSUE_DEVICE_CREDENTIAL_PURPOSE);
  });

  it("never resolves to an EnrollmentStatus even on a fulfilled response", async () => {
    installTauriHost();
    setIntentTransport({
      id: "wallet-stand-in",
      available: true,
      async dispatch(request) {
        const decoded = decodeIntentRequest(request);
        if (!decoded.ok) throw new Error("undecodable request");
        return fulfilled(decoded.value.requestId);
      },
    });
    const settled = await enrollment.enroll("alice").then(
      (value) => ({ resolved: true as const, value }),
      () => ({ resolved: false as const }),
    );
    expect(settled.resolved).toBe(false);
  });

  it("keeps the refusal typed, with the underlying cause attached", async () => {
    installTauriHost();
    const failure = new Error("the wallet never answered");
    setIntentTransport({
      id: "failing",
      available: true,
      dispatch: () => Promise.reject(failure),
    });
    const refusal = await enrollment
      .enroll("alice")
      .catch((cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(EnrollmentUnavailableError);
    // A bug report needs the real reason, not only the boundary's summary.
    expect((refusal as EnrollmentUnavailableError).cause).toBe(failure);
  });
});
