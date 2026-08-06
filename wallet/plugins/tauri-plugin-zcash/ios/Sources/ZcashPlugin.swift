// SPDX-License-Identifier: MIT OR Apache-2.0

import Foundation
import LocalAuthentication
import Security
import SwiftRs
import Tauri

private struct SeedKeyArgs: Decodable {
    let walletId: String
}

private struct StoreSeedArgs: Decodable {
    let walletId: String
    let phrase: String
}

private struct DataPathArgs: Decodable {
    let path: String
}

final class ZcashPlugin: Plugin {
    @objc func excludeDataFromBackup(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(DataPathArgs.self)
        let url = URL(fileURLWithPath: args.path, isDirectory: true)
        do {
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try url.setResourceValues(values)
            let stored = try url.resourceValues(forKeys: [.isExcludedFromBackupKey])
            guard stored.isExcludedFromBackup == true else {
                reject(invoke, code: "unavailable", message: "backup exclusion did not persist")
                return
            }
            invoke.resolve()
        } catch {
            reject(invoke, code: "unavailable", message: error.localizedDescription)
        }
    }

    @objc func storeSeed(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(StoreSeedArgs.self)
        guard let data = args.phrase.data(using: .utf8) else {
            reject(invoke, code: "corrupt", message: "seed is not valid UTF-8")
            return
        }

        var accessError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .userPresence,
            &accessError
        ) else {
            reject(invoke, code: "unavailable", message: accessError?.takeRetainedValue().localizedDescription ?? "access-control creation failed")
            return
        }

        let query = baseQuery(walletId: args.walletId)
        let updateStatus = SecItemUpdate(
            query as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if updateStatus == errSecSuccess {
            invoke.resolve()
            return
        }
        if updateStatus != errSecItemNotFound {
            reject(invoke, status: updateStatus)
            return
        }

        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessControl as String] = access
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecSuccess {
            invoke.resolve()
        } else {
            reject(invoke, status: status)
        }
    }

    @objc func getSeed(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SeedKeyArgs.self)
        let context = LAContext()
        context.localizedReason = "Authenticate to use the ZUULI wallet seed"

        var query = baseQuery(walletId: args.walletId)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecUseAuthenticationContext as String] = context

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else {
            reject(invoke, status: status)
            return
        }
        guard let data = result as? Data, let phrase = String(data: data, encoding: .utf8) else {
            reject(invoke, code: "corrupt", message: "Keychain seed record is not valid UTF-8")
            return
        }
        invoke.resolve(["phrase": phrase])
    }

    @objc func deleteSeed(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SeedKeyArgs.self)
        let status = SecItemDelete(baseQuery(walletId: args.walletId) as CFDictionary)
        if status == errSecSuccess {
            invoke.resolve()
        } else {
            reject(invoke, status: status)
        }
    }

    private func baseQuery(walletId: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "cash.free2z.zuuli.seed.v1",
            kSecAttrAccount as String: "seed_\(walletId)",
            // Prevent iCloud Keychain sync and device-backup restoration.
            kSecAttrSynchronizable as String: false
        ]
    }

    private func reject(_ invoke: Invoke, status: OSStatus) {
        let code: String
        switch status {
        case errSecItemNotFound:
            code = "not_found"
        case errSecUserCanceled:
            code = "auth_cancelled"
        case errSecAuthFailed:
            code = "auth_failed"
        case errSecInteractionNotAllowed:
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

@_cdecl("init_plugin_zcash")
func initPlugin() -> Plugin {
    ZcashPlugin()
}
