//! The access token: an ES256 `at+jwt` (oidc.md §6.1, RFC 9068), parsed and
//! checked by hand.
//!
//! Every decision a JOSE library would otherwise make from the token's own
//! header is made here, from configuration:
//!
//! * **`alg` is `ES256` or the token is refused.** Not "one of the algorithms
//!   the key allows", not "whatever the header says": `none`, every `HS*`
//!   (the classic confusion that verifies an HMAC keyed with the public key)
//!   and every other asymmetric algorithm are refused before a key is looked
//!   up. The key set holds only P-256 keys, so an RS256 ID token presented
//!   here has no key to be checked against either.
//! * **`typ` is `at+jwt`** (or its media-type spelling), so an ID token, a
//!   logout token or any other JWT the issuer signs cannot be replayed as an
//!   access token.
//! * **`crit` is refused**: this verifier understands no extension header, so
//!   RFC 7515 §4.1.11 obliges it to reject any it is told is critical.
//! * **The signature is checked before a claim is read.** The payload is not
//!   even decoded until the signature over `header.payload` verifies.
//! * `iss` exact, `aud` an array containing this server's identifier, `exp`
//!   with at most 30 s of leeway, `iat` not in the future beyond the same
//!   leeway, `nbf` honoured if present.
//!
//! `sub` and `client_id` become parts of Redis keys and of a URL path, so
//! their shape is checked here too: `sub` is a canonical lower-case UUID (the
//! IdP's `public_id`), `client_id` a short token of URL-safe characters with
//! no `:`. A token that fails either is `malformed`, never a key the gateway
//! builds.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde_json::Value;

/// The only `alg` accepted.
pub const ALG: &str = "ES256";
/// RFC 9068's `typ`.
pub const TYP: &str = "at+jwt";
/// oidc.md §6.1: at most 30 s of clock leeway.
pub const LEEWAY_SECS: u64 = 30;
/// A longer `Authorization` value is refused without being parsed. The
/// IdP's tokens are well under 1 KiB.
pub const MAX_TOKEN_BYTES: usize = 8 * 1024;
/// The scope `/v1/chat` requires (chat-api.md §1).
pub const SCOPE: &str = "ai:invoke";
/// Longest `client_id` accepted.
pub const MAX_CLIENT_ID: usize = 128;

/// Why a token was refused. Each maps to one `details.reason` of
/// errors.md §2's `invalid_token`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenError {
    /// No `Authorization: Bearer` header.
    Missing,
    /// Not a well-formed access token: framing, encoding, `typ`, `crit`, a
    /// required claim absent or of the wrong type.
    Malformed,
    /// `alg` is not `ES256`, the `kid` names no key, or the signature does
    /// not verify.
    Signature,
    /// Past `exp` + leeway, before `nbf` − leeway, or issued in the future.
    Expired,
    /// `iss` is not the configured issuer.
    Issuer,
    /// `aud` does not contain this server's identifier.
    Audience,
}

impl TokenError {
    /// errors.md §2's `details.reason`.
    #[must_use]
    pub const fn reason(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Malformed => "malformed",
            Self::Signature => "signature",
            Self::Expired => "expired",
            Self::Issuer => "issuer",
            Self::Audience => "audience",
        }
    }
}

/// A token split and decoded, its signature not yet checked. Its `Debug`
/// names the `kid` only: the token is a bearer credential.
pub struct Unverified<'a> {
    /// The header's `kid`.
    pub kid: String,
    signing_input: &'a [u8],
    payload: &'a str,
    signature: Vec<u8>,
}

impl std::fmt::Debug for Unverified<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Unverified")
            .field("kid", &self.kid)
            .field("signing_input_len", &self.signing_input.len())
            .field("signature_len", &self.signature.len())
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct Header {
    alg: Option<Value>,
    typ: Option<Value>,
    kid: Option<Value>,
    crit: Option<Value>,
}

/// The bearer token from a request's headers.
///
/// Exactly one `Authorization` header, scheme `Bearer` (case-insensitive),
/// one space, a non-empty token of at most [`MAX_TOKEN_BYTES`].
///
/// # Errors
///
/// [`TokenError::Missing`] with no header or another scheme;
/// [`TokenError::Malformed`] otherwise.
pub fn bearer(headers: &axum::http::HeaderMap) -> Result<&str, TokenError> {
    let mut values = headers.get_all(axum::http::header::AUTHORIZATION).iter();
    let Some(value) = values.next() else {
        return Err(TokenError::Missing);
    };
    if values.next().is_some() {
        return Err(TokenError::Malformed);
    }
    let text = value.to_str().map_err(|_| TokenError::Malformed)?;
    let Some((scheme, token)) = text.split_once(' ') else {
        return Err(TokenError::Missing);
    };
    if !scheme.eq_ignore_ascii_case("bearer") {
        return Err(TokenError::Missing);
    }
    if token.is_empty() || token.len() > MAX_TOKEN_BYTES || token.contains(' ') {
        return Err(TokenError::Malformed);
    }
    Ok(token)
}

fn b64(segment: &str) -> Result<Vec<u8>, TokenError> {
    URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| TokenError::Malformed)
}

/// Split `token` and check its header.
///
/// # Errors
///
/// [`TokenError::Malformed`] for the framing, `typ`, `crit` or `kid`;
/// [`TokenError::Signature`] for any `alg` but `ES256`.
pub fn parse(token: &str) -> Result<Unverified<'_>, TokenError> {
    let mut parts = token.split('.');
    let (Some(header), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(TokenError::Malformed);
    };
    let signing_len = header
        .len()
        .checked_add(1)
        .and_then(|n| n.checked_add(payload.len()))
        .ok_or(TokenError::Malformed)?;
    let signing_input = token
        .as_bytes()
        .get(..signing_len)
        .ok_or(TokenError::Malformed)?;
    let header: Header =
        serde_json::from_slice(&b64(header)?).map_err(|_| TokenError::Malformed)?;
    match header.alg {
        Some(Value::String(alg)) if alg == ALG => {}
        Some(_) => return Err(TokenError::Signature),
        None => return Err(TokenError::Malformed),
    }
    let typ_ok = match &header.typ {
        Some(Value::String(typ)) => {
            typ.eq_ignore_ascii_case(TYP) || typ.eq_ignore_ascii_case("application/at+jwt")
        }
        _ => false,
    };
    if !typ_ok || header.crit.is_some() {
        return Err(TokenError::Malformed);
    }
    let kid = match header.kid {
        Some(Value::String(kid)) if !kid.is_empty() && kid.len() <= 256 => kid,
        _ => return Err(TokenError::Malformed),
    };
    let signature = b64(signature)?;
    // ES256 in JWS is the fixed-width r ‖ s, 64 bytes (RFC 7518 §3.4) —
    // never DER.
    if signature.len() != 64 {
        return Err(TokenError::Signature);
    }
    Ok(Unverified {
        kid,
        signing_input,
        payload,
        signature,
    })
}

impl Unverified<'_> {
    /// Verify the signature with `public_key` — an uncompressed SEC1 P-256
    /// point (`0x04 ‖ x ‖ y`) — and return the decoded payload.
    ///
    /// # Errors
    ///
    /// [`TokenError::Signature`] if it does not verify (including a key that
    /// is not a point on the curve); [`TokenError::Malformed`] if the payload
    /// that verified is not base64url.
    pub fn verify(&self, public_key: &[u8]) -> Result<Vec<u8>, TokenError> {
        ring::signature::UnparsedPublicKey::new(
            &ring::signature::ECDSA_P256_SHA256_FIXED,
            public_key,
        )
        .verify(self.signing_input, &self.signature)
        .map_err(|_| TokenError::Signature)?;
        b64(self.payload)
    }
}

/// The claims `/v1/chat` uses, from a token whose signature verified.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claims {
    /// The user's stable per-account UUID, canonical lower case.
    pub sub: String,
    /// The opaque OAuth client identifier, used for revocation and rate limits.
    pub client_id: String,
    /// Issuer-signed application UUID, used for ledger admission.
    pub app_id: String,
    /// Space-separated granted scopes.
    pub scope: String,
    /// The account epoch at issue.
    pub aep: u64,
    /// The grant generation at issue.
    pub agen: u64,
    /// Expiry, Unix seconds.
    pub exp: u64,
    /// The token id.
    pub jti: String,
}

impl Claims {
    /// Whether `scope` contains `wanted` as a whole space-separated token.
    #[must_use]
    pub fn has_scope(&self, wanted: &str) -> bool {
        self.scope.split(' ').any(|s| s == wanted)
    }
}

#[derive(Deserialize)]
struct RawClaims {
    iss: Option<Value>,
    sub: Option<Value>,
    aud: Option<Value>,
    client_id: Option<Value>,
    app_id: Option<Value>,
    scope: Option<Value>,
    exp: Option<Value>,
    iat: Option<Value>,
    nbf: Option<Value>,
    jti: Option<Value>,
    aep: Option<Value>,
    agen: Option<Value>,
}

fn string(value: Option<Value>) -> Result<String, TokenError> {
    match value {
        Some(Value::String(s)) => Ok(s),
        _ => Err(TokenError::Malformed),
    }
}

/// A non-negative JSON integer. A float, a negative number, a string or a
/// boolean is malformed — `true` is not the epoch 1.
fn integer(value: Option<Value>) -> Result<u64, TokenError> {
    match value {
        Some(Value::Number(n)) => n.as_u64().ok_or(TokenError::Malformed),
        _ => Err(TokenError::Malformed),
    }
}

/// `8-4-4-4-12` lower-case hex: the form the IdP writes into `sub` and into
/// its Redis keys.
#[must_use]
pub fn is_canonical_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(b),
        })
}

/// A `client_id` safe to place in a Redis key: 1–128 of `A–Z a–z 0–9 . _ ~ -`.
#[must_use]
pub fn is_safe_client_id(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= MAX_CLIENT_ID
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-'))
}

/// Check a verified payload against the issuer, the audience and `now`.
///
/// # Errors
///
/// The [`TokenError`] for the first rule the claims break.
pub fn check_claims(
    payload: &[u8],
    issuer: &str,
    audience: &str,
    now: u64,
) -> Result<Claims, TokenError> {
    let raw: RawClaims = serde_json::from_slice(payload).map_err(|_| TokenError::Malformed)?;
    let exp = integer(raw.exp)?;
    let iat = integer(raw.iat)?;
    if exp.saturating_add(LEEWAY_SECS) < now {
        return Err(TokenError::Expired);
    }
    if iat > now.saturating_add(LEEWAY_SECS) {
        return Err(TokenError::Expired);
    }
    if raw.nbf.is_some() && integer(raw.nbf)? > now.saturating_add(LEEWAY_SECS) {
        return Err(TokenError::Expired);
    }
    if string(raw.iss)? != issuer {
        return Err(TokenError::Issuer);
    }
    // oidc.md §6.1: `aud` is always an array.
    match raw.aud {
        Some(Value::Array(auds)) => {
            if !auds.iter().any(|a| a.as_str() == Some(audience)) {
                return Err(TokenError::Audience);
            }
        }
        Some(_) => return Err(TokenError::Audience),
        None => return Err(TokenError::Malformed),
    }
    let sub = string(raw.sub)?;
    let client_id = string(raw.client_id)?;
    let app_id = string(raw.app_id)?;
    if !is_canonical_uuid(&sub) || !is_safe_client_id(&client_id) || !is_canonical_uuid(&app_id) {
        return Err(TokenError::Malformed);
    }
    Ok(Claims {
        sub,
        client_id,
        app_id,
        scope: string(raw.scope)?,
        aep: integer(raw.aep)?,
        agen: integer(raw.agen)?,
        exp,
        jti: string(raw.jti)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue, header};
    use serde_json::json;

    fn enc(value: &Value) -> String {
        URL_SAFE_NO_PAD.encode(value.to_string())
    }

    fn token(header: &Value) -> String {
        format!(
            "{}.{}.{}",
            enc(header),
            enc(&json!({})),
            URL_SAFE_NO_PAD.encode([0u8; 64])
        )
    }

    #[test]
    fn only_es256_at_jwt_with_a_kid_passes_the_header() {
        let ok = json!({"alg": "ES256", "typ": "at+jwt", "kid": "k"});
        assert_eq!(parse(&token(&ok)).unwrap().kid, "k");
        let media = json!({"alg": "ES256", "typ": "application/AT+JWT", "kid": "k"});
        assert!(parse(&token(&media)).is_ok());

        for alg in ["none", "HS256", "HS512", "RS256", "ES384", "PS256", "es256"] {
            let h = json!({"alg": alg, "typ": "at+jwt", "kid": "k"});
            assert_eq!(
                parse(&token(&h)).unwrap_err(),
                TokenError::Signature,
                "{alg}"
            );
        }
        let cases = [
            json!({"typ": "at+jwt", "kid": "k"}),
            json!({"alg": "ES256", "kid": "k"}),
            json!({"alg": "ES256", "typ": "JWT", "kid": "k"}),
            json!({"alg": "ES256", "typ": "at+jwt"}),
            json!({"alg": "ES256", "typ": "at+jwt", "kid": 7}),
            json!({"alg": "ES256", "typ": "at+jwt", "kid": "k", "crit": ["exp"]}),
        ];
        for h in cases {
            assert_eq!(parse(&token(&h)).unwrap_err(), TokenError::Malformed, "{h}");
        }
    }

    #[test]
    fn framing() {
        for bad in ["", "a", "a.b", "a.b.c.d", "!!.b.c"] {
            assert!(parse(bad).is_err(), "{bad}");
        }
        // A DER-length signature is refused before any key is touched.
        let h = json!({"alg": "ES256", "typ": "at+jwt", "kid": "k"});
        let t = format!(
            "{}.{}.{}",
            enc(&h),
            enc(&json!({})),
            URL_SAFE_NO_PAD.encode([0u8; 70])
        );
        assert_eq!(parse(&t).unwrap_err(), TokenError::Signature);
    }

    #[test]
    fn bearer_parsing() {
        let mut h = HeaderMap::new();
        assert_eq!(bearer(&h).unwrap_err(), TokenError::Missing);
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Basic abc"));
        assert_eq!(bearer(&h).unwrap_err(), TokenError::Missing);
        h.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("bearer abc"),
        );
        assert_eq!(bearer(&h).unwrap(), "abc");
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer "));
        assert_eq!(bearer(&h).unwrap_err(), TokenError::Malformed);
        h.append(header::AUTHORIZATION, HeaderValue::from_static("Bearer x"));
        assert_eq!(bearer(&h).unwrap_err(), TokenError::Malformed);
    }

    fn claims() -> Value {
        json!({
            "iss": "https://free2z.cash",
            "sub": "3f0c9b7e-6a2d-4b1f-8e5c-2d9a7c4e1b60",
            "aud": ["f2z-id", "f2z-ai"],
            "client_id": "app_7f3c2e",
            "app_id": "22222222-2222-4222-8222-222222222222",
            "scope": "openid ai:invoke",
            "iat": 1000, "exp": 1300, "jti": "j", "aep": 4, "agen": 2,
        })
    }

    fn check(value: &Value, now: u64) -> Result<Claims, TokenError> {
        check_claims(
            value.to_string().as_bytes(),
            "https://free2z.cash",
            "f2z-ai",
            now,
        )
    }

    #[test]
    fn the_claims_rules() {
        let ok = check(&claims(), 1100).unwrap();
        assert_eq!((ok.aep, ok.agen), (4, 2));
        assert!(ok.has_scope("ai:invoke"));
        assert!(!ok.has_scope("ai"));

        // Leeway: 30 s past exp passes, 31 does not.
        assert!(check(&claims(), 1330).is_ok());
        assert_eq!(check(&claims(), 1331).unwrap_err(), TokenError::Expired);
        // Issued in the future beyond the leeway.
        assert_eq!(check(&claims(), 969).unwrap_err(), TokenError::Expired);

        let with = |key: &str, value: Value| {
            let mut c = claims();
            c[key] = value;
            c
        };
        let cases = [
            (
                with("iss", json!("https://free2z.cash/")),
                TokenError::Issuer,
            ),
            (
                with("aud", json!(["f2z-id", "f2z-api"])),
                TokenError::Audience,
            ),
            (with("aud", json!("f2z-ai")), TokenError::Audience),
            (with("aep", json!("4")), TokenError::Malformed),
            (with("aep", json!(true)), TokenError::Malformed),
            (with("agen", json!(-1)), TokenError::Malformed),
            (with("exp", json!(1300.5)), TokenError::Malformed),
            (
                with("sub", json!("3F0C9B7E-6A2D-4B1F-8E5C-2D9A7C4E1B60")),
                TokenError::Malformed,
            ),
            (with("sub", json!("../../x")), TokenError::Malformed),
            (with("client_id", json!("app:evil")), TokenError::Malformed),
            (with("client_id", json!("")), TokenError::Malformed),
            (with("app_id", json!("app_7f3c2e")), TokenError::Malformed),
            (with("app_id", json!(null)), TokenError::Malformed),
            (
                with("app_id", json!("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")),
                TokenError::Malformed,
            ),
            (with("nbf", json!(2000)), TokenError::Expired),
        ];
        for (value, want) in cases {
            assert_eq!(check(&value, 1100).unwrap_err(), want, "{value}");
        }
        let mut missing = claims();
        missing.as_object_mut().unwrap().remove("app_id");
        assert_eq!(check(&missing, 1100).unwrap_err(), TokenError::Malformed);
        let mut missing = claims();
        missing.as_object_mut().unwrap().remove("agen");
        assert_eq!(check(&missing, 1100).unwrap_err(), TokenError::Malformed);
    }
}
