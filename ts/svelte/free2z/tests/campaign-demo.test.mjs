import assert from "node:assert/strict";
import test from "node:test";
import {
  contribute,
  deliver,
  emptySimulation,
  publicCampaign,
  sampleCampaign,
  spend,
  validateCampaign,
  zatoshis,
} from "../src/lib/campaign/demo.ts";

test("private reader projections never infer thresholds from private amounts", () => {
  const campaign = sampleCampaign();
  const state = contribute(emptySimulation(3), "18.4");
  for (const visibility of ["threshold", "hidden"]) {
    const view = publicCampaign({ ...campaign, visibility }, state);
    for (const key of [
      "received",
      "spent",
      "balance",
      "percentage",
      "supporters",
    ])
      assert.equal(key in view, false);
    assert.equal(view.goalReached, null);
    assert.equal(view.phases[0].reached, null);
  }
  assert.equal(
    publicCampaign(campaign, state, [true, false, false]).phases[0].reached,
    true,
  );
  assert.equal(
    publicCampaign({ ...campaign, visibility: "hidden" }, state, [true])
      .phases[0].reached,
    null,
  );
});
test("exact zatoshis, spending and receiving lifecycle preserve cumulative funding", () => {
  const campaign = { ...sampleCampaign(), visibility: "public" };
  let state = contribute(emptySimulation(3), "30.00000001");
  state = spend(state, "29.99999999");
  assert.equal(state.received, "30.00000001");
  assert.equal(publicCampaign(campaign, state).balance, "0.00000002");
  assert.equal(publicCampaign(campaign, state).goalReached, true);
  const nonce = state.nonce;
  assert.equal(spend(state, "0.00000001").nonce, nonce);
  for (const funding of ["paused", "closed"]) {
    const paused = { ...state, funding };
    assert.equal(contribute(paused, "1"), paused);
  }
  assert.equal(zatoshis("0.00000001"), 1n);
  assert.throws(() => zatoshis("0.000000001"));
  assert.throws(() => zatoshis("184467440737.09551616"));
  assert.throws(() => zatoshis("-1"));
});
test("benefit delivery is separately author-reported and new drafts start undelivered", () => {
  const campaign = sampleCampaign();
  const empty = emptySimulation(3);
  assert.equal(deliver(empty, campaign, 0), empty);
  let funded = contribute(empty, "30");
  assert.equal(publicCampaign(campaign, funded).allDelivered, false);
  for (let i = 0; i < 3; i++) funded = deliver(funded, campaign, i);
  assert.equal(publicCampaign(campaign, funded).allDelivered, true);
  assert.equal(funded.funding, "open");
  assert.equal(
    publicCampaign(campaign, emptySimulation(3)).allDelivered,
    false,
  );
});
test("post/campaign validation bounds configurations and cumulative phase targets", () => {
  const campaign = sampleCampaign();
  assert.equal(validateCampaign(campaign), "");
  assert.ok(validateCampaign({ ...campaign, content: "" }));
  assert.ok(validateCampaign({ ...campaign, goal: "NaN" }));
  assert.ok(
    validateCampaign({
      ...campaign,
      phases: [{ ...campaign.phases[0], target: "31" }],
    }),
  );
  assert.ok(
    validateCampaign({
      ...campaign,
      phases: [{ ...campaign.phases[0], target: "5" }],
    }),
  );
  assert.equal(
    validateCampaign({ ...campaign, enabled: false, phases: [] }),
    "",
  );
});
