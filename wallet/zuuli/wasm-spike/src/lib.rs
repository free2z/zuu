//! A deliberately trivial WebAssembly boundary.
//!
//! This crate proves the compiler, Vite asset pipeline, browser runtime, and CI
//! contract without pretending that the spike is product functionality.

/// Adds two signed 32-bit integers using WebAssembly's native numeric ABI.
///
/// Real shared wallet or cryptographic APIs should use a pinned `wasm-bindgen`
/// toolchain for structured values instead of growing this hand-written ABI.
#[unsafe(no_mangle)]
pub extern "C" fn zuu_wasm_spike_add(left: i32, right: i32) -> i32 {
    left.saturating_add(right)
}

#[cfg(test)]
mod tests {
    use super::zuu_wasm_spike_add;

    #[test]
    fn exported_operation_is_deterministic() {
        assert_eq!(zuu_wasm_spike_add(19, 23), 42);
        assert_eq!(zuu_wasm_spike_add(i32::MAX, 1), i32::MAX);
    }
}
