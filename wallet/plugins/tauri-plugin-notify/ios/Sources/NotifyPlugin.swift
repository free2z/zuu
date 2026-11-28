import Foundation
import Security
import SwiftRs
import Tauri
import UIKit
import UserNotifications
import WebKit
import ObjectiveC

private struct SaveArgs: Decodable { let lease: String; let revision: String }
private struct RevisionArgs: Decodable { let revision: String }
private struct ConsumeArgs: Decodable { let pending: String; let revision: String }

/// All state lives in a device-only Keychain item, never UserDefaults, URLs or logs.
/// Notification callbacks only buffer one untrusted, bounded envelope. Rust verifies it
/// when the app is open; no wallet/key access, network fetch or background spend.
final class NotifyPlugin: Plugin {
    private static weak var current: NotifyPlugin?
    private let service = "cash.free2z.zuuli.notify.v1"
    private var hooksReady = false
    private var permission = "denied"
    private var requestRevision: String?

    private func read() -> [String: String] {
        let q: [String: Any] = [kSecClass as String:kSecClassGenericPassword,
            kSecAttrService as String:service, kSecAttrAccount as String:"state",
            kSecReturnData as String:true]
        var value: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &value) == errSecSuccess,
            let data = value as? Data, data.count <= 24576,
            let object = try? JSONSerialization.jsonObject(with:data) as? [String:String] else { return [:] }
        return object
    }
    @discardableResult private func write(_ state: [String:String]) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject:state), data.count <= 24576 else { return false }
        let q: [String:Any] = [kSecClass as String:kSecClassGenericPassword,
            kSecAttrService as String:service,kSecAttrAccount as String:"state"]
        let attributes: [String:Any] = [kSecValueData as String:data,
            kSecAttrAccessible as String:kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(q as CFDictionary,attributes as CFDictionary)
        if status == errSecItemNotFound { return SecItemAdd(q.merging(attributes) {_,v in v} as CFDictionary,nil) == errSecSuccess }
        return status == errSecSuccess
    }
    private func snapshotValue() -> [String:Any] {
        let state = read()
        var result: [String:Any] = ["permission":permission,"token":state["token"] ?? "", "enabled":state["enabled"] == "1", "revision":NotificationRecord.revision(state)]
        if let lease = state["lease"] { result["lease"] = lease }
        if let pending = state["pending"] { result["pending"] = pending }
        return result
    }
    private func activeLease(_ state: [String:String]) -> Bool { NotificationRecord.active(state) }
    private func registerToken(revision: String) {
        guard activeLease(read()), NotificationRecord.revision(read()) == revision else { return }
        requestRevision=revision
        UIApplication.shared.registerForRemoteNotifications()
    }
    private func buffer(_ info: [AnyHashable:Any]) {
        var state = read()
        guard activeLease(state), let value = info["wake"] as? [String:String],
            Set(value.keys) == Set(["queue","generation","sequence","expires","signature"]),
            value.values.allSatisfy({$0.utf8.count <= 128}),
            let data = try? JSONSerialization.data(withJSONObject:value), data.count <= 1024,
            let pending = String(data:data,encoding:.utf8) else { return }
        state["pending"] = pending; write(state)
    }
    /// Tauri's UIApplicationDelegate currently has no APNs forwarding hooks. Add only
    /// missing methods to its actual class; never replace an existing handler. A host
    /// with another notification plugin fails closed instead of stealing its delegate.
    private func installCallbacks() -> Bool {
        guard let delegate = UIApplication.shared.delegate, let cls = object_getClass(delegate) else { return false }
        let tokenSelector = NSSelectorFromString("application:didRegisterForRemoteNotificationsWithDeviceToken:")
        let failedSelector = NSSelectorFromString("application:didFailToRegisterForRemoteNotificationsWithError:")
        let wakeSelector = NSSelectorFromString("application:didReceiveRemoteNotification:fetchCompletionHandler:")
        guard !delegate.responds(to:tokenSelector), !delegate.responds(to:failedSelector), !delegate.responds(to:wakeSelector) else { return false }
        let token: @convention(block) (AnyObject, UIApplication, Data) -> Void = { _,_,data in
            guard let plugin = NotifyPlugin.current else { return }
            var state = plugin.read()
            guard let revision=plugin.requestRevision else { return }
            if NotificationRecord.token(&state,expected:revision,token:data.map { String(format:"%02x",$0) }.joined()), plugin.write(state) {
                plugin.trigger("changed",data:[:])
            }
        }
        let failed: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { _,_,_ in
            guard let plugin = NotifyPlugin.current else { return }
            var state = plugin.read()
            guard plugin.requestRevision == NotificationRecord.revision(state), NotificationRecord.active(state) else { return }
            state.removeValue(forKey:"token"); plugin.write(state)
        }
        let wake: @convention(block) (AnyObject, UIApplication, NSDictionary, @escaping (UIBackgroundFetchResult)->Void) -> Void = { _,_,info,done in
            NotifyPlugin.current?.buffer(info as? [AnyHashable:Any] ?? [:]); done(.noData)
        }
        return class_addMethod(cls,tokenSelector,imp_implementationWithBlock(token),"v@:@@")
            && class_addMethod(cls,failedSelector,imp_implementationWithBlock(failed),"v@:@@")
            && class_addMethod(cls,wakeSelector,imp_implementationWithBlock(wake),"v@:@@@?")
    }
    override func load(webview: WKWebView) {
        DispatchQueue.main.async {
            NotifyPlugin.current = self; self.hooksReady = self.installCallbacks()
        }
    }
    // Rust calls resume only after validating private acceptance configuration.
    // Loading a public/unconfigured build never registers with APNs.
    @objc func resume(_ invoke: Invoke) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                self.permission = settings.authorizationStatus == .authorized ? "granted" : "denied"
                if self.activeLease(self.read()) && self.hooksReady && self.permission == "granted" {
                    self.registerToken(revision:NotificationRecord.revision(self.read()))
                }
                invoke.resolve([:])
            }
        }
    }
    @objc func snapshot(_ invoke: Invoke) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                self.permission = settings.authorizationStatus == .authorized ? "granted" : "denied"
                invoke.resolve(self.snapshotValue())
            }
        }
    }
    @objc func begin(_ invoke: Invoke) throws {
        let args=try invoke.parseArgs(SaveArgs.self)
        DispatchQueue.main.async {
            do {
                var state=self.read(); try NotificationRecord.begin(&state,expected:args.revision,text:args.lease)
                guard self.write(state) else { invoke.reject("unavailable"); return }
                invoke.resolve([:])
            } catch { invoke.reject("unavailable") }
        }
    }
    @objc func start(_ invoke: Invoke) throws {
        let args=try invoke.parseArgs(RevisionArgs.self)
        DispatchQueue.main.async {
            guard self.hooksReady, self.activeLease(self.read()), NotificationRecord.revision(self.read()) == args.revision else { invoke.reject("unavailable"); return }
            UNUserNotificationCenter.current().requestAuthorization(options:[.alert]) { granted,_ in
                DispatchQueue.main.async {
                    guard self.activeLease(self.read()), NotificationRecord.revision(self.read()) == args.revision else { invoke.reject("unavailable"); return }
                    self.permission = granted ? "granted" : "denied"
                    if granted { self.registerToken(revision:args.revision) }
                    invoke.resolve(self.snapshotValue())
                }
            }
        }
    }
    @objc func payment(_ invoke: Invoke) {
        DispatchQueue.main.async {
            guard self.activeLease(self.read()) else { invoke.resolve([:]); return }
            let content = UNMutableNotificationContent()
            content.title = "ZUULI"
            content.body = NSLocalizedString("walletActivity", bundle: .module, comment: "Generic verified wallet activity")
            // No amounts, addresses, memos, badge count, sound or transaction IDs.
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier:"wallet-activity",content:content,trigger:nil)) { _ in invoke.resolve([:]) }
        }
    }
    @objc func save(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SaveArgs.self)
        DispatchQueue.main.async {
            do {
                var state=self.read(); try NotificationRecord.save(&state,expected:args.revision,text:args.lease)
                if self.write(state) { invoke.resolve([:]) } else { invoke.reject("unavailable") }
            } catch { invoke.reject("unavailable") }
        }
    }
    @objc func stop(_ invoke: Invoke) {
        DispatchQueue.main.async {
            do {
                var state=self.read(); try NotificationRecord.stop(&state)
                guard self.write(state) else { invoke.reject("unavailable"); return }
                self.requestRevision=nil
                UIApplication.shared.unregisterForRemoteNotifications()
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers:["wallet-activity"])
                UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers:["wallet-activity"])
                invoke.resolve([:])
            } catch { invoke.reject("unavailable") }
        }
    }
    @objc func clear(_ invoke: Invoke) throws {
        let args=try invoke.parseArgs(RevisionArgs.self)
        DispatchQueue.main.async {
            do {
                var state=self.read(); try NotificationRecord.clear(&state,expected:args.revision)
                if self.write(state) { invoke.resolve([:]) } else { invoke.reject("unavailable") }
            } catch { invoke.reject("unavailable") }
        }
    }
    @objc func consume(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ConsumeArgs.self)
        DispatchQueue.main.async {
            var state = self.read()
            guard NotificationRecord.revision(state) == args.revision, NotificationRecord.active(state) else { invoke.reject("unavailable"); return }
            if state["pending"] == args.pending { state.removeValue(forKey:"pending") }
            if self.write(state) { invoke.resolve([:]) } else { invoke.reject("unavailable") }
        }
    }
}
@_cdecl("init_plugin_notify")
func initPlugin() -> Plugin { NotifyPlugin() }
