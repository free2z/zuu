fn main() {
    // CI changes this value for every attempt so a restored Cargo target cache
    // cannot skip the schema-generating side effects of this build script.
    println!("cargo:rerun-if-env-changed=TAURI_SCHEMA_GENERATION_NONCE");
    tauri_build::build();
}
