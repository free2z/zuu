//! Caller identity: what the platform can prove, and what it cannot.
//!
//! **Read `docs/intent-bridge/CALLER-AUTHENTICATION.md` before changing
//! anything here.** This module is the code half of that document, and its
//! central claim is a negative one:
//!
//! > A deep link does not authenticate its sender. Any app can register a
//! > custom scheme. A *verified* App Link or Universal Link proves the link
//! > was verified against a domain — it does not name the app that opened it.
//!
//! So this module never returns "the caller is `cash.free2z.e2e2z`". It
//! returns one of two verdicts, and the difference between them is the whole
//! honest content of the design:
//!
//! - [`CallerTrust::Attested`] — the **operating system** told us who the
//!   caller is and it matches a registered signing certificate. Available on
//!   Android, via `getCallingPackage()` on an activity started for result plus
//!   a signature check against the allowlist.
//! - [`CallerTrust::Claimed`] — nothing but the caller's own assertion, which
//!   is worth exactly what an attacker's assertion is worth. This is the iOS
//!   case, and there is no iOS API that changes it.
//!
//! A [`CallerTrust::Claimed`] verdict is **not** an error. Refusing every
//! unattested request would disable the bridge on iOS entirely, and the
//! security model does not require that: the primary control is the native
//! confirmation, where the user approves inside ZUULI seeing ZUULI's own
//! rendering. What a `Claimed` verdict must do is reach the confirmation, so
//! the wallet renders "an app claiming to be free2z" rather than "free2z".
//! [`AuthorizedCaller`] carries the verdict for exactly that reason, and it is
//! not `Copy` or defaultable — a caller has to be *given* one.
//!
//! # Why the registry filters even the claimed case
//!
//! An unregistered caller is refused outright, on both platforms. That is not
//! authentication and is not claimed to be: it removes the class of requests
//! from apps that never enrolled, and it means the string the confirmation
//! renders is drawn from **our** registry — an operator-set display name —
//! rather than from the caller's own `caller` field. A hostile app that
//! impersonates a registered package still gets `Claimed`, and still has to
//! get past a human.

use alloc::vec::Vec;

use subtle::ConstantTimeEq;

use crate::error::IntentError;
use crate::text::VisibleText;

/// A SHA-256 digest of a platform signing certificate, as Android's package
/// manager reports it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct SigningCertDigest([u8; 32]);

impl SigningCertDigest {
    /// Wrap a digest.
    #[must_use]
    pub const fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

/// Hand-written: a derived `Debug` over `[u8; 32]` prints a decimal dump, and
/// `f2z-codec/tests/workspace_debug_scan.rs` refuses that across the
/// workspace. A certificate digest is not secret, but it is also not useful in
/// a log line, and the rule is a rule.
impl core::fmt::Debug for SigningCertDigest {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("SigningCertDigest(<redacted>)")
    }
}

/// What the operating system was able to say about who sent this request.
///
/// `Debug` is hand-written for the same reason [`SigningCertDigest`]'s is:
/// `package` is spelled `&[u8]`, and a derived `Debug` over that renders a
/// decimal dump. `workspace_debug_scan.rs` matches on the type spelling, so
/// this is a rule the whole workspace shares rather than a local preference.
#[derive(Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum CallerAttestation<'a> {
    /// Android. `package` is `getCallingPackage()` and `signing_cert` is the
    /// SHA-256 of the calling package's signing certificate, both read from
    /// the platform rather than from the request.
    ///
    /// The `-for-result` part is not decoration: `getCallingPackage()` returns
    /// `null` for an activity started with `startActivity`, so the bridge's
    /// Android entry point must be `startActivityForResult`-shaped or this
    /// variant is unavailable and the honest answer is [`Self::None`].
    Platform {
        /// The calling package name, from the platform.
        package: &'a [u8],
        /// SHA-256 of that package's signing certificate.
        signing_cert: SigningCertDigest,
    },
    /// The platform cannot name the opener. **This is the iOS case for
    /// Universal Links, and it is not a temporary gap** — see the design
    /// document.
    None,
}

impl core::fmt::Debug for CallerAttestation<'_> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Platform { package, .. } => f
                .debug_struct("Platform")
                // A package name is text, and it is the field an operator
                // reading a refusal needs. Escaped, so it cannot forge a log
                // line; length-only when it is not text at all.
                .field(
                    "package",
                    &match core::str::from_utf8(package) {
                        Ok(text) => crate::text::escape_layout_controls(text),
                        Err(_) => alloc::format!("<non-utf8; {} bytes>", package.len()),
                    },
                )
                .field("signing_cert", &"<redacted>")
                .finish(),
            Self::None => f.write_str("None"),
        }
    }
}

/// One app permitted to send intents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegisteredCaller {
    /// The identifier the caller puts in the request's `caller` field: an
    /// Android package name or an iOS bundle identifier.
    pub identifier: VisibleText,
    /// The name **ZUULI** renders in its confirmation. Drawn from here, never
    /// from the request, so a caller cannot choose how it is described.
    pub display_name: VisibleText,
    /// The signing certificates that may attest as this caller. Empty means
    /// no Android attestation is possible for it, which is the correct state
    /// for an iOS-only caller and a refusal for an Android one.
    pub signing_certs: Vec<SigningCertDigest>,
}

/// How much the operating system could prove.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallerTrust {
    /// The OS named the caller and its signature matched the registry.
    Attested,
    /// Nobody but the caller says so. The confirmation must render it as
    /// unverified.
    Claimed,
}

impl CallerTrust {
    /// Whether the wallet may present this caller's identity as established.
    ///
    /// Deliberately not `impl From<CallerTrust> for bool`: an implicit
    /// conversion is how "unverified" becomes "verified" in a refactor.
    #[must_use]
    pub const fn is_attested(self) -> bool {
        matches!(self, Self::Attested)
    }
}

/// The outcome of authorizing a caller: who the wallet will *say* it is, and
/// how much that is worth.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizedCaller {
    display_name: VisibleText,
    trust: CallerTrust,
}

impl AuthorizedCaller {
    /// The name to render, from the registry.
    #[must_use]
    pub const fn display_name(&self) -> &VisibleText {
        &self.display_name
    }

    /// How much the operating system could prove.
    #[must_use]
    pub const fn trust(&self) -> CallerTrust {
        self.trust
    }
}

/// The set of apps permitted to send intents.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CallerRegistry {
    callers: Vec<RegisteredCaller>,
}

impl CallerRegistry {
    /// An empty registry. Refuses everything, which is the correct default for
    /// a wallet that has enrolled nobody.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            callers: Vec::new(),
        }
    }

    /// Register a caller.
    ///
    /// # Errors
    ///
    /// [`IntentError::InvalidValue`] if the identifier is already registered.
    /// Two entries for one identifier is an ambiguity, and resolving it by
    /// "first match wins" is how a narrower entry gets shadowed by a wider one
    /// that was added later.
    pub fn register(&mut self, caller: RegisteredCaller) -> Result<(), IntentError> {
        if self
            .callers
            .iter()
            .any(|known| known.identifier == caller.identifier)
        {
            return Err(IntentError::InvalidValue);
        }
        self.callers.push(caller);
        Ok(())
    }

    /// Judge a request's claimed caller against the registry and whatever the
    /// platform attested.
    ///
    /// The rules, in order:
    ///
    /// 1. The claimed identifier must be registered, or the request is refused.
    /// 2. If the platform attested a caller, its package must equal the claimed
    ///    identifier **and** its signing certificate must be one of the
    ///    registered ones. Either mismatch is a refusal, not a downgrade to
    ///    [`CallerTrust::Claimed`] — an app that lies about its identity while
    ///    the OS is watching is not a caller whose request should be shown to a
    ///    user at all.
    /// 3. Otherwise the verdict is [`CallerTrust::Claimed`].
    ///
    /// # Errors
    ///
    /// [`IntentError::CallerNotAuthorized`] for an unregistered caller or an
    /// attestation that contradicts the claim.
    pub fn authorize(
        &self,
        claimed: &VisibleText,
        attestation: CallerAttestation<'_>,
    ) -> Result<AuthorizedCaller, IntentError> {
        let registered = self
            .callers
            .iter()
            .find(|known| known.identifier == *claimed)
            .ok_or(IntentError::CallerNotAuthorized)?;
        let trust = match attestation {
            CallerAttestation::Platform {
                package,
                signing_cert,
            } => {
                if package != claimed.as_str().as_bytes() {
                    return Err(IntentError::CallerNotAuthorized);
                }
                let matched = registered
                    .signing_certs
                    .iter()
                    .fold(subtle::Choice::from(0u8), |seen, known| {
                        seen | known.0.ct_eq(&signing_cert.0)
                    });
                if !bool::from(matched) {
                    return Err(IntentError::CallerNotAuthorized);
                }
                CallerTrust::Attested
            }
            CallerAttestation::None => CallerTrust::Claimed,
        };
        Ok(AuthorizedCaller {
            display_name: registered.display_name.clone(),
            trust,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn text(value: &str) -> VisibleText {
        VisibleText::new(value.as_bytes()).unwrap()
    }

    fn registry() -> CallerRegistry {
        let mut registry = CallerRegistry::new();
        registry
            .register(RegisteredCaller {
                identifier: text("cash.free2z.e2e2z"),
                display_name: text("free2z Chat"),
                signing_certs: vec![SigningCertDigest::new([0xAB; 32])],
            })
            .unwrap();
        registry
    }

    #[test]
    fn an_unregistered_caller_is_refused_on_both_platforms() {
        let registry = registry();
        assert_eq!(
            registry.authorize(&text("com.attacker.app"), CallerAttestation::None),
            Err(IntentError::CallerNotAuthorized)
        );
        assert_eq!(
            registry.authorize(
                &text("com.attacker.app"),
                CallerAttestation::Platform {
                    package: b"com.attacker.app",
                    signing_cert: SigningCertDigest::new([0xAB; 32]),
                },
            ),
            Err(IntentError::CallerNotAuthorized)
        );
    }

    #[test]
    fn android_attestation_upgrades_trust_only_on_an_exact_match() {
        let registry = registry();
        let authorized = registry
            .authorize(
                &text("cash.free2z.e2e2z"),
                CallerAttestation::Platform {
                    package: b"cash.free2z.e2e2z",
                    signing_cert: SigningCertDigest::new([0xAB; 32]),
                },
            )
            .unwrap();
        assert_eq!(authorized.trust(), CallerTrust::Attested);
        assert_eq!(authorized.display_name().as_str(), "free2z Chat");
    }

    #[test]
    fn a_wrong_signing_certificate_is_a_refusal_and_not_a_downgrade() {
        let registry = registry();
        assert_eq!(
            registry.authorize(
                &text("cash.free2z.e2e2z"),
                CallerAttestation::Platform {
                    package: b"cash.free2z.e2e2z",
                    signing_cert: SigningCertDigest::new([0xCD; 32]),
                },
            ),
            Err(IntentError::CallerNotAuthorized),
            "a side-loaded build with the same package name must not be shown to the user"
        );
    }

    #[test]
    fn a_package_that_contradicts_the_claim_is_refused() {
        let registry = registry();
        assert_eq!(
            registry.authorize(
                &text("cash.free2z.e2e2z"),
                CallerAttestation::Platform {
                    package: b"com.attacker.app",
                    signing_cert: SigningCertDigest::new([0xAB; 32]),
                },
            ),
            Err(IntentError::CallerNotAuthorized)
        );
    }

    #[test]
    fn ios_gets_a_registered_caller_but_never_an_attested_one() {
        let registry = registry();
        let authorized = registry
            .authorize(&text("cash.free2z.e2e2z"), CallerAttestation::None)
            .unwrap();
        assert_eq!(
            authorized.trust(),
            CallerTrust::Claimed,
            "there is no iOS API that would justify Attested here"
        );
        assert!(!authorized.trust().is_attested());
    }

    #[test]
    fn the_rendered_name_comes_from_the_registry_and_not_the_request() {
        let registry = registry();
        let authorized = registry
            .authorize(&text("cash.free2z.e2e2z"), CallerAttestation::None)
            .unwrap();
        assert_eq!(authorized.display_name().as_str(), "free2z Chat");
        assert_ne!(authorized.display_name().as_str(), "cash.free2z.e2e2z");
    }

    #[test]
    fn a_duplicate_registration_is_refused_rather_than_shadowed() {
        let mut registry = registry();
        assert_eq!(
            registry.register(RegisteredCaller {
                identifier: text("cash.free2z.e2e2z"),
                display_name: text("Something Else"),
                signing_certs: vec![],
            }),
            Err(IntentError::InvalidValue)
        );
    }
}
