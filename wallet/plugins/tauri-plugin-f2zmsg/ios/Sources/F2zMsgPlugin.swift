// SPDX-License-Identifier: MIT OR Apache-2.0
//
// iOS custody for the per-device `DeviceWrapKey` (ADR 0016 §3, issue #937).
//
// This plugin holds ONE kind of secret: a 32-byte device-local wrap key, hex
// encoded. It never sees a mnemonic, a seed, or anything derived from one —
// that is `tauri-plugin-zcash`'s ZcashPlugin, in a crate `cash.free2z.e2e2z`
// deliberately does not link.
//
// # The accessibility class is the decision
//
// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, and every word of it is
// chosen. The long form of the reasoning is in `src/custody.rs` §2; the short
// form, kept here because this is the line a reviewer will actually look at:
//
//   * NOT `WhenUnlocked` — the wrap key is opened by the inbound relay poll and
//     by background delivery, which run with the screen locked. `WhenUnlocked`
//     would make the seal unopenable exactly when there is work to do, and an
//     engine that cannot open its wrap key is one auto-re-enroll away from
//     minting a directory entry the user must be warned about (ADR 0016 §3.5).
//
//   * `AfterFirstUnlock` — readable from the user's first unlock after boot
//     until power-off. That is the window background work happens in. Between a
//     cold boot and the first unlock the item is genuinely unavailable and the
//     engine stays `locked`; that is correct, and it is why `locked` must have
//     a retry rather than an automatic re-enrollment.
//
//   * `ThisDeviceOnly` — `docs/e2ee/ARCHITECTURE.md` §4.2 says device keys are
//     "never exported". Without this suffix the item joins iCloud Keychain and
//     an encrypted device backup, so restoring onto new hardware would hand a
//     second machine the first machine's device identity while the directory
//     still believes there is one device.
//
//   * No `SecAccessControl`, no `.userPresence`, no `LAContext` — a biometric
//     prompt cannot be answered from a background task. ZcashPlugin requires
//     presence for the seed and is right to; requiring it here would trade all
//     background delivery for a guard on a key that only signs as this device.
//
// # What this file does not claim
//
// The Simulator's keychain does not enforce accessibility classes the way a
// device's Secure Enclave-backed one does. Nothing here has been observed on
// real hardware, and the pull request says so rather than implying a green
// build is evidence.

import Foundation
import Security
import SwiftRs
import Tauri

private struct ServiceArgs: Decodable {
    let service: String
}

private struct AccountArgs: Decodable {
    let service: String
    let account: String
}

private struct StoreArgs: Decodable {
    let service: String
    let account: String
    let value: String
}

final class F2zMsgPlugin: Plugin {
    /// Report the custody backing for the log. iOS has exactly one answer;
    /// the command exists so the Rust side can ask both platforms the same
    /// question (Android's answer varies per handset).
    @objc func custodyBacking(_ invoke: Invoke) throws {
        _ = try invoke.parseArgs(ServiceArgs.self)
        invoke.resolve(["backing": "keychain"])
    }

    @objc func storeWrapKey(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(StoreArgs.self)
        guard !args.service.isEmpty, !args.account.isEmpty else {
            reject(invoke, code: "unavailable", message: "custody service and account are required")
            return
        }
        guard let data = args.value.data(using: .utf8) else {
            reject(invoke, code: "corrupt", message: "the wrap key is not valid UTF-8")
            return
        }

        let query = baseQuery(service: args.service, account: args.account)

        // Update first, then add. `SecItemAdd` on an existing item is
        // `errSecDuplicateItem`, and the accessibility attribute of an existing
        // item is NOT changed by an update — so an item written by an older
        // build under a different class would keep it. There is no such older
        // build (nothing has shipped), and if one ever exists the fix is a
        // delete-then-add migration, not a silent update.
        let updated = SecItemUpdate(
            query as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if updated == errSecSuccess {
            invoke.resolve()
            return
        }
        if updated != errSecItemNotFound {
            reject(invoke, status: updated)
            return
        }

        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecSuccess {
            invoke.resolve()
        } else {
            reject(invoke, status: status)
        }
    }

    @objc func getWrapKey(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(AccountArgs.self)
        guard !args.service.isEmpty, !args.account.isEmpty else {
            reject(invoke, code: "unavailable", message: "custody service and account are required")
            return
        }
        var query = baseQuery(service: args.service, account: args.account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else {
            reject(invoke, status: status)
            return
        }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            reject(invoke, code: "corrupt", message: "the stored wrap key is not valid UTF-8")
            return
        }
        invoke.resolve(["value": value])
    }

    @objc func deleteWrapKey(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(AccountArgs.self)
        guard !args.service.isEmpty, !args.account.isEmpty else {
            reject(invoke, code: "unavailable", message: "custody service and account are required")
            return
        }
        let status = SecItemDelete(
            baseQuery(service: args.service, account: args.account) as CFDictionary
        )
        if status == errSecSuccess {
            invoke.resolve()
        } else {
            reject(invoke, status: status)
        }
    }

    /// The item's identity. `service` is the host application's namespace, so
    /// ZUULI and e2e2z address different items even though this code is the
    /// same code in both binaries (`src/custody.rs` §1).
    private func baseQuery(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            // Never iCloud Keychain: a device key that syncs is not a device
            // key (ARCHITECTURE.md §4.2).
            kSecAttrSynchronizable as String: false
        ]
    }

    /// `OSStatus` in the vocabulary `src/custody_mobile.rs` classifies.
    private func reject(_ invoke: Invoke, status: OSStatus) {
        let code: String
        switch status {
        case errSecItemNotFound:
            code = "not_found"
        case errSecInteractionNotAllowed:
            // The device has not been unlocked since boot. Transient, and
            // distinct from "there is no keychain" — the engine may retry.
            code = "locked"
        case errSecDecode:
            code = "corrupt"
        case errSecNotAvailable:
            code = "unavailable"
        default:
            code = "backend"
        }
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)"
        reject(invoke, code: code, message: message)
    }

    private func reject(_ invoke: Invoke, code: String, message: String) {
        invoke.reject(message, code: code)
    }
}

@_cdecl("init_plugin_f2zmsg")
func initPlugin() -> Plugin {
    F2zMsgPlugin()
}
