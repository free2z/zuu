// Realistic fixtures so ZUULI is fully explorable — and screenshots look
// premium — with no backend and no synced node. Served by the api layer
// whenever useMock() is true (plain browser / VITE_MOCK=1).

import type { AuthUser, SimpleCreator, TuziTransaction } from "./types";

// Mutated in place (via `Object.assign`, never reassigned — an ES module
// import binding can't be reassigned from outside) so a saved profile edit
// (`profile.update`) persists across the mock session and reflects in `auth.me()`.
export const mockUser: AuthUser = {
  id: 1,
  username: "demo-creator",
  email: "demo.creator@example.com",
  free2zaddr: "demo-creator",
  display_name: "Demo Creator",
  image: null,
  banner: null,
  bio: "Building on Zcash. Shielded by default.",
  p2paddr: "",
  member_price: null,
  can_stream: false,
  is_verified: false,
  tuzis: 4210,
  zcashLinked: true,
  // Starts UNLINKED so the profile's "Linked identities" panel is demoable
  // end-to-end in mock mode: "Link Zcash key" flips this to the signed
  // address (see `mockAssociateZcash`).
  zcash_identity: null,
};

/**
 * Mock `auth.zcashAssociate()` — links `address` to the mock account, mirroring
 * the real backend's dual-mode `/api/auth/zcash/login/` (authenticated call =
 * associate). Mutates `mockUser` in place (never reassigned) so the linked
 * state persists across the mock session, same pattern as `profile.update`.
 *
 * Throws the same friendly conflict message the real 409 path throws
 * (`auth.zcashAssociate`) if this account is already linked to a DIFFERENT
 * address — so re-running the flow against a fresh key demoes the conflict
 * state instead of always silently succeeding.
 */
export function mockAssociateZcash(address: string): AuthUser {
  if (mockUser.zcash_identity && mockUser.zcash_identity !== address) {
    throw new Error(
      "That Zcash key is already linked — either to a different free2z account, or this account already has a linked Zcash identity. Unlink it there first, or sign with a different key.",
    );
  }
  Object.assign(mockUser, { zcash_identity: address, zcashLinked: true });
  return { ...mockUser };
}

const creator = (
  username: string,
  display_name: string,
  bio: string,
  extra: Partial<SimpleCreator> = {},
): SimpleCreator => ({
  username,
  free2zaddr: username,
  display_name,
  bio,
  image: null,
  is_verified: false,
  ...extra,
});

export const mockCreators: SimpleCreator[] = [
  creator(
    "zooko",
    "Zooko",
    "---\nsocials:\n  twitter: zooko\n  github: zooko\n  website: electriccoin.co\n---\n\nFounder-ish energy, shielded by default — writing at unreasonable length about note commitments, viewing keys, and why financial privacy is a public good rather than a premium feature.",
    {
      is_verified: true,
      zpages: 12,
      member_price: 500,
      // Live now — demos is_live:true.
      is_live: true,
    },
  ),
  creator(
    "mining_maya",
    "Maya Andonovska-Rasmussen ⛏️",
    "Halo2 circuits, late-night proofs, and unreasonably long commit messages about constraint systems.",
    {
      is_verified: true,
      zpages: 7,
      member_price: 250,
      is_live: true, // PPV stream live now.
    },
  ),
  creator("f2z", "Free2Z", "The zero-knowledge creator platform, metered end to end in 2Zs.", {
    is_verified: true,
    zpages: 24,
    member_price: null,
    is_live: false, // Offline — demos is_live:false (button hidden).
  }),
  creator(
    "nine",
    "Nine Anonymous-Broadcaster",
    "Privacy maximalist. Streams from the void, on a schedule known only to the void.",
    {
      zpages: 5,
      member_price: 100,
      is_live: true, // Broadcast live now.
    },
  ),
  creator(
    "halo_hana",
    "Hana Recursive-Proofs Nakamura",
    "Recursive proofs & zk-SNARK explainers, from the polynomial up.",
    { zpages: 9, member_price: 300 },
  ),
  creator(
    "shielded_sam",
    "Antidisestablishmentarianismsam",
    "On-chain privacy, off-chain vibes.",
    { zpages: 3, member_price: null },
  ),
];

export const mockTransactions: TuziTransaction[] = [
  {
    id: 1,
    amount: 2000,
    tuzis_credited: 2000,
    timestamp: new Date(Date.now() - 3 * 86400000).toISOString(),
    kind: "buy",
  },
  {
    id: 2,
    amount: 4,
    tuzis_credited: -4,
    timestamp: new Date(Date.now() - 2 * 3600000).toISOString(),
    kind: "ai",
    counterparty: "Claude Opus 4.8",
  },
  {
    id: 3,
    amount: 250,
    tuzis_credited: -250,
    timestamp: new Date(Date.now() - 60 * 60000).toISOString(),
    kind: "ppv",
    counterparty: "mining_maya",
  },
  {
    id: 4,
    amount: 500,
    tuzis_credited: -500,
    timestamp: new Date(Date.now() - 30 * 60000).toISOString(),
    kind: "donate",
    counterparty: "zooko",
  },
  {
    id: 5,
    amount: 12,
    tuzis_credited: -12,
    timestamp: new Date(Date.now() - 15 * 60000).toISOString(),
    kind: "ai",
    counterparty: "Llama 3.3 70B Instruct — running on our own hardware",
  },
];

// ─── Discovery / search fixtures ──────────────────────────────────────────────

/** Case-insensitive creator search over username + display name (mock). */
export function mockSearchCreators(query: string): SimpleCreator[] {
  const q = query.trim().toLowerCase();
  if (!q) return mockCreators;
  return mockCreators.filter(
    (c) =>
      c.username.toLowerCase().includes(q) ||
      (c.display_name || "").toLowerCase().includes(q),
  );
}

