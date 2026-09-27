//! Amount types: one newtype per unit, so the compiler refuses to mix them.
//!
//! The wire already names every amount's unit (`_2z`, `_milli_2z`,
//! `cost_nusd`); these types carry the same unit in Rust, as ADR 0001
//! requires ("the amount types are types"). They are `#[serde(transparent)]`:
//! on the wire each is a bare JSON integer, exactly as before.
//!
//! | Type | Unit | Wire suffix |
//! |---|---|---|
//! | [`Nusd`] | nano-USD (10⁻⁹ USD) | `_nusd` |
//! | [`Milli2z`] | milli-2Z (10⁻³ 2Z) | `_milli_2z` |
//! | [`Whole2z`] | whole 2Z | `_2z` |
//!
//! There is deliberately **no** `Add` / `Sub` / `Mul` implementation, and no
//! conversion between units except the exact one ([`Whole2z::to_milli`]):
//! the workspace denies unchecked arithmetic, and a conversion that rounds
//! belongs in [`crate::pricing`], where the one rounding rule lives. Adding a
//! nano-USD cost to a milli-2Z balance is now a type error rather than a
//! review comment.
//!
//! Per-million-token *rates* ([`crate::pricing::ModelPrices`]) stay plain
//! `u64`: a rate is not an amount, it is only ever multiplied by a token
//! count inside [`crate::pricing::metered_cost_nusd`], and it is never added
//! to anything.

use core::fmt;

use serde::{Deserialize, Serialize};

use crate::pricing::MILLI_PER_2Z;

macro_rules! amount {
    ($(#[$meta:meta])* $name:ident, $unit:literal) => {
        $(#[$meta])*
        #[derive(
            Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(pub u64);

        impl $name {
            /// Zero.
            pub const ZERO: Self = Self(0);

            /// The raw integer, in this type's unit.
            #[must_use]
            pub const fn get(self) -> u64 {
                self.0
            }

            /// `self + rhs`, or `None` on overflow.
            #[must_use]
            pub const fn checked_add(self, rhs: Self) -> Option<Self> {
                match self.0.checked_add(rhs.0) {
                    Some(v) => Some(Self(v)),
                    None => None,
                }
            }

            /// `self − rhs`, or `None` if it would go below zero.
            #[must_use]
            pub const fn checked_sub(self, rhs: Self) -> Option<Self> {
                match self.0.checked_sub(rhs.0) {
                    Some(v) => Some(Self(v)),
                    None => None,
                }
            }

            /// `self − rhs`, floored at zero.
            #[must_use]
            pub const fn saturating_sub(self, rhs: Self) -> Self {
                Self(self.0.saturating_sub(rhs.0))
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{} {}", self.0, $unit)
            }
        }
    };
}

amount!(
    /// An amount of nano-USD. The unit of provider cost: `cost_nusd` is the
    /// one number the gateway hands the ledger's settle.
    Nusd,
    "nUSD"
);

amount!(
    /// An amount of milli-2Z (one thousandth of a 2Z): balances, remaining
    /// cap, the collected part of a charge and its shortfall, the splits.
    Milli2z,
    "m2Z"
);

amount!(
    /// A whole number of 2Z: charges, holds, minimum charges.
    Whole2z,
    "2Z"
);

impl Whole2z {
    /// The same amount in milli-2Z, exactly, or `None` on overflow.
    #[must_use]
    pub const fn to_milli(self) -> Option<Milli2z> {
        match self.0.checked_mul(MILLI_PER_2Z) {
            Some(v) => Some(Milli2z(v)),
            None => None,
        }
    }
}

impl Milli2z {
    /// The same amount in whole 2Z when it is a whole number of 2Z; `None`
    /// when it is not (this never rounds).
    #[must_use]
    pub const fn to_whole_exact(self) -> Option<Whole2z> {
        match (
            self.0.checked_rem(MILLI_PER_2Z),
            self.0.checked_div(MILLI_PER_2Z),
        ) {
            (Some(0), Some(q)) => Some(Whole2z(q)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_to_milli_is_exact_and_checked() {
        assert_eq!(Whole2z(3).to_milli(), Some(Milli2z(3_000)));
        assert_eq!(Whole2z(u64::MAX).to_milli(), None);
        assert_eq!(Milli2z(3_000).to_whole_exact(), Some(Whole2z(3)));
        assert_eq!(Milli2z(3_001).to_whole_exact(), None);
    }

    #[test]
    fn arithmetic_is_checked() {
        assert_eq!(Milli2z(1).checked_sub(Milli2z(2)), None);
        assert_eq!(Milli2z(1).saturating_sub(Milli2z(2)), Milli2z::ZERO);
        assert_eq!(Nusd(u64::MAX).checked_add(Nusd(1)), None);
        assert_eq!(Whole2z(2).checked_add(Whole2z(1)), Some(Whole2z(3)));
    }

    #[test]
    fn the_wire_form_is_a_bare_integer() {
        assert_eq!(serde_json::to_string(&Milli2z(41_500)).unwrap(), "41500");
        assert_eq!(
            serde_json::from_str::<Whole2z>("2").unwrap(),
            Whole2z(2),
            "transparent"
        );
    }
}
