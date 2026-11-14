import Foundation
let fixtures = try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [[String:Any]]
func canonical(_ v:[String:String]) throws -> Data {
    var value:[String:Any]=v
    if let lease=v["lease"], let data=lease.data(using:.utf8) {value["lease"]=try JSONSerialization.jsonObject(with:data)}
    return try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys])
}
for fixture in fixtures {
    var state=fixture["before"] as! [String:String]
    var rejected=false
    do {
        let revision=fixture["revision"] as? String ?? ""
        switch fixture["operation"] as! String {
        case "stop": try NotificationRecord.stop(&state)
        case "begin": try NotificationRecord.begin(&state,expected:revision,text:fixture["lease"] as! String)
        case "save": try NotificationRecord.save(&state,expected:revision,text:fixture["lease"] as! String)
        case "clear": try NotificationRecord.clear(&state,expected:revision)
        case "token": NotificationRecord.token(&state,expected:revision,token:fixture["token"] as! String)
        default: fatalError("unknown fixture")
        }
    } catch { rejected=true }
    precondition(rejected==(fixture["reject"] as? Bool ?? false),"rejection")
    let actual=try canonical(state)
    let expected=try canonical(fixture["after"] as! [String:String])
    precondition(actual==expected,"persisted state")
}
print("Swift production secure-record transitions: \(fixtures.count) fixtures passed (Foundation only; no APNs/device claim)")
