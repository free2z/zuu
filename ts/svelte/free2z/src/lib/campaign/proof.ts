import {
  fromZatoshis,
  zatoshis,
  type Campaign,
  type FundingState,
  type Simulation,
} from "./demo.ts";
import verificationKey from "./artifacts/verification-key.json" with { type: "json" };
import manifest from "./artifacts/manifest.json" with { type: "json" };

const FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BASE_FIELD =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const POINTS = ["A", "B", "C", "Z", "T1", "T2", "T3", "Wxi", "Wxiw"];
const EVALUATIONS = [
  "eval_a",
  "eval_b",
  "eval_c",
  "eval_s1",
  "eval_s2",
  "eval_zw",
];
const canonical = (value: unknown, bound: bigint): value is string =>
  typeof value === "string" &&
  /^(0|[1-9]\d{0,76})$/.test(value) &&
  BigInt(value) < bound;
function proofShape(value: unknown): value is PhaseProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as PhaseProof;
  if (
    Object.keys(p).sort().join() !== "phaseId,proof,publicSignals" ||
    typeof p.phaseId !== "string" ||
    !p.proof ||
    typeof p.proof !== "object" ||
    Array.isArray(p.proof)
  )
    return false;
  const keys = [...POINTS, ...EVALUATIONS, "protocol", "curve"].sort().join();
  if (
    Object.keys(p.proof).sort().join() !== keys ||
    p.proof.protocol !== "plonk" ||
    p.proof.curve !== "bn128"
  )
    return false;
  return (
    POINTS.every((key) => {
      const point = p.proof[key];
      return (
        Array.isArray(point) &&
        point.length === 3 &&
        point.every((v) => canonical(v, BASE_FIELD)) &&
        point[2] === "1"
      );
    }) &&
    EVALUATIONS.every((key) => canonical(p.proof[key], FIELD)) &&
    Array.isArray(p.publicSignals) &&
    p.publicSignals.length === 6 &&
    p.publicSignals.every((v) => canonical(v, FIELD))
  );
}
export type PhaseProof = {
  phaseId: string;
  proof: Record<string, unknown>;
  publicSignals: string[];
};
export type ReaderDocument = {
  version: 1;
  campaign: Campaign;
  nonce: string;
  commitment: string | null;
  proofs: PhaseProof[];
  funding: FundingState;
  delivered: boolean[];
  publicReceipts?: { received: string; spent: string };
};
export type ProofAssets = { wasm: Uint8Array; key: Uint8Array };

/** Stable schema, not arbitrary object property order; covers the ENTIRE post configuration. */
export function configuration(c: Campaign): string {
  return JSON.stringify([
    "free2z-local-fictitious-receipts-v1",
    c.id,
    c.title,
    c.description,
    c.content,
    c.author,
    c.enabled,
    c.goal,
    c.wallet,
    c.visibility,
    c.phases.map((p) => [p.id, p.title, p.target, p.benefit]),
  ]);
}
export async function context(
  campaign: Campaign,
  nonce: string,
): Promise<string> {
  if (!/^[a-f0-9]{32}$/.test(campaign.id) || !/^[a-f0-9]{32}$/.test(nonce))
    throw new Error("Identidad local inválida.");
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([configuration(campaign), nonce])),
  );
  const hex = Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return (BigInt(`0x${hex}`) % FIELD).toString();
}
let assets: Promise<ProofAssets> | undefined;
export function loadAssets(): Promise<ProofAssets> {
  assets ??= (async () => {
    const load = async (name: "threshold.wasm" | "threshold.zkey") => {
      const response = await fetch(`/projects/campaign-demo-proof/${name}`);
      if (!response.ok) throw new Error("No se pudo cargar el circuito local.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      const hex = Array.from(new Uint8Array(hash), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      if (hex !== manifest.files[name])
        throw new Error(
          "El circuito local no coincide con su huella publicada.",
        );
      return bytes;
    };
    const [wasm, key] = await Promise.all([
      load("threshold.wasm"),
      load("threshold.zkey"),
    ]);
    return { wasm, key };
  })().catch((error) => {
    assets = undefined;
    throw error;
  });
  return assets;
}
export function readerDocument(
  campaign: Campaign,
  state: Simulation,
): ReaderDocument {
  return {
    version: 1,
    campaign: JSON.parse(JSON.stringify(campaign)),
    nonce: state.nonce,
    commitment: null,
    proofs: [],
    funding: state.funding,
    delivered: [...state.delivered],
    ...(campaign.visibility === "public"
      ? { publicReceipts: { received: state.received, spent: state.spent } }
      : {}),
  };
}
/** The reader needs ONLY its public document, never a private creator snapshot. */
export function readerView(
  doc: ReaderDocument,
  verified: (boolean | null)[] = [],
) {
  const c = doc.campaign;
  if (!c.enabled)
    return {
      funding: doc.funding,
      goalReached: null,
      allDelivered: false,
      phases: [],
    };
  const receipts = c.visibility === "public" ? doc.publicReceipts : undefined;
  const phases = c.phases.map((phase, i) => ({
    ...phase,
    delivered: Boolean(doc.delivered[i]),
    reached: receipts
      ? zatoshis(receipts.received) >= zatoshis(phase.target)
      : c.visibility === "threshold"
        ? (verified[i] ?? null)
        : null,
  }));
  return {
    funding: doc.funding,
    goalReached: phases.at(-1)?.reached ?? null,
    allDelivered: phases.every((phase) => phase.delivered),
    phases,
    ...(receipts
      ? {
          received: receipts.received,
          spent: receipts.spent,
          balance: fromZatoshis(
            zatoshis(receipts.received) - zatoshis(receipts.spent),
          ),
          percentage: Math.min(
            100,
            Number((zatoshis(receipts.received) * 10_000n) / zatoshis(c.goal)) /
              100,
          ),
        }
      : {}),
  };
}
export async function provePhase(
  campaign: Campaign,
  state: Simulation,
  index: number,
  files?: ProofAssets,
): Promise<PhaseProof> {
  const phase = campaign.phases[index];
  if (!phase || index > 4) throw new Error("Etapa inválida.");
  const { plonk } = await import("snarkjs");
  const { wasm, key } = files ?? (await loadAssets());
  const result = await plonk.fullProve(
    {
      total: zatoshis(state.received).toString(),
      salt: state.salt,
      threshold: zatoshis(phase.target).toString(),
      context: await context(campaign, state.nonce),
      phase: String(index),
    },
    wasm,
    key,
    undefined,
    undefined,
    { singleThread: true },
  );
  return {
    phaseId: phase.id,
    proof: result.proof,
    publicSignals: result.publicSignals,
  };
}
/** Expected document is provided separately by the already-published local post.
 * Neither the imported proof nor its metadata can choose the verifier key,
 * campaign, configuration, nonce, threshold, phase or amount commitment. */
export async function verifyPhase(
  expected: ReaderDocument,
  index: number,
  candidate: unknown,
): Promise<boolean | null> {
  try {
    if (
      !canonical(expected.commitment, FIELD) ||
      expected.campaign.visibility !== "threshold" ||
      !proofShape(candidate)
    )
      return null;
    if (JSON.stringify(candidate).length > 12_000) return null;
    const value = candidate as PhaseProof;
    const phase = expected.campaign.phases[index];
    if (
      !phase ||
      value.phaseId !== phase.id ||
      !Array.isArray(value.publicSignals) ||
      value.publicSignals.length !== 6 ||
      !value.proof ||
      typeof value.proof !== "object"
    )
      return null;
    const s = value.publicSignals;
    if (
      s[0] !== expected.commitment ||
      !["0", "1"].includes(s[1]) ||
      s[3] !== zatoshis(phase.target).toString() ||
      s[4] !== (await context(expected.campaign, expected.nonce)) ||
      s[5] !== String(index)
    )
      return null;
    const { plonk } = await import("snarkjs");
    if (!(await plonk.verify(verificationKey, s, value.proof))) return null;
    return s[1] === "1";
  } catch {
    return null;
  }
}
/** Only a bounded, schema-selected public package can be exported/imported. */
export function exportProofs(doc: ReaderDocument): string {
  return JSON.stringify(
    {
      version: 1,
      proofs: doc.proofs.map((p) => ({
        phaseId: p.phaseId,
        proof: p.proof,
        publicSignals: p.publicSignals,
      })),
    },
    null,
    2,
  );
}
export function importProofs(text: string): PhaseProof[] {
  if (text.length > 60_000)
    throw new Error("El paquete supera el tamaño permitido.");
  const data = JSON.parse(text);
  if (
    Object.keys(data).sort().join() !== "proofs,version" ||
    data.version !== 1 ||
    !Array.isArray(data.proofs) ||
    data.proofs.length > 5 ||
    !data.proofs.every(proofShape) ||
    new Set(data.proofs.map((p: PhaseProof) => p.phaseId)).size !==
      data.proofs.length
  )
    throw new Error("Paquete de pruebas inválido.");
  return data.proofs;
}
