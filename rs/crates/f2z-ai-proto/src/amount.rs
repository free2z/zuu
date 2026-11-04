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
//! What the compiler enforces:
//!
//! * The integer inside is **private**. An amount is made with `new(u64)`
//!   (the call site names the unit) and read with `get()`; there is no
//!   `From<u64>`, no `Deref`, and no tuple constructor outside this module.
//! * Arithmetic exists only **within** a unit, and only checked
//!   (`checked_add`, `checked_sub`, `saturating_sub`); there is no `Add` /
//!   `Sub` / `Mul`, so `Nusd + Milli2z` or `Whole2z + Milli2z` does not
//!   compile.
//! * The only conversion between units is the exact one:
//!   [`Whole2z::to_milli`] and [`Milli2z::to_whole_exact`]. A conversion that
//!   rounds (nano-USD to 2Z) exists only inside [`crate::pricing`], where the
//!   one rounding rule lives.
//!
//! What it does not enforce: `get()` returns a bare `u64`, and arithmetic on
//! that is unchecked by the type system. The newtypes stop a unit mix-up at
//! every API boundary; they cannot stop code that unwraps both sides on
//! purpose.
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
        pub struct $name(u64);

        impl $name {
            /// Zero.
            pub const ZERO: Self = Self(0);

            /// An amount of this unit. The only way to make one from a bare
            /// integer: the call site names the unit.
            #[must_use]
            pub const fn new(value: u64) -> Self {
                Self(value)
            }

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
            Some(v) => Some(Milli2z::new(v)),
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
            (Some(0), Some(q)) => Some(Whole2z::new(q)),
            _ => None,
        }
    }

    /// For **display only**: this amount in 2Z with exactly three decimals,
    /// never rounded — `Milli2z::new(41_500).display_2z()` formats as
    /// `41.500`. Append the unit yourself (`"{} 2Z"`). Never parse it back,
    /// never store it, and never put it on the wire: amounts travel as
    /// integers with their unit in the field name.
    #[must_use]
    pub const fn display_2z(self) -> Display2z {
        Display2z(self.0)
    }
}

/// [`Milli2z::display_2z`]: `whole.thousandths`, exact.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Display2z(u64);

impl fmt::Display for Display2z {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let whole = self.0.checked_div(MILLI_PER_2Z).unwrap_or(0);
        let milli = self.0.checked_rem(MILLI_PER_2Z).unwrap_or(0);
        write!(f, "{whole}.{milli:03}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_to_milli_is_exact_and_checked() {
        assert_eq!(Whole2z::new(3).to_milli(), Some(Milli2z::new(3_000)));
        assert_eq!(Whole2z::new(u64::MAX).to_milli(), None);
        assert_eq!(Milli2z::new(3_000).to_whole_exact(), Some(Whole2z::new(3)));
        assert_eq!(Milli2z::new(3_001).to_whole_exact(), None);
    }

    #[test]
    fn display_2z_is_exact_with_three_decimals() {
        use alloc::format;
        assert_eq!(format!("{}", Milli2z::new(41_500).display_2z()), "41.500");
        assert_eq!(format!("{}", Milli2z::new(7).display_2z()), "0.007");
        assert_eq!(format!("{}", Milli2z::ZERO.display_2z()), "0.000");
        assert_eq!(
            format!("{}", Milli2z::new(u64::MAX).display_2z()),
            "18446744073709551.615"
        );
    }

    #[test]
    fn arithmetic_is_checked() {
        assert_eq!(Milli2z::new(1).checked_sub(Milli2z::new(2)), None);
        assert_eq!(
            Milli2z::new(1).saturating_sub(Milli2z::new(2)),
            Milli2z::ZERO
        );
        assert_eq!(Nusd::new(u64::MAX).checked_add(Nusd::new(1)), None);
        assert_eq!(
            Whole2z::new(2).checked_add(Whole2z::new(1)),
            Some(Whole2z::new(3))
        );
    }

    #[test]
    fn the_wire_form_is_a_bare_integer() {
        assert_eq!(
            serde_json::to_string(&Milli2z::new(41_500)).unwrap(),
            "41500"
        );
        assert_eq!(
            serde_json::from_str::<Whole2z>("2").unwrap(),
            Whole2z::new(2),
            "transparent"
        );
    }
}
