import {
  validateCampaign,
  STORAGE_KEY,
  zatoshis,
  type Campaign,
  type Simulation,
} from "./demo.ts";
import { importProofs, type ReaderDocument } from "./proof.ts";

/** Starting/recovering a private draft must never delete the independent reader. */
export function saveCreator(
  storage: Pick<Storage, "setItem">,
  value: {
    version: 1;
    draft: Campaign;
    post: ReaderDocument | null;
    simulation: Simulation | null;
  },
) {
  const encoded = JSON.stringify(value);
  // Never overwrite a valid receipt witness with an invalid in-progress draft.
  restoreCreator(encoded);
  storage.setItem(STORAGE_KEY, encoded);
  if (value.post)
    storage.setItem(`${STORAGE_KEY}-reader`, JSON.stringify(value.post));
}

function campaignShape(value: unknown): value is Campaign {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Campaign;
  const strings = [
    "id",
    "title",
    "description",
    "content",
    "author",
    "goal",
    "wallet",
  ] as const;
  if (
    !strings.every((key) => typeof c[key] === "string") ||
    !/^[a-f0-9]{32}$/.test(c.id) ||
    typeof c.enabled !== "boolean" ||
    !["public", "threshold", "hidden"].includes(c.visibility)
  )
    return false;
  if (
    Object.keys(c).sort().join() !==
    "author,content,description,enabled,goal,id,phases,title,visibility,wallet"
  )
    return false;
  if (
    c.title.length > 200 ||
    c.description.length > 500 ||
    c.content.length > 30_000 ||
    c.author.length > 80 ||
    c.wallet.length > 512 ||
    c.goal.length > 32 ||
    !Array.isArray(c.phases) ||
    c.phases.length < 1 ||
    c.phases.length > 5
  )
    return false;
  return (
    c.phases.every(
      (p) =>
        p &&
        typeof p === "object" &&
        Object.keys(p).sort().join() === "benefit,id,target,title" &&
        typeof p.id === "string" &&
        /^[a-f0-9]{32}$/.test(p.id) &&
        typeof p.title === "string" &&
        p.title.length <= 80 &&
        typeof p.benefit === "string" &&
        p.benefit.length <= 200 &&
        typeof p.target === "string" &&
        p.target.length <= 32,
    ) && new Set(c.phases.map((p) => p.id)).size === c.phases.length
  );
}
function readerShape(value: unknown): value is ReaderDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const d = value as ReaderDocument;
  if (
    d.version !== 1 ||
    !campaignShape(d.campaign) ||
    validateCampaign(d.campaign) ||
    !/^[a-f0-9]{32}$/.test(d.nonce) ||
    !["open", "paused", "closed"].includes(d.funding) ||
    !Array.isArray(d.delivered) ||
    d.delivered.length !== d.campaign.phases.length ||
    !d.delivered.every((v) => typeof v === "boolean")
  )
    return false;
  if (
    d.commitment !== null &&
    (typeof d.commitment !== "string" ||
      !/^(0|[1-9]\d{0,76})$/.test(d.commitment) ||
      BigInt(d.commitment) >=
        21888242871839275222246405745257275088548364400416034343698204186575808495617n)
  )
    return false;
  if (d.campaign.visibility === "public") {
    if (
      !d.publicReceipts ||
      Object.keys(d.publicReceipts).sort().join() !== "received,spent" ||
      typeof d.publicReceipts.received !== "string" ||
      typeof d.publicReceipts.spent !== "string" ||
      zatoshis(d.publicReceipts.spent) > zatoshis(d.publicReceipts.received)
    )
      return false;
  } else if ("publicReceipts" in d) return false;
  const keys =
    "publicReceipts" in d
      ? "campaign,commitment,delivered,funding,nonce,proofs,publicReceipts,version"
      : "campaign,commitment,delivered,funding,nonce,proofs,version";
  if (Object.keys(d).sort().join() !== keys) return false;
  importProofs(JSON.stringify({ version: 1, proofs: d.proofs }));
  return true;
}
export function restoreReader(text: string): ReaderDocument {
  if (text.length > 100_000)
    throw new Error("Publicación local demasiado grande.");
  const value: unknown = JSON.parse(text);
  if (!readerShape(value)) throw new Error("Publicación local inválida.");
  return value;
}
export function restoreCreator(text: string): {
  version: 1;
  draft: Campaign;
  post: ReaderDocument | null;
  simulation: Simulation | null;
} {
  if (text.length > 150_000)
    throw new Error("Borrador local demasiado grande.");
  const value = JSON.parse(text);
  if (
    !value ||
    value.version !== 1 ||
    Object.keys(value).sort().join() !== "draft,post,simulation,version" ||
    !campaignShape(value.draft)
  )
    throw new Error("Borrador local inválido.");
  if (value.post === null && value.simulation === null) return value;
  if (
    !readerShape(value.post) ||
    !value.simulation ||
    typeof value.simulation !== "object"
  )
    throw new Error("Datos locales inválidos.");
  const s = value.simulation as Simulation;
  if (
    Object.keys(s).sort().join() !==
      "delivered,funding,nonce,received,salt,spent" ||
    typeof s.received !== "string" ||
    typeof s.spent !== "string" ||
    zatoshis(s.spent) > zatoshis(s.received) ||
    !["open", "paused", "closed"].includes(s.funding) ||
    !Array.isArray(s.delivered) ||
    s.delivered.length !== value.post.campaign.phases.length ||
    !s.delivered.every((v) => typeof v === "boolean") ||
    typeof s.salt !== "string" ||
    !/^(0|[1-9]\d{0,74})$/.test(s.salt) ||
    BigInt(s.salt) >= 1n << 248n ||
    s.nonce !== value.post.nonce ||
    s.funding !== value.post.funding ||
    JSON.stringify(s.delivered) !== JSON.stringify(value.post.delivered)
  )
    throw new Error("Datos privados locales inválidos.");
  if (
    value.post.publicReceipts &&
    (s.received !== value.post.publicReceipts.received ||
      s.spent !== value.post.publicReceipts.spent)
  )
    throw new Error("Los datos públicos y privados no coinciden.");
  return value;
}
