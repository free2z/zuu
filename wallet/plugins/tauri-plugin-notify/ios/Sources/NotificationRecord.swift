import Foundation

/// Pure transitions over the exact encrypted/Keychain plaintext representation.
/// All callers serialize read/transition/write on the main queue.
enum NotificationRecord {
    static func revision(_ s: [String:String]) -> String { s["revision"] ?? "0" }
    static func next(_ s: [String:String]) throws -> String {
        guard let n = UInt64(revision(s)), n < 9_007_199_254_740_991 else { throw Failure.invalid }
        return String(n + 1)
    }
    enum Failure: Error { case invalid }
    static func lease(_ s: [String:String]) -> [String:Any]? {
        guard let text=s["lease"], let data=text.data(using:.utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with:data)) as? [String:Any]
    }
    static func encode(_ v: [String:Any]) throws -> String {
        let data=try JSONSerialization.data(withJSONObject:v,options:[.sortedKeys])
        guard data.count<=16384, let value=String(data:data,encoding:.utf8) else { throw Failure.invalid }
        return value
    }
    static func active(_ s: [String:String], now: Double=Date().timeIntervalSince1970) -> Bool {
        guard s["enabled"]=="1", let l=lease(s), l["disabled"] as? Bool == false,
            l["consent"] as? String == revision(s), let expiry=l["expires"] as? Double else { return false }
        return expiry>now
    }
    static func begin(_ s: inout [String:String], expected: String, text: String) throws {
        guard revision(s)==expected, s["enabled"] != "1", s["lease"]==nil,
            let data=text.data(using:.utf8), let l=try JSONSerialization.jsonObject(with:data) as? [String:Any],
            l["consent"] as? String == (try next(s)), l["disabled"] as? Bool == false else { throw Failure.invalid }
        s["revision"]=try next(s); s["enabled"]="1"; s["lease"]=try encode(l)
        s.removeValue(forKey:"token"); s.removeValue(forKey:"pending")
    }
    static func save(_ s: inout [String:String], expected: String, text: String) throws {
        guard active(s), revision(s)==expected, let old=lease(s), let data=text.data(using:.utf8),
            let value=try JSONSerialization.jsonObject(with:data) as? [String:Any],
            value["consent"] as? String == expected, value["disabled"] as? Bool == false,
            value["expires"] as? Double == old["expires"] as? Double,
            ["queue","manage","send"].allSatisfy({value[$0] as? String == old[$0] as? String}) else { throw Failure.invalid }
        s["lease"]=try encode(value)
    }
    static func stop(_ s: inout [String:String]) throws {
        let next=try next(s)
        if s["lease"] != nil {
            guard var l=lease(s) else { throw Failure.invalid }
            l["disabled"]=true; s["lease"]=try encode(l)
        }
        s["enabled"]="0"; s["revision"]=next
        s.removeValue(forKey:"token"); s.removeValue(forKey:"pending")
    }
    static func clear(_ s: inout [String:String], expected: String) throws {
        guard s["enabled"] != "1", revision(s)==expected else { throw Failure.invalid }
        s=["enabled":"0","revision":expected]
    }
    @discardableResult static func token(_ s: inout [String:String], expected: String, token: String) -> Bool {
        guard active(s), revision(s)==expected else { return false }
        let changed=s["token"] != token; s["token"]=token; return changed
    }
}
