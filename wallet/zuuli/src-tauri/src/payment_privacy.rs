//! Native creator-payment disclosure. The input is the wallet's validated
//! receiver capability, never an address prefix or a claim from the caller.

pub(crate) fn disclosure(can_receive_shielded: bool) -> &'static str {
    if can_receive_shielded {
        "This destination supports shielded ZEC. ZUULI prefers shielded receivers."
    } else {
        "PRIVACY DOWNGRADE: this destination cannot receive shielded ZEC. The recipient and amount will be public on chain, and a private memo cannot be delivered. Cancel and ask the creator for a shielded address if you want a private tip."
    }
}

#[cfg(test)]
mod tests {
    use super::disclosure;

    #[test]
    fn transparent_only_destinations_explicitly_disclose_the_downgrade() {
        let text = disclosure(false);
        assert!(text.contains("PRIVACY DOWNGRADE"));
        assert!(text.contains("recipient and amount will be public"));
        assert!(text.contains("private memo cannot be delivered"));
        assert!(text.contains("Cancel and ask the creator"));
        assert!(!text.contains("supports shielded ZEC"));
    }

    #[test]
    fn shielded_support_is_distinct_from_a_transparent_payment() {
        let text = disclosure(true);
        assert!(text.contains("supports shielded ZEC"));
        assert!(text.contains("prefers shielded receivers"));
        assert!(!text.contains("PRIVACY DOWNGRADE"));
        assert!(!text.contains("will be public"));
    }
}
