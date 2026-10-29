pragma circom 2.2.2;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// LOCAL FICTITIOUS receipts only. No Zcash transaction/address is authenticated.
// Context is SHA-256(domain, campaign, complete configuration, snapshot nonce),
// reduced to the BN254 scalar field by the application and independently rebuilt
// by the reader. Both total and threshold are unsigned 64-bit zatoshi integers.
template CampaignThreshold() {
    signal input total;
    signal input salt;
    signal input threshold;
    signal input context;
    signal input phase;
    signal output commitment;
    signal output reached;
    signal output phaseBinding;

    component totalBits = Num2Bits(64);
    totalBits.in <== total;
    component thresholdBits = Num2Bits(64);
    thresholdBits.in <== threshold;
    component saltBits = Num2Bits(248);
    saltBits.in <== salt;
    component phaseBits = Num2Bits(3);
    phaseBits.in <== phase;

    component receiptCommit = Poseidon(3);
    receiptCommit.inputs[0] <== total;
    receiptCommit.inputs[1] <== salt;
    receiptCommit.inputs[2] <== context;
    commitment <== receiptCommit.out;

    component comparison = GreaterEqThan(64);
    comparison.in[0] <== total;
    comparison.in[1] <== threshold;
    reached <== comparison.out;

    component bindPhase = Poseidon(3);
    bindPhase.inputs[0] <== context;
    bindPhase.inputs[1] <== threshold;
    bindPhase.inputs[2] <== phase;
    phaseBinding <== bindPhase.out;
}

// Output ordering is commitment, reached, phaseBinding; then these public inputs.
component main {public [threshold, context, phase]} = CampaignThreshold();
