//! A string that must not leak: a refresh token, an access token, a stored
//! session blob.

use std::fmt;

use zeroize::Zeroize;

/// A secret string. Its `Debug` never prints the value, and the bytes are
/// overwritten when it is dropped.
///
/// Read it with [`Secret::expose`] at the one place the value is needed (an
/// `Authorization` header, a form field, a keychain write), and nowhere else.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// Wrap a value.
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The value. Keep the borrow short.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(***)")
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Self {
        Self(value)
    }
}

#[cfg(test)]
mod tests {
    use super::Secret;

    #[test]
    fn debug_never_prints_the_value() {
        let s = Secret::new("rt_very_secret");
        assert_eq!(format!("{s:?}"), "Secret(***)");
        assert_eq!(s.expose(), "rt_very_secret");
    }
}
