/**
 * Installing the credential the wallet authority issued (#928, ADR 0016 §5).
 *
 * `./issueDeviceCredential.ts` ends with a credential's canonical bytes and,
 * until this module existed, nothing here could consume them. It works in an
 * app that holds no seed because ADR 0016 moved the seal at rest from the
 * seed-derived `BackupWrapKey` to a per-device key the engine samples itself.
 *
 * Both arguments are public: signed credential bytes, and the handle this
 * session asked for. A credential is signed under its own `identity_pk`, so it
 * is self-consistent no matter who minted it — comparing it against the handle
 * that was requested is the only authenticity check a first enrollment permits,
 * and the engine performs it.
 */

import { toHex } from "@free2z/wallet-shared";

import {
  EngineStatusSchema,
  EnrollmentStatusSchema,
  type EngineStatus,
  type EnrollmentStatus,
} from "../messaging/types";

/** The app-crate install command. No `plugin:` prefix — §2.2. */
export const INSTALL_DEVICE_CREDENTIAL_COMMAND = "e2e2z_install_device_credential";

/** The app-crate unlock-retry command. */
export const RETRY_DEVICE_UNLOCK_COMMAND = "e2e2z_retry_device_unlock";

/**
 * The install refused, or answered something that is not a status.
 *
 * Distinct from `DeviceKeysUnavailableError` because "the wallet would not
 * issue one" and "it issued one and this device refused it" want different
 * words in front of a user.
 */
export class DeviceCredentialInstallError extends Error {
  readonly reason = "device-credential-install-failed" as const;

  /** Declared, not `Error`'s ES2022 `options.cause`; this app compiles to ES2020. */
  readonly cause?: unknown;

  constructor(detail: string, options?: { cause?: unknown }) {
    super(`this device could not install the issued credential: ${detail}`);
    this.name = "DeviceCredentialInstallError";
    this.cause = options?.cause;
  }
}

/** Whether a caught value is a {@link DeviceCredentialInstallError}. */
export function isDeviceCredentialInstallError(
  error: unknown,
): error is DeviceCredentialInstallError {
  return (
    error instanceof DeviceCredentialInstallError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { reason?: unknown }).reason ===
        "device-credential-install-failed")
  );
}

/**
 * Parse the install command's response.
 *
 * App-crate commands sit outside the plugin's schema contract, so this checks
 * against the same schema the bridge uses for every other `EnrollmentStatus`.
 *
 * @throws {@link DeviceCredentialInstallError}
 */
export function parseInstallResult(value: unknown): EnrollmentStatus {
  const parsed = EnrollmentStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new DeviceCredentialInstallError(
      "the install command answered something that is not an enrollment status",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/** As {@link parseInstallResult}, for the unlock retry's `EngineStatus`. */
export function parseUnlockResult(value: unknown): EngineStatus {
  const parsed = EngineStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new DeviceCredentialInstallError(
      "the unlock retry answered something that is not an engine status",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/**
 * Install a credential the wallet authority issued for `expectedHandle`.
 *
 * The credential must be the one issued over the key set this process most
 * recently prepared: `prepare_device` is not idempotent, and a credential over
 * discarded keys is refused by the engine's `device_pk` binding.
 *
 * @throws {@link DeviceCredentialInstallError}
 */
export async function installDeviceCredential(
  credential: Uint8Array,
  expectedHandle: string,
): Promise<EnrollmentStatus> {
  if (credential.length === 0) {
    throw new DeviceCredentialInstallError("the credential is empty");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  let answer: unknown;
  try {
    answer = await invoke(INSTALL_DEVICE_CREDENTIAL_COMMAND, {
      args: { credential: toHex(credential), expectedHandle },
    });
  } catch (cause) {
    // f2zmsg errors arrive as a bare `ErrorCode` string, so the code is the
    // detail. Carried rather than summarised: a refused handle and a store that
    // would not open are different events.
    throw new DeviceCredentialInstallError(String(cause), { cause });
  }
  return parseInstallResult(answer);
}

/**
 * Re-ask this device's secret store for its wrap key and leave §6.1's `locked`.
 *
 * ADR 0016 §3 requires this app to have a seed-free exit; the one it replaced
 * was `f2zmsg_enroll` re-deriving the wrap key from the mnemonic, which only
 * ZUULI can do.
 *
 * @throws {@link DeviceCredentialInstallError}
 */
export async function retryDeviceUnlock(): Promise<EngineStatus> {
  const { invoke } = await import("@tauri-apps/api/core");
  let answer: unknown;
  try {
    answer = await invoke(RETRY_DEVICE_UNLOCK_COMMAND);
  } catch (cause) {
    throw new DeviceCredentialInstallError(String(cause), { cause });
  }
  return parseUnlockResult(answer);
}
