//! Compile and runtime probe for issue #385.
//!
//! This is deliberately isolated from the shipping application. A successful
//! cross-build proves target compatibility only; callers must not treat it as
//! physical-device execution or performance evidence.

use libcrux_ml_kem::mlkem768;

/// Runtime feature-detection results observed by libcrux on the executing CPU.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapabilityReport {
    pub simd128: bool,
    pub simd256: bool,
    pub ml_kem_768_round_trip: bool,
}

/// Execute one deterministic ML-KEM-768 keygen/encapsulation/decapsulation.
///
/// The fixed bytes make this a reproducible capability probe, not a safe key
/// generation API. They must never be reused for product key material.
pub fn probe() -> CapabilityReport {
    let key_pair = mlkem768::generate_key_pair([0x42; 64]);
    let (ciphertext, encapsulated_secret) =
        mlkem768::encapsulate(key_pair.public_key(), [0x24; 32]);
    let decapsulated_secret = mlkem768::decapsulate(key_pair.private_key(), &ciphertext);

    CapabilityReport {
        simd128: libcrux_platform::simd128_support(),
        simd256: libcrux_platform::simd256_support(),
        ml_kem_768_round_trip: mlkem768::validate_public_key(key_pair.public_key())
            && mlkem768::validate_private_key(key_pair.private_key(), &ciphertext)
            && encapsulated_secret == decapsulated_secret,
    }
}

#[cfg(test)]
mod tests {
    use super::probe;

    #[test]
    fn ml_kem_768_round_trip_succeeds_on_the_host() {
        let report = probe();
        println!("{report:?}");
        assert!(report.ml_kem_768_round_trip);
    }
}
