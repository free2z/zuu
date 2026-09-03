use f2z_msg_identity::DeviceSignatureKey;

fn caller_chosen_mls_bytes(key: &DeviceSignatureKey) {
    let _ = key.sign_mls_content(b"caller-chosen MLS bytes");
}

fn main() {}
