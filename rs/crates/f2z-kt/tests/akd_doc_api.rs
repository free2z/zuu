//! Compile-only evidence for the normative AKD history-proof wire type.

use akd::HistoryProof;

fn accept_history_proof(proof: HistoryProof) -> HistoryProof {
    proof
}

#[test]
fn locked_akd_exports_the_documented_history_proof() {
    let _compile_time_type_check: fn(HistoryProof) -> HistoryProof = accept_history_proof;
}
