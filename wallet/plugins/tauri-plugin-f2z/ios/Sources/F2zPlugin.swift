// SPDX-License-Identifier: MIT
import AuthenticationServices
import Foundation
import Tauri
import UIKit
import WebKit

private struct RedirectArgs: Decodable { let https: String?; let privateScheme: String? }
private struct AuthArgs: Decodable { let attemptId: String; let url: String; let redirectUri: String; let timeoutMs: UInt64 }
private struct CancelArgs: Decodable { let attemptId: String }
private struct BrowserArgs: Decodable { let url: String }

/// Native-only commands. They are intentionally absent from the webview ACL registry.
final class F2zPlugin: Plugin, ASWebAuthenticationPresentationContextProviding {
    private weak var webview: WKWebView?
    override func load(webview: WKWebView) { self.webview = webview }
    private var auth: ASWebAuthenticationSession?
    private var pending: Invoke?
    private var attempt: String?
    private var timeout: DispatchWorkItem?
    private var anchor: UIWindow?

    private func redirectURL(_ value: String) -> URL? {
        guard let url = URL(string: value), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.query == nil, parts.fragment == nil, parts.user == nil, parts.password == nil,
              let scheme = parts.scheme, !parts.path.isEmpty else { return nil }
        if scheme == "https" { return parts.host == nil ? nil : url }
        guard scheme.contains("."), scheme != "http", scheme != "https" else { return nil }
        return url
    }
    @objc public func redirect(_ invoke: Invoke) {
        do {
            let args = try invoke.parseArgs(RedirectArgs.self)
            if #available(iOS 17.4, *), let value = args.https, let url = redirectURL(value), url.scheme == "https" {
                invoke.resolve(["uri": value]); return
            }
            guard let value = args.privateScheme, let url = redirectURL(value), url.scheme != "https" else { invoke.reject("callback configuration unavailable"); return }
            invoke.resolve(["uri": value])
        } catch { invoke.reject("invalid callback configuration") }
    }
    private func finish(_ id: String, url: URL?, expected: URL, state: String) {
        guard attempt == id, let invoke = pending else { return }
        timeout?.cancel(); timeout = nil; pending = nil; attempt = nil; auth = nil; anchor = nil
        guard let url, CallbackPolicy.accepts(url, expected: expected, state: state) else {
            invoke.reject("authentication cancelled or invalid callback"); return
        }
        invoke.resolve(["url": url.absoluteString])
    }
    @objc public func authorize(_ invoke: Invoke) {
        DispatchQueue.main.async {
            do {
                let args = try invoke.parseArgs(AuthArgs.self)
                guard self.pending == nil, let url = URL(string: args.url), url.scheme == "https",
                      let redirect = self.redirectURL(args.redirectUri),
                      let state = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "state" })?.value,
                      !state.isEmpty, args.timeoutMs > 0, args.timeoutMs <= 300000,
                      let window = self.webview?.window else { invoke.reject("authentication unavailable"); return }
                self.anchor = window
                let completion: ASWebAuthenticationSession.CompletionHandler = { callback, _ in
                    DispatchQueue.main.async { self.finish(args.attemptId, url: callback, expected: redirect, state: state) }
                }
                let session: ASWebAuthenticationSession
                if #available(iOS 17.4, *), redirect.scheme == "https", let host = redirect.host {
                    session = ASWebAuthenticationSession(url: url, callback: .https(host: host, path: redirect.path), completionHandler: completion)
                } else {
                    guard redirect.scheme != "https" else { invoke.reject("HTTPS callbacks require iOS 17.4"); return }
                    session = ASWebAuthenticationSession(url: url, callbackURLScheme: redirect.scheme, completionHandler: completion)
                }
                session.presentationContextProvider = self
                self.pending = invoke; self.attempt = args.attemptId; self.auth = session
                let expiry = DispatchWorkItem { [weak self] in
                    guard let self, self.attempt == args.attemptId else { return }
                    self.auth?.cancel(); self.finish(args.attemptId, url: nil, expected: redirect, state: state)
                }
                self.timeout = expiry
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(args.timeoutMs)), execute: expiry)
                if !session.start() { self.finish(args.attemptId, url: nil, expected: redirect, state: state) }
            } catch { invoke.reject("invalid authentication request") }
        }
    }
    @objc public func cancelAuth(_ invoke: Invoke) {
        do {
            let args = try invoke.parseArgs(CancelArgs.self)
            DispatchQueue.main.async {
                if self.attempt == args.attemptId {
                    self.timeout?.cancel(); self.timeout = nil
                    let pending = self.pending; self.pending = nil; self.attempt = nil
                    self.auth?.cancel(); self.auth = nil; self.anchor = nil; pending?.reject("authentication cancelled")
                }
                invoke.resolve()
            }
        } catch { invoke.reject("invalid cancellation") }
    }
    @objc public func openBrowser(_ invoke: Invoke) {
        do {
            let args = try invoke.parseArgs(BrowserArgs.self)
            guard let url = URL(string: args.url), url.scheme == "https", url.user == nil, url.password == nil else { invoke.reject("invalid checkout URL"); return }
            DispatchQueue.main.async {
                UIApplication.shared.open(url, options: [:]) { opened in
                    if opened { invoke.resolve() } else { invoke.reject("browser unavailable") }
                }
            }
        } catch { invoke.reject("invalid browser request") }
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor ?? ASPresentationAnchor() }
}
@_cdecl("init_plugin_f2z")
func initPlugin() -> Plugin { F2zPlugin() }
