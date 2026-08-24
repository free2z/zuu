#[test]
fn ordinary_values_cross_stateful_shipping_callers_and_exact_recovery_bytes() {
    tauri_plugin_zcash::wallet::send::production_route_probe::assert_ordinary_stateful_shipping_routes();
}
