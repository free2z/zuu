// SPDX-License-Identifier: MIT
import Foundation

enum CallbackPolicy {
    static func accepts(_ url: URL, expected: URL, state: String) -> Bool {
        guard url.absoluteString.utf8.count <= 16384,
              let actual = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let target = URLComponents(url: expected, resolvingAgainstBaseURL: false),
              actual.scheme == target.scheme, actual.host == target.host, actual.port == target.port,
              actual.percentEncodedPath == target.percentEncodedPath,
              actual.user == nil, actual.password == nil, actual.fragment == nil,
              actual.queryItems?.filter({ $0.name == "state" }).count == 1,
              actual.queryItems?.first(where: { $0.name == "state" })?.value == state else { return false }
        return true
    }
}
