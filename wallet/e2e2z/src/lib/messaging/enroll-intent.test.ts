// @vitest-environment jsdom
//
// The negative control that matters most, run against the *best* case.
//
// `enrollment-gap.test.ts` proves `enroll` refuses when there is nowhere to
// send an intent. This file drives the whole path with a transport in place: a
// perfectly framed, correctly correlated `issue-device-credential` response
// carrying a credential, answered by a stand-in for the wallet authority.
//
// It used to prove `enroll` refuses even then, because nothing here could
// install a credential. ADR 0016 §5 changed that, so the property under test is
// the one that was always the point: **the only `EnrollmentStatus` this app can
// return is one the engine produced.** `docs/e2ee/CLIENT-CONTRACT.md` §2.4 is
// the rule — a rule that held only because the happy path was unreachable would
// have broken the day it opened.
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
import { INSTALL_DEVICE_CREDENTIAL_COMMAND } from "../enrollment/installDeviceCredential";
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

/** The status the stand-in engine answers an install with. */
const INSTALLED = {
  enrolled: true,
  handle: "alice",
  eligibility: { eligible: true, candidate: "alice", reason: null },
  directoryEntryVersion: null,
  submittedAt: 1_800_000_000_000,
  mergedAtEpoch: null,
  blocked: null,
};

interface HostCall {
  readonly cmd: string;
  readonly args: unknown;
}

/**
 * A stand-in for the native side. `install` picks what the install command
 * does: no such command, a refusal, or an install that answers with a status.
 */
function installTauriHost(
  install: "absent" | "refuse" | "accept" = "absent",
): HostCall[] {
  const calls: HostCall[] = [];
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    writable: true,
    value: {
      invoke(cmd: string, args: unknown) {
        calls.push({ cmd, args });
        if (cmd === DEVICE_CREDENTIAL_KEYS_COMMAND) {
          return Promise.resolve({
            devicePk: DEVICE_PK_HEX,
            deviceKemPk: KEM_HEX,
          });
        }
        if (cmd === INSTALL_DEVICE_CREDENTIAL_COMMAND && install === "accept") {
          return Promise.resolve(INSTALLED);
        }
        if (cmd === INSTALL_DEVICE_CREDENTIAL_COMMAND && install === "refuse") {
          return Promise.reject("handle-ineligible");
        }
        return Promise.reject(new Error(`Command ${cmd} not found`));
      },
    },
  });
  return calls;
}

/** The command names a run invoked, in order. */
function names(calls: readonly HostCall[]): string[] {
  return calls.map((call) => call.cmd);
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

    // …and it got that far by doing the real work, up to a host with no
    // install command.
    expect(names(invoked)).toEqual([
      DEVICE_CREDENTIAL_KEYS_COMMAND,
      INSTALL_DEVICE_CREDENTIAL_COMMAND,
    ]);
    expect(sent).toHaveLength(1);
    const decoded = decodeIntentRequest(sent[0] as Uint8Array);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.intent).toBe(IntentFamily.IssueDeviceCredential);
    expect(decoded.value.caller).toBe(E2E2Z_CALLER);
    expect(decoded.value.purpose).toBe(ISSUE_DEVICE_CREDENTIAL_PURPOSE);
  });

  it("never resolves to a status the engine refused to give", async () => {
    installTauriHost("refuse");
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

  it("installs the credential it received, for the handle it asked for", async () => {
    const calls = installTauriHost("accept");
    setIntentTransport({
      id: "wallet-stand-in",
      available: true,
      async dispatch(request) {
        const decoded = decodeIntentRequest(request);
        if (!decoded.ok) throw new Error("undecodable request");
        return fulfilled(decoded.value.requestId);
      },
    });

    const status = await enrollment.enroll("alice");

    // The status is the engine's, field for field. Nothing here composes one.
    expect(status).toEqual(INSTALLED);

    const install = calls.find(
      (call) => call.cmd === INSTALL_DEVICE_CREDENTIAL_COMMAND,
    );
    const args = (install?.args as { args: Record<string, unknown> }).args;
    // The credential that came back, and the handle this session asked for —
    // not one read out of the answer, which is #929's distinction.
    expect(args["credential"]).toBe("33".repeat(96));
    expect(args["expectedHandle"]).toBe("alice");
    expect(Object.keys(args).sort()).toEqual(["credential", "expectedHandle"]);
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
