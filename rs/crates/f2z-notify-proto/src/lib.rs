//! Contentless notification protocol. Independent of wallet/account/relay identities.
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

/// Maximum registration lease; a restart also revokes every lease.
pub const LEASE: u64 = 86_400;
/// A wake is useful for one minute, never a durable payment receipt.
pub const WAKE_TTL: u64 = 60;
/// An independent random 256-bit capability/address in canonical lowercase hex.
pub fn capability(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/// Supported production providers. No caller-selected URL or topic.
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Apns,
    Fcm,
}
/// Anonymous admission; invitations are one-use and have no account binding.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Register {
    pub invitation: String,
    pub queue: String,
    pub manage: String,
    pub send: String,
    pub provider: Provider,
    pub token: String,
    pub expires: u64,
}
/// Replace only the token, with a monotonic generation and the management capability.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Rotate {
    pub queue: String,
    pub manage: String,
    pub generation: u64,
    pub token: String,
}
/// Revocation does not reveal whether the queue exists.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Revoke {
    pub queue: String,
    pub manage: String,
}
/// Only capability holders may request a wake. There is no caller-supplied payload.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Wake {
    pub queue: String,
    pub send: String,
    pub sequence: u64,
}
/// Exact provider data payload. All values are strings for FCM HTTP v1.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub queue: String,
    pub generation: String,
    pub sequence: String,
    pub expires: String,
    pub signature: String,
}
impl Envelope {
    /// Domain-separated, unambiguous signature preimage; no JSON canonicalization dependency.
    pub fn message(&self) -> String {
        format!(
            "f2z.notify.v1\n{}\n{}\n{}\n{}",
            self.queue, self.generation, self.sequence, self.expires
        )
    }
    /// Check signature, queue, token generation, expiry and replay before using a native callback.
    pub fn verify(
        &self,
        key: &[u8; 32],
        queue: &str,
        generation: u64,
        last: u64,
        now: u64,
    ) -> Option<u64> {
        fn number(s: &str) -> Option<u64> {
            let n = s.parse::<u64>().ok()?;
            (n.to_string() == s).then_some(n)
        }
        if !capability(queue) || self.queue != queue || number(&self.generation)? != generation {
            return None;
        }
        let sequence = number(&self.sequence)?;
        let expires = number(&self.expires)?;
        if sequence <= last || expires < now || expires > now.checked_add(WAKE_TTL)? {
            return None;
        }
        let key = VerifyingKey::from_bytes(key).ok()?;
        let bytes = hex::decode(&self.signature).ok()?;
        let signature = Signature::from_slice(&bytes).ok()?;
        key.verify_strict(self.message().as_bytes(), &signature)
            .ok()?;
        Some(sequence)
    }
}
/// Strict token grammar prevents path/header injection and bounds memory.
pub fn token(provider: Provider, token: &str) -> bool {
    match provider {
        Provider::Apns => {
            (32..=200).contains(&token.len())
                && token.len().is_multiple_of(2)
                && token
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        }
        Provider::Fcm => {
            (20..=4096).contains(&token.len())
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_:.-".contains(&b))
        }
    }
}

/// Exact native IPC response; queue credentials and provider tokens never cross IPC.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub state: String,
    pub wake: bool,
}
