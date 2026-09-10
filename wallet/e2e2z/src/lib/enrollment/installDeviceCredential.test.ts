// @vitest-environment jsdom
//
// Installing the credential the wallet authority issued.
//
// jsdom because `@tauri-apps/api/core` reaches `window.__TAURI_INTERNALS__`,
// and these cases are for the shipping path: the real lazy import, the real
// command name, the real argument shape.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeviceCredentialInstallError,
  INSTALL_DEVICE_CREDENTIAL_COMMAND,
  RETRY_DEVICE_UNLOCK_COMMAND,
  installDeviceCredential,
  isDeviceCredentialInstallError,
  parseInstallResult,
  parseUnlockResult,
  retryDeviceUnlock,
} from "./installDeviceCredential";

const ENROLLED = {
  enrolled: true,
  handle: "alice",
  eligibility: { eligible: true, candidate: "alice", reason: null },
  directoryEntryVersion: null,
  submittedAt: 1_800_000_000_000,
  mergedAtEpoch: null,
  blocked: null,
};

const STOPPED = {
  state: "stopped",
  enrolled: true,
  handle: "alice",
  relaysConnected: 0,
  relaysConfigured: 0,
  witnessThresholdMet: false,
  independentWitnesses: 0,
  pendingInbound: 0,
  unacknowledgedAlarms: 0,
  lastError: null,
};

interface Call {
  readonly cmd: string;
  readonly args: unknown;
}

function installTauriHost(answer: (cmd: string) => unknown): Call[] {
  const calls: Call[] = [];
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    writable: true,
    value: {
      invoke(cmd: string, args: unknown) {
        calls.push({ cmd, args });
        return Promise.resolve(answer(cmd));
      },
    },
  });
  return calls;
}

afterEach(() => {
  Reflect.deleteProperty(
    window as unknown as Record<string, unknown>,
    "__TAURI_INTERNALS__",
  );
  vi.restoreAllMocks();
});

describe("the install command's arguments", () => {
  it("sends the credential as hex under the §3 args key, with the requested handle", async () => {
    const calls = installTauriHost(() => ENROLLED);

    const status = await installDeviceCredential(
      Uint8Array.from([0x00, 0x0f, 0xa0, 0xff]),
      "alice",
    );

    expect(status.enrolled).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe(INSTALL_DEVICE_CREDENTIAL_COMMAND);
    expect(calls[0]?.args).toEqual({
      args: { credential: "000fa0ff", expectedHandle: "alice" },
    });
  });

  // #928's fourth criterion, at the layer where a widening would be typed: a
  // wrap key here would put an account-scoped key in the renderer's heap. A
  // third argument is one line, and no other test would notice it.
  it("carries nothing beyond the credential and the requested handle", async () => {
    const calls = installTauriHost(() => ENROLLED);

    await installDeviceCredential(Uint8Array.from([1, 2, 3]), "alice");

    const payload = (calls[0]?.args as { args: Record<string, unknown> }).args;
    expect(Object.keys(payload).sort()).toEqual(["credential", "expectedHandle"]);
    for (const name of Object.keys(payload)) {
      expect(name.toLowerCase()).not.toContain("wrap");
      expect(name.toLowerCase()).not.toContain("seed");
      expect(name.toLowerCase()).not.toContain("identity");
    }
  });

  it("refuses an empty credential without reaching the host", async () => {
    const calls = installTauriHost(() => ENROLLED);

    await expect(
      installDeviceCredential(new Uint8Array(), "alice"),
    ).rejects.toBeInstanceOf(DeviceCredentialInstallError);
    expect(calls).toHaveLength(0);
  });

  it("carries the engine's refusal rather than summarising it", async () => {
    installTauriHost(() => {
      throw "handle-ineligible";
    });

    const error = await installDeviceCredential(
      Uint8Array.from([1]),
      "alice",
    ).catch((thrown: unknown) => thrown);

    expect(isDeviceCredentialInstallError(error)).toBe(true);
    expect((error as Error).message).toContain("handle-ineligible");
  });
});

describe("the unlock retry", () => {
  it("invokes the app-crate command with no arguments", async () => {
    const calls = installTauriHost(() => STOPPED);

    const status = await retryDeviceUnlock();

    expect(status.state).toBe("stopped");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe(RETRY_DEVICE_UNLOCK_COMMAND);
    expect(calls[0]?.args).toEqual({});
  });
});

describe("parsing what the commands answer", () => {
  it("accepts the engine's own shapes", () => {
    expect(parseInstallResult(ENROLLED).handle).toBe("alice");
    expect(parseUnlockResult(STOPPED).state).toBe("stopped");
  });

  // A status is a claim about the key-transparency directory, so a shape that
  // is nearly right is refused rather than widened into.
  it("refuses a status that is not one", () => {
    for (const answer of [
      null,
      "enrolled",
      {},
      { ...ENROLLED, enrolled: "yes" },
      { ...ENROLLED, handle: 17 },
    ]) {
      expect(() => parseInstallResult(answer)).toThrow(
        DeviceCredentialInstallError,
      );
    }
    for (const answer of [null, {}, { ...STOPPED, state: "melted" }]) {
      expect(() => parseUnlockResult(answer)).toThrow(
        DeviceCredentialInstallError,
      );
    }
  });
});
