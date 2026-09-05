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

describe("parsing this device's public keys", () => {
  it("accepts the shape the app-crate command returns", () => {
    const keys = parseDeviceCredentialKeys({
      devicePk: DEVICE_PK_HEX,
      deviceKemPk: KEM_HEX,
    });
    expect(keys.devicePublicKey).toHaveLength(DEVICE_PUBLIC_KEY_BYTES);
    expect(keys.deviceKemPublicKey).toHaveLength(1216);
  });

  it("refuses every shape a request cannot be built from", () => {
    const rejected: unknown[] = [
      null,
      "not an object",
      {},
      { devicePk: DEVICE_PK_HEX },
      { deviceKemPk: KEM_HEX },
      { devicePk: 17, deviceKemPk: KEM_HEX },
      { devicePk: DEVICE_PK_HEX, deviceKemPk: null },
      // Uppercase and odd-length are not hex the shared parser accepts, and a
      // local regexp here would be a second answer to "what is hex".
      { devicePk: DEVICE_PK_HEX.toUpperCase(), deviceKemPk: KEM_HEX },
      { devicePk: "1".repeat(63), deviceKemPk: KEM_HEX },
      // Short, long, and empty keys are each a credential bound to the wrong
      // thing, so none of them may reach the encoder.
      { devicePk: "ab".repeat(31), deviceKemPk: KEM_HEX },
      { devicePk: "ab".repeat(33), deviceKemPk: KEM_HEX },
      { devicePk: DEVICE_PK_HEX, deviceKemPk: "" },
    ];
    for (const value of rejected) {
      expect(() => parseDeviceCredentialKeys(value)).toThrow(DeviceKeysUnavailableError);
    }
  });

  it("never invents a key when a field is missing", () => {
    // The failure that would matter: returning zeroed bytes rather than
    // throwing, which would enroll a device nobody holds the private half of.
    let produced: unknown = null;
    try {
      produced = parseDeviceCredentialKeys({ deviceKemPk: KEM_HEX });
    } catch {
      produced = "refused";
    }
    expect(produced).toBe("refused");
  });
});

describe("reading them over IPC", () => {
  it("invokes exactly the app-crate command, with no arguments and no prefix", async () => {
    const invoked = installTauriHost(() => ({
      devicePk: DEVICE_PK_HEX,
      deviceKemPk: KEM_HEX,
    }));
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
    installTauriHost(() => ({ devicePk: DEVICE_PK_HEX, secretKey: "oh no" }));
    await expect(readDeviceCredentialKeys()).rejects.toBeInstanceOf(
      DeviceKeysUnavailableError,
    );
  });
});
