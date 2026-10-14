//! Who is signed in, for display, and the Free2Z web pages where the user
//! manages that account.
//!
//! The pages are part of the SDK contract (`docs/free2z/sdk/INTEGRATION.md`,
//! "Account exits"): an app opens them in the **system browser**, never in a
//! webview, and never builds them itself.

use url::Url;

use crate::error::Error;
use crate::oauth::IdTokenClaims;

/// The longest display string kept, in bytes. Free2Z usernames are far
/// shorter; anything longer is not a handle to show.
const MAX_DISPLAY_BYTES: usize = 256;

/// The signed-in account's display identity, from the verified ID token of
/// the sign-in that started the session. Present only when the `profile`
/// scope was granted.
///
/// For display only: it is what the account was called **at sign-in**, and a
/// user may rename it on Free2Z. Key local data by
/// [`Client::subject`](crate::Client::subject), never by these.
#[non_exhaustive]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Profile {
    /// The Free2Z username (`preferred_username`). Free2Z accounts need no
    /// email, so this, not an email, is the handle to show.
    pub preferred_username: Option<String>,
    /// The display name (`name`), when the account has one.
    pub name: Option<String>,
}

/// A display claim worth keeping: non-empty after trimming, bounded, and
/// free of control characters (a verified token is still not UI-safe text).
fn display(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    (!value.is_empty() && value.len() <= MAX_DISPLAY_BYTES && !value.chars().any(char::is_control))
        .then(|| value.to_owned())
}

/// The profile a session with `granted` scopes may carry, from `claims`.
pub(crate) fn profile(granted: &str, claims: Option<&IdTokenClaims>) -> Option<Profile> {
    if !has_profile_scope(granted) {
        return None;
    }
    let claims = claims?;
    let profile = Profile {
        preferred_username: display(claims.preferred_username.as_deref()),
        name: display(claims.name.as_deref()),
    };
    (profile.preferred_username.is_some() || profile.name.is_some()).then_some(profile)
}

pub(crate) fn has_profile_scope(granted: &str) -> bool {
    granted.split(' ').any(|s| s == "profile")
}

/// Restore a stored profile through the same filter it was saved through.
pub(crate) fn restored(username: Option<&str>, name: Option<&str>) -> Option<Profile> {
    let profile = Profile {
        preferred_username: display(username),
        name: display(name),
    };
    (profile.preferred_username.is_some() || profile.name.is_some()).then_some(profile)
}

/// The Free2Z web origin: the configured one, or the issuer's origin. The
/// issuer *is* the Free2Z website (`https://free2z.cash`), so for every
/// deployment that serves its account pages beside its IdP nothing needs
/// configuring.
pub(crate) fn web_origin(issuer: &Url, configured: Option<&str>) -> Result<String, Error> {
    let url = match configured {
        None => issuer.clone(),
        Some(value) => {
            let url = crate::config::server_url(value.trim_end_matches('/'), "web_origin")?;
            if url.path() != "/" || url.query().is_some() {
                return Err(Error::Config(
                    "web_origin: an origin has no path or query".into(),
                ));
            }
            url
        }
    };
    Ok(url.origin().ascii_serialization())
}

/// `{origin}/account/apps?client_id=…`: this app's grant on Free2Z — its
/// budget, its permissions, revoking it — and the account's balance.
pub(crate) fn manage_url(origin: &str, client_id: &str) -> Result<String, Error> {
    let mut url = Url::parse(&format!("{origin}/account/apps"))
        .map_err(|e| Error::Internal(format!("manage-account URL: {e}")))?;
    url.query_pairs_mut().append_pair("client_id", client_id);
    Ok(url.into())
}

/// `{origin}/account/delete`: where the user deletes their Free2Z account.
pub(crate) fn delete_url(origin: &str) -> String {
    format!("{origin}/account/delete")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims(username: Option<&str>, name: Option<&str>) -> IdTokenClaims {
        IdTokenClaims {
            sub: "u".into(),
            auth_time: None,
            acr: None,
            amr: Vec::new(),
            preferred_username: username.map(str::to_owned),
            name: name.map(str::to_owned),
            picture: None,
            email: None,
            email_verified: None,
            exp: 0,
        }
    }

    #[test]
    fn a_profile_needs_the_profile_scope() {
        let both = claims(Some("ada"), Some("Ada L."));
        assert_eq!(
            profile("openid profile", Some(&both)),
            Some(Profile {
                preferred_username: Some("ada".into()),
                name: Some("Ada L.".into()),
            })
        );
        // The IdP sent the claims, but the user did not grant `profile`.
        assert_eq!(profile("openid offline_access", Some(&both)), None);
        assert_eq!(profile("openid profiles", Some(&both)), None);
        assert_eq!(profile("openid profile", None), None);
        let username_only = profile("profile", Some(&claims(Some("ada"), None))).unwrap();
        assert_eq!(username_only.name, None);
    }

    #[test]
    fn display_claims_are_trimmed_bounded_and_control_free() {
        assert_eq!(
            profile("profile", Some(&claims(Some("  ada "), None)))
                .unwrap()
                .preferred_username
                .as_deref(),
            Some("ada")
        );
        let long = "x".repeat(MAX_DISPLAY_BYTES + 1);
        for bad in ["", "   ", "a\u{0}b", "line\nbreak", "esc\u{1b}[2J"] {
            assert_eq!(display(Some(bad)), None, "{bad:?}");
        }
        assert_eq!(display(Some(&long)), None);
        assert!(display(Some(&long[..MAX_DISPLAY_BYTES])).is_some());
        assert_eq!(
            profile("profile", Some(&claims(Some(""), Some("\n")))),
            None
        );
    }

    #[test]
    fn the_web_origin_is_the_issuer_origin_unless_configured() {
        let issuer = Url::parse("https://free2z.cash").unwrap();
        assert_eq!(web_origin(&issuer, None).unwrap(), "https://free2z.cash");
        let staged = Url::parse("https://id.staging.example/realm").unwrap();
        assert_eq!(
            web_origin(&staged, None).unwrap(),
            "https://id.staging.example"
        );
        assert_eq!(
            web_origin(&issuer, Some("https://www.example/")).unwrap(),
            "https://www.example"
        );
        let local = Url::parse("http://127.0.0.1:8000").unwrap();
        assert_eq!(web_origin(&local, None).unwrap(), "http://127.0.0.1:8000");
        for bad in [
            "http://free2z.cash",
            "https://free2z.cash/account",
            "https://free2z.cash?x=1",
            "https://user@free2z.cash",
            "not a url",
        ] {
            assert!(web_origin(&issuer, Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn account_page_urls_follow_the_contract() {
        assert_eq!(
            manage_url("https://free2z.cash", "iVhrb5Jk").unwrap(),
            "https://free2z.cash/account/apps?client_id=iVhrb5Jk"
        );
        // A client id is public configuration, but it is still encoded.
        assert_eq!(
            manage_url("https://free2z.cash", "a b&c=d").unwrap(),
            "https://free2z.cash/account/apps?client_id=a+b%26c%3Dd"
        );
        assert_eq!(
            delete_url("https://free2z.cash"),
            "https://free2z.cash/account/delete"
        );
    }
}
