//! Known-answer tests for the exact cryptographic implementations in the
//! free2z messaging dependency graph.
//!
//! This crate intentionally has no production API. Its tests compare libcrux
//! output with committed standard vectors; they do not compare two calls to
//! the same implementation and call that interoperability.

#![forbid(unsafe_code)]
#![cfg_attr(
    test,
    allow(
        clippy::arithmetic_side_effects,
        clippy::expect_used,
        clippy::indexing_slicing,
        clippy::panic,
        clippy::unwrap_used
    )
)]

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        path::{Path, PathBuf},
    };

    use libcrux_ecdh::Algorithm as EcdhAlgorithm;
    use libcrux_kem::{Algorithm as KemAlgorithm, Ct, PrivateKey, PublicKey};
    use serde_json::Value;

    const VECTOR_DIR_ENV: &str = "F2Z_CRYPTO_KAT_VECTOR_DIR";

    fn vector_dir() -> PathBuf {
        env::var_os(VECTOR_DIR_ENV).map_or_else(
            || Path::new(env!("CARGO_MANIFEST_DIR")).join("vectors"),
            PathBuf::from,
        )
    }

    fn load(name: &str) -> Value {
        let path = vector_dir().join(name);
        let bytes = fs::read(&path)
            .unwrap_or_else(|error| panic!("could not read {}: {error}", path.display()));
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|error| panic!("could not parse {}: {error}", path.display()))
    }

    fn field<'a>(value: &'a Value, name: &str) -> &'a str {
        value
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("vector field {name:?} is absent or is not a string"))
    }

    fn bytes(value: &Value, name: &str) -> Vec<u8> {
        hex::decode(field(value, name))
            .unwrap_or_else(|error| panic!("vector field {name:?} is not hexadecimal: {error}"))
    }

    fn array<const N: usize>(value: &Value, name: &str) -> [u8; N] {
        bytes(value, name)
            .try_into()
            .unwrap_or_else(|actual: Vec<u8>| {
                panic!(
                    "vector field {name:?} has {} bytes; expected {N}",
                    actual.len()
                )
            })
    }

    #[test]
    fn nist_acvp_ml_kem_768_key_generation() {
        let vectors = load("nist-acvp-ml-kem-768.json");
        let vector = &vectors["key_generation"];
        let mut randomness = Vec::with_capacity(64);
        randomness.extend_from_slice(&bytes(vector, "d"));
        randomness.extend_from_slice(&bytes(vector, "z"));

        let (private_key, public_key) =
            libcrux_kem::key_gen_derand(KemAlgorithm::MlKem768, &randomness)
                .expect("NIST's 64-byte d || z input must be accepted");

        assert_eq!(
            public_key.encode(),
            bytes(vector, "ek"),
            "NIST ACVP ML-KEM-768 keyGen tcId 26 encapsulation key"
        );
        assert_eq!(
            private_key.encode(),
            bytes(vector, "dk"),
            "NIST ACVP ML-KEM-768 keyGen tcId 26 decapsulation key"
        );
    }

    #[test]
    fn nist_acvp_ml_kem_768_encapsulation() {
        let vectors = load("nist-acvp-ml-kem-768.json");
        let vector = &vectors["encapsulation"];
        let public_key = PublicKey::decode(KemAlgorithm::MlKem768, &bytes(vector, "ek"))
            .expect("NIST's encapsulation key must decode");

        let (shared_secret, ciphertext) = public_key
            .encapsulate_derand(&bytes(vector, "m"))
            .expect("NIST's 32-byte encapsulation randomness must be accepted");

        assert_eq!(
            ciphertext.encode(),
            bytes(vector, "c"),
            "NIST ACVP ML-KEM-768 encapDecap tcId 26 ciphertext"
        );
        assert_eq!(
            shared_secret.encode(),
            bytes(vector, "k"),
            "NIST ACVP ML-KEM-768 encapDecap tcId 26 shared secret"
        );
    }

    #[test]
    fn nist_acvp_ml_kem_768_decapsulation() {
        let vectors = load("nist-acvp-ml-kem-768.json");
        let vector = &vectors["decapsulation"];
        let private_key = PrivateKey::decode(KemAlgorithm::MlKem768, &bytes(vector, "dk"))
            .expect("NIST's decapsulation key must decode");
        let ciphertext = Ct::decode(KemAlgorithm::MlKem768, &bytes(vector, "c"))
            .expect("NIST's ciphertext must decode");

        let shared_secret = ciphertext
            .decapsulate(&private_key)
            .expect("NIST's valid ciphertext must decapsulate");

        assert_eq!(
            shared_secret.encode(),
            bytes(vector, "k"),
            "NIST ACVP ML-KEM-768 encapDecap tcId 86 shared secret"
        );
    }

    #[test]
    fn rfc_7748_x25519_agreement_and_all_zero_refusal() {
        let vector = load("rfc-7748-x25519.json");
        let alice_private = bytes(&vector, "alice_private");
        let alice_public = bytes(&vector, "alice_public");
        let bob_private = bytes(&vector, "bob_private");
        let bob_public = bytes(&vector, "bob_public");
        let expected_shared = bytes(&vector, "shared_secret");

        assert_eq!(
            libcrux_ecdh::secret_to_public(EcdhAlgorithm::X25519, &alice_private)
                .expect("RFC private key must be accepted"),
            alice_public,
            "RFC 7748 section 6.1 Alice public key"
        );
        assert_eq!(
            libcrux_ecdh::secret_to_public(EcdhAlgorithm::X25519, &bob_private)
                .expect("RFC private key must be accepted"),
            bob_public,
            "RFC 7748 section 6.1 Bob public key"
        );
        assert_eq!(
            libcrux_ecdh::derive(EcdhAlgorithm::X25519, &bob_public, &alice_private)
                .expect("RFC peer keys must agree"),
            expected_shared,
            "RFC 7748 section 6.1 shared secret from Alice"
        );
        assert_eq!(
            libcrux_ecdh::derive(EcdhAlgorithm::X25519, &alice_public, &bob_private)
                .expect("RFC peer keys must agree"),
            expected_shared,
            "RFC 7748 section 6.1 shared secret from Bob"
        );

        assert!(
            libcrux_ecdh::derive(EcdhAlgorithm::X25519, [0_u8; 32], &alice_private).is_err(),
            "free2z policy requires refusing an X25519 all-zero result"
        );
    }

    #[test]
    fn rfc_8032_ed25519_signatures_and_tamper_refusal() {
        let vectors = load("rfc-8032-ed25519.json");
        let vectors = vectors
            .as_array()
            .expect("RFC 8032 vector file must contain an array");
        assert_eq!(vectors.len(), 2, "RFC 8032 test 1 and test 2 must remain");

        for (index, vector) in vectors.iter().enumerate() {
            let private_key = array::<32>(vector, "private_key");
            let expected_public = array::<32>(vector, "public_key");
            let message = bytes(vector, "message");
            let expected_signature = array::<64>(vector, "signature");
            let mut actual_public = [0_u8; 32];
            libcrux_ed25519::secret_to_public(&mut actual_public, &private_key);
            assert_eq!(
                actual_public,
                expected_public,
                "RFC 8032 vector {} public key",
                index + 1
            );

            let actual_signature =
                libcrux_ed25519::sign(&message, &private_key).expect("RFC key must sign");
            assert_eq!(
                actual_signature,
                expected_signature,
                "RFC 8032 vector {} signature",
                index + 1
            );
            libcrux_ed25519::verify(&message, &expected_public, &expected_signature)
                .expect("RFC signature must verify");

            let mut tampered = expected_signature;
            tampered[0] ^= 1;
            assert!(
                libcrux_ed25519::verify(&message, &expected_public, &tampered).is_err(),
                "RFC 8032 vector {} accepted a one-bit signature mutation",
                index + 1
            );
        }
    }

    #[test]
    fn shipping_device_signer_refuses_an_all_zero_seed() {
        assert!(
            f2z_msg_mls::DeviceSigner::from_private_key([0; 32]).is_err(),
            "the shipping MLS signer boundary must refuse an all-zero seed"
        );
    }

    #[test]
    fn x_wing_draft_06_appendix_c_all_vectors() {
        let vectors = load("xwing-draft-06.json");
        let vectors = vectors
            .as_array()
            .expect("X-Wing Appendix C vector file must contain an array");
        assert_eq!(vectors.len(), 3, "all three Appendix C vectors must remain");

        for (index, vector) in vectors.iter().enumerate() {
            let seed = bytes(vector, "seed");
            assert_eq!(
                seed,
                bytes(vector, "sk"),
                "X-Wing draft-06 defines the seed itself as the encoded secret key"
            );
            let (private_key, public_key) =
                libcrux_kem::key_gen_derand(KemAlgorithm::XWingKemDraft06, &seed)
                    .expect("X-Wing's 32-byte seed must be accepted");
            assert_eq!(
                private_key.encode(),
                seed,
                "x-wing vector {} private key",
                index + 1
            );
            assert_eq!(
                public_key.encode(),
                bytes(vector, "pk"),
                "x-wing vector {} public key",
                index + 1
            );

            let (shared_secret, ciphertext) = public_key
                .encapsulate_derand(&bytes(vector, "eseed"))
                .expect("X-Wing's 64-byte encapsulation seed must be accepted");
            assert_eq!(
                ciphertext.encode(),
                bytes(vector, "ct"),
                "x-wing vector {} ciphertext",
                index + 1
            );
            assert_eq!(
                shared_secret.encode(),
                bytes(vector, "ss"),
                "x-wing vector {} shared secret",
                index + 1
            );

            let decapsulated = ciphertext
                .decapsulate(&private_key)
                .expect("X-Wing Appendix C ciphertext must decapsulate");
            assert_eq!(
                decapsulated.encode(),
                bytes(vector, "ss"),
                "x-wing vector {} decapsulated shared secret",
                index + 1
            );
        }
    }
}
