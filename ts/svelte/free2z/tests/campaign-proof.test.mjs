import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { plonk } from "snarkjs";
import {
  contribute,
  blankCampaign,
  STORAGE_KEY,
  emptySimulation,
  sampleCampaign,
} from "../src/lib/campaign/demo.ts";
import {
  context,
  exportProofs,
  importProofs,
  provePhase,
  readerDocument,
  readerView,
  verifyPhase,
} from "../src/lib/campaign/proof.ts";
import {
  restoreCreator,
  restoreReader,
  saveCreator,
} from "../src/lib/campaign/storage.ts";

import { ensureCampaignProofAssets } from "../scripts/campaign-proof-assets.mjs";

// Build (or confirm) the proving assets here rather than in the global
// `pretest`, so a failure only affects this file. No network is involved.
await ensureCampaignProofAssets();
const root = new URL(
  "../static/projects/campaign-demo-proof/",
  import.meta.url,
);
const files = {
  wasm: new Uint8Array(await readFile(new URL("threshold.wasm", root))),
  key: new Uint8Array(await readFile(new URL("threshold.zkey", root))),
};
const copy = (value) => JSON.parse(JSON.stringify(value));

test("fixed circuit artifacts match reviewed source and authenticated setup manifest", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", root), "utf8"),
  );
  const source = await readFile(
    new URL("../circuits/campaign-threshold.circom", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    manifest.circuitSha256,
  );
  for (const [name, expected] of Object.entries(manifest.files))
    assert.equal(
      createHash("sha256")
        .update(await readFile(new URL(name, root)))
        .digest("hex"),
      expected,
    );
  for (const name of ["manifest.json", "verification-key.json"])
    assert.deepEqual(
      await readFile(new URL(name, root)),
      await readFile(
        new URL(`../src/lib/campaign/artifacts/${name}`, import.meta.url),
      ),
      "bundled trust data matches public artifacts",
    );
  assert.equal(
    manifest.powersOfTauBlake2b512,
    "ded2694169b7b08e898f736d5de95af87c3f1a64594013351b1a796dbee393bd825f88f9468c84505ddd11eb0b1465ac9b43b9064aa8ec97f2b73e04758b8a4a",
  );
  assert.match(manifest.mpcVerification, /passed.*native BLAKE2b-512/);
  assert.equal(
    manifest.verifierUtilitySha256,
    "a2cf75004f68ed70fbce610521715150da9e82d68f6aed3fb6f091855cb5098d",
  );
  const key = JSON.parse(
    await readFile(new URL("verification-key.json", root), "utf8"),
  );
  assert.equal(key.protocol, "plonk");
  assert.equal(key.nPublic, 6);
});

test(
  "real PLONK proofs verify both outcomes, bind context and reject forged/stale/private imports",
  { timeout: 120000 },
  async () => {
    const campaign = sampleCampaign();
    let state = contribute(emptySimulation(3), "12.5");
    const doc = readerDocument(campaign, state);
    try {
      const first = await provePhase(campaign, state, 0, files);
      const second = await provePhase(campaign, state, 1, files);
      doc.commitment = first.publicSignals[0];
      doc.proofs = [first, second];
      assert.equal(
        second.publicSignals[0],
        doc.commitment,
        "all phases commit to the same hidden total",
      );
      assert.equal(await verifyPhase(doc, 0, first), true);
      assert.equal(
        await verifyPhase(doc, 1, second),
        false,
        "below-threshold proof is false, not unknown or true",
      );
      assert.equal(await verifyPhase(doc, 2, undefined), null);
      const exported = exportProofs(doc);
      const imported = importProofs(exported);
      assert.equal(await verifyPhase(doc, 0, imported[0]), true);
      const allKeys = [];
      JSON.parse(exported, (key, value) => {
        allKeys.push(key);
        return value;
      });
      for (const privateKey of [
        "total",
        "received",
        "spent",
        "salt",
        "simulation",
        "witness",
      ])
        assert.equal(allKeys.includes(privateKey), false);
      const packageDoc = restoreReader(JSON.stringify(doc));
      assert.equal(
        await verifyPhase(packageDoc, 0, packageDoc.proofs[0]),
        true,
        "independent reader has no creator witness",
      );
      assert.equal("publicReceipts" in packageDoc, false);
      assert.equal("received" in readerView(packageDoc, [true, false]), false);
      const flip = copy(second);
      flip.publicSignals[1] = "1";
      assert.equal(await verifyPhase(doc, 1, flip), null);
      const point = copy(first);
      point.proof.A[0] = "0";
      assert.equal(await verifyPhase(doc, 0, point), null);
      const evaluation = copy(first);
      evaluation.proof.eval_a = String(BigInt(evaluation.proof.eval_a) + 1n);
      assert.equal(await verifyPhase(doc, 0, evaluation), null);
      const noncanonical = copy(first);
      noncanonical.proof.eval_a = `0${noncanonical.proof.eval_a}`;
      assert.equal(await verifyPhase(doc, 0, noncanonical), null);
      const extra = copy(first);
      extra.proof.witness = state.salt;
      assert.equal(await verifyPhase(doc, 0, extra), null);
      assert.throws(() =>
        importProofs(JSON.stringify({ version: 1, proofs: [extra] })),
      );
      const wrongCampaign = copy(doc);
      wrongCampaign.campaign.id = "f".repeat(32);
      assert.equal(await verifyPhase(wrongCampaign, 0, first), null);
      const wrongConfig = copy(doc);
      wrongConfig.campaign.phases[0].benefit = "Una entrega nueva";
      assert.equal(await verifyPhase(wrongConfig, 0, first), null);
      assert.equal(await verifyPhase(doc, 1, first), null);
      const forgedPhase = copy(first);
      forgedPhase.phaseId = campaign.phases[1].id;
      forgedPhase.publicSignals[5] = "1";
      forgedPhase.publicSignals[3] = "2000000000";
      assert.equal(await verifyPhase(doc, 1, forgedPhase), null);
      const wrongCommitment = copy(doc);
      wrongCommitment.commitment = "1";
      assert.equal(await verifyPhase(wrongCommitment, 0, first), null);
      state = contribute(state, "7.5");
      const next = readerDocument(campaign, state);
      next.commitment = doc.commitment;
      assert.equal(
        await verifyPhase(next, 0, first),
        null,
        "old snapshot rejected even when first threshold outcome remains true",
      );
      const witness = {
        total: "0",
        salt: "1",
        threshold: "1",
        context: await context(campaign, state.nonce),
        phase: "0",
      };
      for (const input of [
        { ...witness, total: "18446744073709551616" },
        { ...witness, total: "-1" },
        { ...witness, threshold: "18446744073709551616" },
        { ...witness, salt: (1n << 248n).toString() },
      ])
        await assert.rejects(
          plonk.fullProve(input, files.wasm, files.key, undefined, undefined, {
            singleThread: true,
          }),
        );
    } finally {
      if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
    }
  },
);

test("persistent local drafts reject malformed author state without mutating reader records", () => {
  const campaign = sampleCampaign();
  const simulation = emptySimulation(3);
  const post = readerDocument(campaign, simulation);
  const local = { version: 1, draft: campaign, post, simulation };
  assert.equal(
    restoreCreator(JSON.stringify(local)).draft.title,
    campaign.title,
  );
  assert.equal(
    restoreReader(JSON.stringify(post)).campaign.title,
    campaign.title,
  );
  for (const mutate of [
    (v) => (v.draft.title = null),
    (v) => (v.draft.author = {}),
    (v) => (v.simulation.received = "NaN"),
    (v) => (v.simulation.spent = "1"),
    (v) => (v.simulation.funding = "unknown"),
    (v) => (v.simulation.delivered = [false]),
    (v) => (v.simulation.salt = (1n << 248n).toString()),
    (v) => (v.simulation.nonce = "a".repeat(32)),
  ]) {
    const malformed = copy(local);
    mutate(malformed);
    assert.throws(() => restoreCreator(JSON.stringify(malformed)));
  }
  const leak = copy(post);
  leak.publicReceipts = { received: "12.5", spent: "0" };
  assert.throws(() => restoreReader(JSON.stringify(leak)));
});

test("ordinary posts ignore disabled invalid campaign configuration", () => {
  const campaign = {
    ...sampleCampaign(),
    enabled: false,
    visibility: "public",
    goal: "0",
    phases: [{ id: "a".repeat(32), title: "", target: "NaN", benefit: "" }],
  };
  const doc = readerDocument(campaign, emptySimulation(1));
  const restored = restoreReader(JSON.stringify(doc));
  const view = readerView(restored);
  assert.equal(view.goalReached, null);
  assert.deepEqual(view.phases, []);
  assert.equal("received" in view, false);
});

test("recovering or starting a creator draft preserves the independent public publication", () => {
  const campaign = sampleCampaign();
  const simulation = emptySimulation(3);
  const post = readerDocument(campaign, simulation);
  const store = new Map();
  const storage = { setItem: (key, value) => store.set(key, value) };
  saveCreator(storage, { version: 1, draft: campaign, post, simulation });
  const published = store.get(`${STORAGE_KEY}-reader`);
  const corrupt = JSON.parse(store.get(STORAGE_KEY));
  corrupt.draft.title = null;
  assert.throws(() => restoreCreator(JSON.stringify(corrupt)));
  saveCreator(storage, {
    version: 1,
    draft: blankCampaign(),
    post: null,
    simulation: null,
  });
  assert.equal(store.get(`${STORAGE_KEY}-reader`), published);
  store.delete(STORAGE_KEY);
  saveCreator(storage, {
    version: 1,
    draft: blankCampaign(),
    post: null,
    simulation: null,
  });
  assert.equal(
    restoreReader(store.get(`${STORAGE_KEY}-reader`)).campaign.id,
    campaign.id,
  );
});

test("invalid autosaved editor input cannot replace the creator's saved receipt witness", () => {
  const campaign = sampleCampaign();
  const simulation = contribute(emptySimulation(3), "12.5");
  const post = readerDocument(campaign, simulation);
  const store = new Map();
  const storage = { setItem: (key, value) => store.set(key, value) };
  const original = { version: 1, draft: campaign, post, simulation };
  saveCreator(storage, original);
  const saved = store.get(STORAGE_KEY);
  for (const mutate of [
    (draft) => (draft.title = "T".repeat(201)),
    (draft) => (draft.goal = "1".repeat(33)),
    (draft) => (draft.phases[0].target = "1".repeat(33)),
  ]) {
    const bad = copy(original);
    mutate(bad.draft);
    assert.throws(() => saveCreator(storage, bad));
    assert.equal(store.get(STORAGE_KEY), saved);
    const restored = restoreCreator(store.get(STORAGE_KEY));
    assert.equal(restored.simulation.received, "12.5");
    assert.equal(restored.simulation.salt, simulation.salt);
    assert.equal(restored.post.campaign.id, campaign.id);
  }
});
