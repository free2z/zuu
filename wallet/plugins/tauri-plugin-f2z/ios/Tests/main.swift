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
print("Swift callback rejection checks passed")
