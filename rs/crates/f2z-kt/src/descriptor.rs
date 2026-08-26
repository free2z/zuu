//! Building and signing the log descriptor (`KT.md` §9.1).
//!
//! The descriptor is *"a log's entire externally-relevant policy in one signed
//! document that a human can read before trusting it."* Everything in it is
//! taken from the live configuration the log is actually running on, never from
//! a second copy — a descriptor that could describe a policy the log is not
//! applying is worse than no descriptor.
//!
//! One field deserves its warning repeated where it is populated:
//! **publishing `reset_authority_pk` here does not discharge ADR 0014's
//! requirement that clients pin it.** A reset authority key a client learns
//! from the log is a key the log chose, which is no authority at all. The
//! published copy exists so a human can compare it with the pinned one.

use f2z_codec::vec::VecU8;
use f2z_kt_core::KT_VERSION;
use f2z_kt_core::descriptor::{CONFIGURATION_WHATSAPP_V1, LogDescriptor, SignedLogDescriptor};
use f2z_kt_core::types::LogId;

use crate::config::LogSettings;
use crate::error::{LogError, Result};
use crate::signer::LogSigner;

/// Build and sign the descriptor.
///
/// # Errors
///
/// [`LogError::Config`] if the resulting descriptor does not satisfy
/// [`LogDescriptor::validate`] — which catches, among other things, a
/// `genesis_log_pk` that `log_id` was not derived from. That is a
/// misconfiguration a log must not start with, because every client that pinned
/// the log would compute a different identifier for it.
pub fn sign_descriptor(
    settings: &LogSettings,
    log_id: LogId,
    vrf_public_key: f2z_codec::types::PublicKey,
    signer: &dyn LogSigner,
    published_at_ms: u64,
) -> Result<SignedLogDescriptor> {
    let descriptor = LogDescriptor {
        kt_versions: VecU8::new(vec![KT_VERSION]),
        log_id,
        log_signing_pk: signer.public_key(),
        genesis_log_pk: settings.genesis_log_pk,
        vrf_public_key,
        configuration: CONFIGURATION_WHATSAPP_V1,
        epoch_interval_seconds: settings.epoch_interval_seconds,
        max_merge_delay_seconds: settings.max_merge_delay_seconds,
        reset_cooldown_seconds: settings.reset_cooldown_seconds,
        // Published for comparison against a pinned copy. Not a trust root.
        reset_authority_pk: settings.reset_authority_pk,
        operator_name: settings.operator_name.clone(),
        operator_contact: settings.operator_contact.clone(),
        operator_jurisdiction: settings.operator_jurisdiction.clone(),
        operator_policy_url: settings.operator_policy_url.clone(),
        source_repo_url: settings.source_repo_url.clone(),
        source_commit: settings.source_commit.clone(),
        build_digest: settings.build_digest.clone(),
        published_at_ms,
    };
    descriptor
        .validate()
        .map_err(|error| LogError::Config(format!("descriptor: {error}")))?;
    let signature = signer.sign(&descriptor.signing_bytes().map_err(LogError::Kt)?)?;
    Ok(SignedLogDescriptor {
        descriptor,
        signature,
    })
}

/// The human-readable rendering that accompanies the descriptor's bytes in a
/// JSON response. A **rendering**; see [`crate::json`].
#[must_use]
pub fn render(signed: &SignedLogDescriptor) -> String {
    let descriptor = &signed.descriptor;
    let hex = crate::hexbytes::encode;
    let text = |bytes: &f2z_codec::types::ShortBytes| {
        crate::json::escape(&String::from_utf8_lossy(bytes.as_slice()))
    };
    format!(
        "\"log_id\":\"{}\",\"log_signing_pk\":\"{}\",\"genesis_log_pk\":\"{}\",\
         \"vrf_public_key\":\"{}\",\"configuration\":{},\"epoch_interval_seconds\":{},\
         \"max_merge_delay_seconds\":{},\"reset_cooldown_seconds\":{},\
         \"reset_authority_pk\":\"{}\",\"operator_name\":\"{}\",\"operator_contact\":\"{}\",\
         \"operator_jurisdiction\":\"{}\",\"operator_policy_url\":\"{}\",\
         \"source_repo_url\":\"{}\",\"source_commit\":\"{}\",\"build_digest\":\"{}\",\
         \"published_at_ms\":{}",
        hex(descriptor.log_id.as_bytes()),
        hex(descriptor.log_signing_pk.as_bytes()),
        hex(descriptor.genesis_log_pk.as_bytes()),
        hex(descriptor.vrf_public_key.as_bytes()),
        descriptor.configuration,
        descriptor.epoch_interval_seconds,
        descriptor.max_merge_delay_seconds,
        descriptor.reset_cooldown_seconds,
        hex(descriptor.reset_authority_pk.as_bytes()),
        text(&descriptor.operator_name),
        text(&descriptor.operator_contact),
        text(&descriptor.operator_jurisdiction),
        text(&descriptor.operator_policy_url),
        text(&descriptor.source_repo_url),
        text(&descriptor.source_commit),
        text(&descriptor.build_digest),
        descriptor.published_at_ms,
    )
}

#[cfg(test)]
mod tests {
    use f2z_codec::types::PublicKey;
    use f2z_kt_core::labels;

    use super::{render, sign_descriptor};
    use crate::config::LogSettings;
    use crate::signer::{FileSigner, LogSigner as _};

    #[test]
    fn a_descriptor_verifies_and_derives_the_log_id_it_claims() {
        let signer = FileSigner::from_seed(&[4u8; 32]);
        let genesis = signer.public_key();
        let settings = LogSettings::defaults(genesis, PublicKey::new([8u8; 32])).unwrap();
        let signed = sign_descriptor(
            &settings,
            labels::log_id(&genesis),
            PublicKey::new([7u8; 32]),
            &signer,
            1_700_000,
        )
        .unwrap();

        signed.verify().unwrap();
        assert_eq!(signed.derived_log_id(), signed.descriptor.log_id);
        assert!(
            signed
                .descriptor
                .matches_pinned_reset_authority(&PublicKey::new([8u8; 32]))
        );
    }

    #[test]
    fn a_log_id_that_was_not_derived_from_the_genesis_key_refuses_to_start() {
        let signer = FileSigner::from_seed(&[5u8; 32]);
        let settings =
            LogSettings::defaults(signer.public_key(), PublicKey::new([8u8; 32])).unwrap();
        // A log_id from somebody else's genesis key: every client that pinned
        // this log would compute a different identifier for it.
        let wrong = f2z_kt_core::types::LogId::new([1u8; 32]);
        assert!(sign_descriptor(&settings, wrong, PublicKey::new([7u8; 32]), &signer, 1).is_err());
    }

    #[test]
    fn the_json_rendering_escapes_an_operator_supplied_field() {
        let signer = FileSigner::from_seed(&[6u8; 32]);
        let genesis = signer.public_key();
        let mut settings = LogSettings::defaults(genesis, PublicKey::new([8u8; 32])).unwrap();
        settings.operator_name = f2z_codec::types::ShortBytes::new(b"ev\"il".to_vec()).unwrap();
        let signed = sign_descriptor(
            &settings,
            labels::log_id(&genesis),
            PublicKey::new([7u8; 32]),
            &signer,
            1,
        )
        .unwrap();
        let rendered = render(&signed);
        assert!(rendered.contains("ev\\\"il"));
    }

    #[test]
    fn an_operator_name_ending_in_a_backslash_cannot_escape_its_own_field() {
        // The assertion whose absence made zuu#763 invisible. `escape`'s
        // backslash arm was deletable with every test in every dependent
        // crate still green, because the only test named for this property
        // exercised the quotation mark and nothing asserted against a
        // *rendered* field at all.
        //
        // It matters here and not only in `crate::json` because `render`
        // splices the escaped value straight into a hand-built JSON string. A
        // trailing backslash that reaches the output unescaped escapes the
        // closing quotation mark instead of standing for itself: the field
        // reads `"operator_name":"free2z\"` , never terminates, and swallows
        // the rest of the descriptor — every field after it included.
        //
        // Nothing upstream prevents this. `LogDescriptor::validate` places no
        // restriction on operator string bytes (see `crate::json`'s test note),
        // so the escaper is the only thing standing here.
        let signer = FileSigner::from_seed(&[9u8; 32]);
        let genesis = signer.public_key();
        let mut settings = LogSettings::defaults(genesis, PublicKey::new([8u8; 32])).unwrap();
        settings.operator_name = f2z_codec::types::ShortBytes::new(b"free2z\\".to_vec()).unwrap();
        let signed = sign_descriptor(
            &settings,
            labels::log_id(&genesis),
            PublicKey::new([7u8; 32]),
            &signer,
            1,
        )
        .unwrap();
        let rendered = render(&signed);

        // The backslash stands for itself, and the field still ends where it
        // should: the very next thing is the comma and the next member's key.
        assert!(
            rendered.contains("\"operator_name\":\"free2z\\\\\",\"operator_contact\":"),
            "operator_name did not render as a terminated field: {rendered}"
        );
        // And the broken rendering is absent by name, so this fails loudly
        // rather than by omission if the arm is ever removed.
        assert!(
            !rendered.contains("\"operator_name\":\"free2z\\\",\"operator_contact\":"),
            "a trailing backslash escaped the closing quotation mark: {rendered}"
        );
    }
}
