// @vitest-environment jsdom
//
// The renderer's read of this device's public keys.
//
// jsdom because `@tauri-apps/api/core` reaches `window.__TAURI_INTERNALS__`,
// and the point of the last two cases is that the *shipping* path — the real
// lazy import, the real command name, the real parse — is what runs, rather
// than an injected stand-in that would prove only that the injection works.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_CREDENTIAL_KEYS_COMMAND,
  DEVICE_PUBLIC_KEY_BYTES,
  DeviceKeysUnavailableError,
  parseDeviceCredentialKeys,
  readDeviceCredentialKeys,
} from "./deviceKeys";

const DEVICE_PK_HEX = "ab".repeat(DEVICE_PUBLIC_KEY_BYTES);
const KEM_HEX = "22".repeat(1216);

function installTauriHost(answer: (cmd: string) => unknown): string[] {
  const invoked: string[] = [];
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    writable: true,
    value: {
      invoke(cmd: string) {
        invoked.push(cmd);
        return Promise.resolve(answer(cmd));
      },
    },
  });
  return invoked;
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "__TAURI_INTERNALS__");
  vi.restoreAllMocks();
});

/** The endpoint the command opens before it answers (ADR 0017 §4.1). */
const ENDPOINT = {
  contactRelayUrl: "wss://relay.free2z.com/relay/v1",
  contactRelayId: "33".repeat(32),
  contactAddr: "44".repeat(32),
};

const ANSWER = { devicePk: DEVICE_PK_HEX, deviceKemPk: KEM_HEX, ...ENDPOINT };

describe("parsing this device's public keys", () => {
  it("accepts the shape the app-crate command returns", () => {
    const keys = parseDeviceCredentialKeys(ANSWER);
    expect(keys.devicePublicKey).toHaveLength(DEVICE_PUBLIC_KEY_BYTES);
    expect(keys.deviceKemPublicKey).toHaveLength(1216);
    expect(keys.contactRelayUrl).toBe(ENDPOINT.contactRelayUrl);
    expect(keys.contactRelayId).toHaveLength(32);
    expect(keys.contactAddr).toHaveLength(32);
  });

  it("refuses an endpoint a stranger could not reach this device at", () => {
    const rejected = [
      { ...ANSWER, contactRelayUrl: "ws://relay.free2z.com/relay/v1" },
      { ...ANSWER, contactRelayUrl: "https://relay.free2z.com" },
      { ...ANSWER, contactRelayUrl: 17 },
      { ...ANSWER, contactRelayId: "33".repeat(31) },
      { ...ANSWER, contactAddr: "44".repeat(33) },
      { ...ANSWER, contactAddr: "" },
    ];
    for (const value of rejected) {
      expect(() => parseDeviceCredentialKeys(value)).toThrow(
        DeviceKeysUnavailableError,
      );
    }
  });

  it("refuses every shape a request cannot be built from", () => {
    const rejected: unknown[] = [
      null,
      "not an object",
      {},
      { ...ENDPOINT, devicePk: DEVICE_PK_HEX },
      { ...ENDPOINT, deviceKemPk: KEM_HEX },
      { ...ENDPOINT, devicePk: 17, deviceKemPk: KEM_HEX },
      { ...ENDPOINT, devicePk: DEVICE_PK_HEX, deviceKemPk: null },
      // Uppercase and odd-length are not hex the shared parser accepts, and a
      // local regexp here would be a second answer to "what is hex".
      { ...ENDPOINT, devicePk: DEVICE_PK_HEX.toUpperCase(), deviceKemPk: KEM_HEX },
      { ...ENDPOINT, devicePk: "1".repeat(63), deviceKemPk: KEM_HEX },
      // Short, long, and empty keys are each a credential bound to the wrong
      // thing, so none of them may reach the encoder.
      { ...ENDPOINT, devicePk: "ab".repeat(31), deviceKemPk: KEM_HEX },
      { ...ENDPOINT, devicePk: "ab".repeat(33), deviceKemPk: KEM_HEX },
      { ...ENDPOINT, devicePk: DEVICE_PK_HEX, deviceKemPk: "" },
      // …and the endpoint fields are as required as the keys are.
      { devicePk: DEVICE_PK_HEX, deviceKemPk: KEM_HEX },
    ].map((value) =>
      typeof value === "object" && value !== null && "devicePk" in value
        ? value
        : value,
    );
    for (const value of rejected) {
      expect(() => parseDeviceCredentialKeys(value)).toThrow(DeviceKeysUnavailableError);
    }
  });

  it("never invents a key when a field is missing", () => {
    // The failure that would matter: returning zeroed bytes rather than
    // throwing, which would enroll a device nobody holds the private half of.
    let produced: unknown = null;
    try {
      produced = parseDeviceCredentialKeys({ ...ENDPOINT, deviceKemPk: KEM_HEX });
    } catch {
      produced = "refused";
    }
    expect(produced).toBe("refused");
  });
});

describe("reading them over IPC", () => {
  it("invokes exactly the app-crate command, with no arguments and no prefix", async () => {
    const invoked = installTauriHost(() => ({ ...ANSWER }));
    const keys = await readDeviceCredentialKeys();
    expect(invoked).toEqual([DEVICE_CREDENTIAL_KEYS_COMMAND]);
    // §2.2: app-crate commands carry no `plugin:` prefix and need no capability
    // entry. A `plugin:` prefix here would mean this had been moved onto the
    // messaging plugin's IPC surface, which is the population CLIENT-CONTRACT
    // §3 pins.
    expect(DEVICE_CREDENTIAL_KEYS_COMMAND.startsWith("plugin:")).toBe(false);
    expect(keys.devicePublicKey[0]).toBe(0xab);
  });

  it("refuses a host that answers with the wrong shape", async () => {
    installTauriHost(() => ({ ...ANSWER, devicePk: undefined, secretKey: "oh no" }));
    await expect(readDeviceCredentialKeys()).rejects.toBeInstanceOf(
      DeviceKeysUnavailableError,
    );
  });
});
