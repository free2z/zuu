//! Native secure-record contract. JSON string values match Keychain and Keystore
//! plaintext exactly; cancellation revision survives clear/restart.
use serde_json::{Value, json};
/// These transitions are a fixture oracle for the platform implementations, not
/// substitutes for SDK/secure-store execution. Native fixture corpora bind them.
pub fn active(v: &Value, now: u64) -> bool {
    if v["enabled"] != "1" {
        return false;
    }
    let Some(lease) = v["lease"]
        .as_str()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
    else {
        return false;
    };
    lease["disabled"] == false
        && lease["consent"] == v["revision"]
        && lease["expires"].as_u64().is_some_and(|t| t > now)
}
pub fn next(v: &Value) -> Result<String, &'static str> {
    let n = v["revision"]
        .as_str()
        .unwrap_or("0")
        .parse::<u64>()
        .map_err(|_| "unavailable")?;
    n.checked_add(1)
        .filter(|n| *n <= 9_007_199_254_740_991)
        .map(|n| n.to_string())
        .ok_or("unavailable")
}
pub fn stop(v: &mut Value) -> Result<(), &'static str> {
    let revision = next(v)?;
    if let Some(s) = v["lease"].as_str() {
        let mut lease: Value = serde_json::from_str(s).map_err(|_| "unavailable")?;
        lease["disabled"] = json!(true);
        v["lease"] = json!(lease.to_string());
    }
    v["enabled"] = json!("0");
    v["revision"] = json!(revision);
    v.as_object_mut().ok_or("unavailable")?.remove("token");
    v.as_object_mut().ok_or("unavailable")?.remove("pending");
    Ok(())
}
pub fn begin(v: &mut Value, expected: &str, text: &str) -> Result<(), &'static str> {
    if v["revision"].as_str().unwrap_or("0") != expected
        || v["enabled"] == "1"
        || v.get("lease").is_some()
    {
        return Err("unavailable");
    }
    let l: Value = serde_json::from_str(text).map_err(|_| "unavailable")?;
    let revision = next(v)?;
    if l["consent"] != revision || l["disabled"] != false {
        return Err("unavailable");
    }
    v["enabled"] = json!("1");
    v["revision"] = json!(revision);
    v["lease"] = json!(text);
    v.as_object_mut().unwrap().remove("token");
    v.as_object_mut().unwrap().remove("pending");
    Ok(())
}
pub fn save(v: &mut Value, expected: &str, text: &str, now: u64) -> Result<(), &'static str> {
    if !active(v, now) || v["revision"] != expected {
        return Err("unavailable");
    }
    let l: Value = serde_json::from_str(text).map_err(|_| "unavailable")?;
    let old: Value = serde_json::from_str(v["lease"].as_str().ok_or("unavailable")?)
        .map_err(|_| "unavailable")?;
    if l["consent"] != expected
        || l["disabled"] != false
        || ["queue", "manage", "send", "expires"]
            .iter()
            .any(|k| l[k] != old[k])
    {
        return Err("unavailable");
    }
    v["lease"] = json!(text);
    Ok(())
}
pub fn clear(v: &mut Value, expected: &str) -> Result<(), &'static str> {
    if v["enabled"] == "1" || v["revision"] != expected {
        return Err("unavailable");
    }
    *v = json!({"enabled":"0","revision":expected});
    Ok(())
}
pub fn token(v: &mut Value, revision: &str, token: &str, now: u64) -> bool {
    if !active(v, now) || v["revision"] != revision {
        return false;
    }
    v["token"] = json!(token);
    true
}
