import AuthenticationServices
import Foundation
let target = URL(string: "https://app.example/oauth/callback")!
precondition(CallbackPolicy.accepts(URL(string: "\(target)?state=expected&code=x")!, expected: target, state: "expected"))
for bad in [
    "https://evil.example/oauth/callback?state=expected",
    "\(target)/other?state=expected", "\(target)?state=wrong", "\(target)?state=expected&state=expected",
    "\(target)?state=expected#fragment", "https://user@app.example/oauth/callback?state=expected",
    "https://app.example/oauth%2Fcallback?state=expected",
    "\(target)?state=expected&code=" + String(repeating: "x", count: 17000)
] {
    precondition(!CallbackPolicy.accepts(URL(string: bad)!, expected: target, state: "expected"), bad)
}
let privateURI = URL(string: "com.example.tutor:/oauth/callback")!
precondition(CallbackPolicy.accepts(URL(string: "\(privateURI)?state=expected")!, expected: privateURI, state: "expected"))

// Why a session ended reaches Rust as a distinct code; anything else is the fallback (nil).
let asDomain = ASWebAuthenticationSessionError.errorDomain
precondition(AuthRejection.code(for: NSError(domain: asDomain, code: ASWebAuthenticationSessionError.Code.canceledLogin.rawValue)) == "user_cancelled")
precondition(AuthRejection.code(for: ASWebAuthenticationSessionError(.canceledLogin)) == "user_cancelled")
precondition(AuthRejection.code(for: ASWebAuthenticationSessionError(.presentationContextNotProvided)) == "browser_unavailable")
precondition(AuthRejection.code(for: ASWebAuthenticationSessionError(.presentationContextInvalid)) == "browser_unavailable")
precondition(AuthRejection.timeout == "timeout")
for other: Error? in [
    nil,
    NSError(domain: asDomain, code: 9999),
    // Same number as a user cancel, different domain: not a user cancel.
    NSError(domain: NSURLErrorDomain, code: ASWebAuthenticationSessionError.Code.canceledLogin.rawValue),
    NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled),
] {
    precondition(AuthRejection.code(for: other) == nil, String(describing: other))
}
print("Swift callback rejection checks passed")
