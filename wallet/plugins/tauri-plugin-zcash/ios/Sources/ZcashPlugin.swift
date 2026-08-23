// SPDX-License-Identifier: MIT OR Apache-2.0

import Foundation
import LocalAuthentication
import Security
import SwiftRs
import Tauri
import UIKit

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

private struct SensitiveDisplayArgs: Decodable {
    let active: Bool
    let token: String
}

/// Tauri invokes plugin commands on its private serial IPC queue, while every
/// UIWindow operation below must execute on the main actor. This envelope is
/// created once, transferred to the main queue, and never touched again by the
/// command thread. `Invoke` itself predates Swift concurrency annotations, so
/// the narrow one-shot transfer is asserted here instead of declaring the
/// entire plugin or every Tauri invocation globally Sendable.
private final class SensitiveDisplayInvocation: @unchecked Sendable {
    let plugin: ZcashPlugin
    let invoke: Invoke
    let args: SensitiveDisplayArgs

    init(plugin: ZcashPlugin, invoke: Invoke, args: SensitiveDisplayArgs) {
        self.plugin = plugin
        self.invoke = invoke
        self.args = args
    }
}

final class ZcashPlugin: Plugin {
    private var sensitiveDisplayToken: String?
    private var obscuringViews: [ObjectIdentifier: UIView] = [:]
    private var sensitiveLifecycleObserversInstalled = false

    @objc func setSensitiveDisplay(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SensitiveDisplayArgs.self)
        guard !args.token.isEmpty else {
            reject(invoke, code: "unavailable", message: "sensitive-display token is missing")
            return
        }
        let request = SensitiveDisplayInvocation(plugin: self, invoke: invoke, args: args)
        DispatchQueue.main.async {
            request.plugin.applySensitiveDisplay(request)
        }
    }

    @MainActor
    private func applySensitiveDisplay(_ request: SensitiveDisplayInvocation) {
        let args = request.args
        let invoke = request.invoke
        if args.active {
            let previousToken = sensitiveDisplayToken
            sensitiveDisplayToken = args.token
            installSensitiveLifecycleObservers()
            let appIsInactive = UIApplication.shared.applicationState != .active
            // Pre-attach a hidden cover to every visible app window while the
            // lease begins. Lifecycle notifications can then obscure
            // synchronously without depending on a key window still being
            // discoverable during a scene transition.
            if !prepareSensitiveCovers(obscureAll: appIsInactive) {
                sensitiveDisplayToken = previousToken
                if previousToken == nil {
                    removeSensitiveLifecycleObservers()
                    removeSensitiveCovers()
                } else {
                    // A failed replacement must not dismantle the preceding
                    // lease while its renderer clear is still awaiting paint.
                    showSensitiveCovers()
                }
                invoke.reject("iOS sensitive cover could not be installed", code: "unavailable")
                return
            }
        } else if sensitiveDisplayToken == args.token {
            sensitiveDisplayToken = nil
            if UIApplication.shared.applicationState == .active {
                removeSensitiveLifecycleObservers()
                removeSensitiveCovers()
            } else {
                // Keep the background/recents cover until foreground. The
                // renderer's synchronous state clear may not have painted
                // before the OS snapshot was requested.
                showSensitiveCovers()
            }
        }
        // A stale release is intentionally a successful no-op: it does not
        // own the current protection lease.
        invoke.resolve()
    }

    @MainActor
    private func installSensitiveLifecycleObservers() {
        guard !sensitiveLifecycleObserversInstalled else { return }
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            UIApplication.willResignActiveNotification,
            UIApplication.didEnterBackgroundNotification,
            UIApplication.didBecomeActiveNotification,
            UIScreen.capturedDidChangeNotification,
            UIWindow.didBecomeVisibleNotification,
        ]
        names.forEach { name in
            center.addObserver(
                self,
                selector: #selector(sensitiveLifecycleChanged(_:)),
                name: name,
                object: nil
            )
        }
        sensitiveLifecycleObserversInstalled = true
    }

    @MainActor
    private func removeSensitiveLifecycleObservers() {
        guard sensitiveLifecycleObserversInstalled else { return }
        let center = NotificationCenter.default
        center.removeObserver(self, name: UIApplication.willResignActiveNotification, object: nil)
        center.removeObserver(self, name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.removeObserver(self, name: UIApplication.didBecomeActiveNotification, object: nil)
        center.removeObserver(self, name: UIScreen.capturedDidChangeNotification, object: nil)
        center.removeObserver(self, name: UIWindow.didBecomeVisibleNotification, object: nil)
        sensitiveLifecycleObserversInstalled = false
    }

    @objc @MainActor
    private func sensitiveLifecycleChanged(_ notification: Notification) {
        let name = notification.name
        if name == UIApplication.willResignActiveNotification ||
            name == UIApplication.didEnterBackgroundNotification {
            // Do not depend on applicationState having changed before the OS
            // asks for its background/recents snapshot.
            showSensitiveCovers()
        } else {
            updateSensitiveCovers()
        }
    }

    @MainActor
    private func updateSensitiveCovers() {
        guard sensitiveDisplayToken != nil else {
            if UIApplication.shared.applicationState == .active {
                removeSensitiveCovers()
                removeSensitiveLifecycleObservers()
            } else {
                showSensitiveCovers()
            }
            return
        }
        let appIsInactive = UIApplication.shared.applicationState != .active
        // A newly visible app window must join the same lease before it can
        // render sensitive material. Existing covers remain attached across
        // background scene transitions even when window discovery is empty.
        _ = prepareSensitiveCovers(obscureAll: appIsInactive)
    }

    @discardableResult
    @MainActor
    private func prepareSensitiveCovers(obscureAll: Bool) -> Bool {
        let windows = sensitiveAppWindows()
        guard !windows.isEmpty else { return false }
        for window in windows {
            let identifier = ObjectIdentifier(window)
            let cover: UIView
            if let existing = obscuringViews[identifier], existing.superview === window {
                cover = existing
            } else {
                let attached = UIView(frame: window.bounds)
                attached.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                attached.backgroundColor = .black
                attached.isUserInteractionEnabled = true
                attached.accessibilityLabel = "Sensitive wallet information hidden"
                attached.accessibilityViewIsModal = true
                window.addSubview(attached)
                guard attached.superview === window else { return false }
                obscuringViews[identifier] = attached
                cover = attached
            }
            cover.frame = window.bounds
            // Capture is screen-scoped. A secondary scene must not remain
            // visible merely because UIScreen.main belongs to an uncaptured
            // display; backgrounding still obscures every eligible window.
            let mustObscure = obscureAll || window.screen.isCaptured
            cover.isHidden = !mustObscure
            if mustObscure {
                window.bringSubviewToFront(cover)
            }
        }
        return windows.allSatisfy {
            obscuringViews[ObjectIdentifier($0)]?.superview === $0
        }
    }

    @MainActor
    private func showSensitiveCovers() {
        obscuringViews.values.forEach { cover in
            cover.isHidden = false
            cover.superview?.bringSubviewToFront(cover)
        }
    }

    @MainActor
    private func removeSensitiveCovers() {
        obscuringViews.values.forEach { $0.removeFromSuperview() }
        obscuringViews.removeAll()
    }

    @MainActor
    private func sensitiveAppWindows() -> [UIWindow] {
        UIApplication.shared.connectedScenes
            .compactMap { scene in scene as? UIWindowScene }
            .filter { scene in
                scene.activationState == .foregroundActive ||
                    scene.activationState == .foregroundInactive
            }
            .flatMap { scene in scene.windows }
            .filter { window in
                !window.isHidden && window.alpha > 0 && window.rootViewController != nil
            }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc func excludeDataFromBackup(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(DataPathArgs.self)
        var url = URL(fileURLWithPath: args.path, isDirectory: true)
        do {
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try url.setResourceValues(values)
            // Reconstruct the URL so verification cannot be satisfied by the
            // resource-value cache on the value that performed the write.
            let verificationURL = URL(fileURLWithPath: args.path, isDirectory: true)
            let stored = try verificationURL.resourceValues(forKeys: [.isExcludedFromBackupKey])
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
