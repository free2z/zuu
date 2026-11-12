fn main() {
    // CI changes this value for every attempt so a restored Cargo target cache
    // cannot skip the schema-generating side effects of this build script.
    println!("cargo:rerun-if-env-changed=TAURI_SCHEMA_GENERATION_NONCE");
    println!("cargo:rerun-if-changed=../src/lib/purchases/policy.json");
    let policy: serde_json::Value =
        serde_json::from_str(include_str!("../src/lib/purchases/policy.json"))
            .expect("purchase inventory");
    let mut rules = String::from("const PURCHASE_RULES: &[(&str, &str, &str, &[&str])] = &[\n");
    for rule in policy["rules"].as_array().expect("purchase rules") {
        rules.push_str(&format!(
            "({}, {}, {}, &{}),\n",
            rule["prefix"],
            rule.get("suffix").unwrap_or(&serde_json::json!("")),
            rule.get("contains").unwrap_or(&serde_json::json!("")),
            rule["methods"]
        ));
    }
    rules.push_str("];\n");
    std::fs::write(
        std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("purchase_rules.rs"),
        rules,
    )
    .unwrap();
    tauri_build::build();
}
