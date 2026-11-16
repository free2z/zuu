//! Android unavailability pending release-owner review, never an exemption.
//! Pure native predicates shared by the production plugin wrapper and the
//! standalone compiled negative controls. Rules are generated from policy.json.
include!(concat!(env!("OUT_DIR"), "/purchase_rules.rs"));

pub const ANDROID_NOTICE: &str = "Digital purchases are unavailable in this Android app.";

pub fn blocked_request(path: &str, method: &str) -> bool {
    let Some(path) = canonical_path(path) else {
        return true;
    };
    let method = method.to_ascii_uppercase();
    PURCHASE_RULES
        .iter()
        .any(|(prefix, suffix, contains, methods)| {
            (path == prefix.trim_end_matches('/')
                || path.starts_with(&format!("{}/", prefix.trim_end_matches('/'))))
                && (suffix.is_empty() || path.ends_with(suffix))
                && (contains.is_empty() || path.contains(contains))
                && (methods.contains(&"*") || methods.contains(&method.as_str()))
        })
}

pub fn blocked_external(scheme: &str, host: &str, path: &str) -> bool {
    let host = host.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return false; // The existing opener ACL still decides other schemes.
    }
    if host == "stripe.com" || host.ends_with(".stripe.com") {
        return true;
    }
    let first_party = ["free2z.cash", "free2z.com"]
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
    // First-party external pages can lead to billing even through account or
    // login redirects. Only the existing exact wallet-authority App Link is
    // exempt here; the bridge validates its own bounded request separately.
    first_party
        && !(scheme == "https"
            && host == "free2z.com"
            && (path == "/bridge/zuuli/" || path == "/bridge/e2e2z/chat/"))
}

/// Decode exactly once, preserving safe Unicode read paths without allowing
/// encoded routes or separators to evade the purchase inventory.
fn canonical_path(path: &str) -> Option<String> {
    let input = path.as_bytes();
    let mut bytes = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'%' {
            let hex = std::str::from_utf8(input.get(i + 1..i + 3)?).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            bytes.push(input[i]);
            i += 1;
        }
    }
    let path = String::from_utf8(bytes).ok()?;
    if path.contains('%')
        || path.contains("//")
        || path.contains('\\')
        || path.split('/').any(|part| part == "." || part == "..")
    {
        return None;
    }
    Some(path.trim_end_matches('/').to_ascii_lowercase())
}
