// SPDX-License-Identifier: MIT
import AuthenticationServices
import Foundation

/// Why a native sign-in ended without a callback, as the `code` of the
/// `authorize` rejection. The Rust core maps exactly these strings
/// (`platform.rs`, `native_auth_rejection`); `nil` — no code — is its
/// `browser_error` fallback, for an ending this layer cannot attribute.
enum AuthRejection {
    static let userCancelled = "user_cancelled"
    static let browserUnavailable = "browser_unavailable"
    static let timeout = "timeout"

    /// The code for an `ASWebAuthenticationSession` completion error.
    static func code(for error: Error?) -> String? {
        guard let error = error as NSError?, error.domain == ASWebAuthenticationSessionError.errorDomain else { return nil }
        switch ASWebAuthenticationSessionError.Code(rawValue: error.code) {
        case .canceledLogin?: return userCancelled
        case .presentationContextNotProvided?, .presentationContextInvalid?: return browserUnavailable
        default: return nil
        }
    }
}
