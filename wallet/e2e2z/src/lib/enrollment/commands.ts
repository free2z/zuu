// Wire names this app's screens need without loading the modules that invoke them.

/**
 * The app-crate enrollment read.
 *
 * Seed-free: it reports what this device's store holds — the identity
 * `e2e2z_install_device_credential` wrote, if any — and nothing else. Named
 * `e2e2z_*` rather than `f2zmsg_enrollment_status` because ZUULI's command of
 * that name is the seed-holding trio's, and `src-tauri/src/lib.rs` asserts no
 * `f2zmsg_*` command is ever registered here.
 */
export const ENROLLMENT_STATUS_COMMAND = "e2e2z_enrollment_status";
