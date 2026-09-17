/**
 * This device's public keys, read from the process that owns them.
 *
 * `docs/e2ee/ARCHITECTURE.md` §4.2: device keys come from the **OS CSPRNG**,
 * are **never seed-derived** and are **never exported**. All three clauses are
 * enforced by where the keys live, not by this file — the sampling happens in
 * `tauri_plugin_f2zmsg::engine::Engine::prepare_device`, the private halves
 * stay in that process, and `wallet/e2e2z/src-tauri/src/device.rs` returns only
 * the public halves. This module is the renderer's read of that result and
 * nothing more.
 *
 * **There is no `crypto.subtle` here and there must never be one.** A second
 * keypair generated in the renderer would be a second cryptographic
 * implementation in the least auditable process in the system, holding a
 * private key in a garbage-collected heap, and it would still have to be
 * smuggled back into the engine before a credential over it meant anything.
 * `src-tauri/src/device.rs` carries the long form of that argument.
 *
 * What this file *does* own is distrust of the answer. The command is
 * app-crate, so the response is not covered by the plugin's `ErrorCode`
 * contract or by any zod schema in `../messaging/types.ts`; it is parsed here,
 * to the exact shape `IssueDeviceCredentialRequestV2` needs
 * (`docs/intent-bridge/PROTOCOL.md` §3.3), and refused otherwise.
 *
 * ## The endpoint comes back with the keys, and it has to
 *
 * ADR 0017 §4.1: the directory entry that publishes this device carries the
 * relay-issued `contact_addr`, which only the device that opened the queue
 * knows — so the command opens the contact queue before it returns, and the
 * request carries the endpoint to the wallet authority. A build with no relay
 * refuses here, with `relay-unreachable`, rather than enrolling a device
 * nobody could reach.
 */

import {
  CONTACT_ENDPOINT_KEY_BYTES as ENDPOINT_KEY_BYTES,
  CONTACT_RELAY_SCHEME,
  fromHex,
} from "@free2z/wallet-shared";

/** The wire name of the app-crate command. No `plugin:` prefix — §2.2. */
export const DEVICE_CREDENTIAL_KEYS_COMMAND = "e2e2z_device_credential_keys";

/** `IssueDeviceCredentialRequestV2.device_pk` is `opaque[32]`. */
export const DEVICE_PUBLIC_KEY_BYTES = 32;

/** The public values an `issue-device-credential-v2` request carries. */
export interface DeviceCredentialKeys {
  /** `DSK.public` — the MLS leaf signature key, exactly 32 bytes. */
  readonly devicePublicKey: Uint8Array;
  /** The X-Wing hybrid KEM public key, opaque and non-empty. */
  readonly deviceKemPublicKey: Uint8Array;
  /** The relay this device's contact queue was opened at. `wss://`. */
  readonly contactRelayUrl: string;
  /** The relay identity that connection authenticated, exactly 32 bytes. */
  readonly contactRelayId: Uint8Array;
  /** The relay-issued contact address, exactly 32 bytes. */
  readonly contactAddr: Uint8Array;
}

/**
 * The answer was not the shape this app can build a request from.
 *
 * Its own class rather than a bare `Error` because the enrollment client has to
 * tell "the keys are unusable" from "there is nowhere to send them", and the
 * two want different words in front of a user.
 */
export class DeviceKeysUnavailableError extends Error {
  readonly reason = "device-keys-unavailable" as const;

  constructor(detail: string) {
    super(`this device's public keys could not be read: ${detail}`);
    this.name = "DeviceKeysUnavailableError";
  }
}

function requireHex(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string") {
    throw new DeviceKeysUnavailableError(`${field} is not a string`);
  }
  // `fromHex` refuses odd lengths, uppercase and non-hex, and it is the shared
  // implementation rather than a local regexp so that "what is hex" has one
  // answer in this app.
  try {
    return fromHex(value);
  } catch {
    throw new DeviceKeysUnavailableError(`${field} is not lowercase hex`);
  }
}

/**
 * Parse the command's response.
 *
 * Separate from the invoke so the hostile shapes can be tested without a Tauri
 * host: a missing field, a non-string, a short key, an empty KEM key. Each of
 * those would otherwise reach `encodeIssueDeviceCredentialPayload`, which does
 * refuse them — but it refuses with `INTENT_INVALID_VALUE`, which tells a user
 * nothing about *which* side was wrong.
 *
 * @throws {@link DeviceKeysUnavailableError}
 */
export function parseDeviceCredentialKeys(value: unknown): DeviceCredentialKeys {
  if (typeof value !== "object" || value === null) {
    throw new DeviceKeysUnavailableError("the response is not an object");
  }
  const record = value as Record<string, unknown>;
  const devicePublicKey = requireHex(record["devicePk"], "devicePk");
  const deviceKemPublicKey = requireHex(record["deviceKemPk"], "deviceKemPk");
  const contactRelayId = requireHex(record["contactRelayId"], "contactRelayId");
  const contactAddr = requireHex(record["contactAddr"], "contactAddr");
  const contactRelayUrl = record["contactRelayUrl"];
  if (devicePublicKey.length !== DEVICE_PUBLIC_KEY_BYTES) {
    throw new DeviceKeysUnavailableError(
      `devicePk is ${devicePublicKey.length} bytes, not ${DEVICE_PUBLIC_KEY_BYTES}`,
    );
  }
  if (deviceKemPublicKey.length === 0) {
    throw new DeviceKeysUnavailableError("deviceKemPk is empty");
  }
  if (typeof contactRelayUrl !== "string") {
    throw new DeviceKeysUnavailableError("contactRelayUrl is not a string");
  }
  // The scheme is checked here as well as in the encoder, because "this device
  // has no reachable address" and "this request is malformed" are different
  // things to tell a person (`./outcome.ts`).
  if (!contactRelayUrl.startsWith(CONTACT_RELAY_SCHEME)) {
    throw new DeviceKeysUnavailableError(
      "contactRelayUrl is not a wss:// relay",
    );
  }
  for (const [name, value] of [
    ["contactRelayId", contactRelayId],
    ["contactAddr", contactAddr],
  ] as const) {
    if (value.length !== ENDPOINT_KEY_BYTES) {
      throw new DeviceKeysUnavailableError(
        `${name} is ${value.length} bytes, not ${ENDPOINT_KEY_BYTES}`,
      );
    }
  }
  return {
    devicePublicKey,
    deviceKemPublicKey,
    contactRelayUrl,
    contactRelayId,
    contactAddr,
  };
}

/**
 * Sample this device's keys and read back their public halves.
 *
 * **Not idempotent.** Each call replaces the engine's pending device key set,
 * discards the previous secrets and opens a fresh contact queue —
 * `prepare_device_with_endpoint`'s contract. So the enrollment client calls
 * this only once it knows a request can actually be dispatched.
 *
 * The `@tauri-apps/api/core` import is lazy, matching `../messaging/bridge.ts`,
 * so the browser bundle never requires it.
 *
 * @throws {@link DeviceKeysUnavailableError}
 */
export async function readDeviceCredentialKeys(): Promise<DeviceCredentialKeys> {
  const { invoke } = await import("@tauri-apps/api/core");
  return parseDeviceCredentialKeys(await invoke(DEVICE_CREDENTIAL_KEYS_COMMAND));
}
