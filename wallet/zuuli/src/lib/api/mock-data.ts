// Realistic fixtures so ZUULI is fully explorable — and screenshots look
// premium — with no backend and no synced node. Served by the api layer
// whenever useMock() is true (plain browser / VITE_MOCK=1).

import type {
  AIModel,
  Article,
  ArticleFeedPage,
  ArticleFeedParams,
  AuthUser,
  CreatorDetail,
  Livestream,
  PromptResponse,
  SimpleCreator,
  TuziTransaction,
} from "./types";

export const mockUser: AuthUser = {
  id: 1,
  username: "skyl",
  email: "skylar.saveland@gmail.com",
  free2zaddr: "skyl",
  display_name: "Skylar",
  image: null,
  tuzis: 4210,
  zcashLinked: true,
};

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
  creator("zooko", "Zooko", "Founder-ish energy. Shielded by default.", {
    is_verified: true,
    zpages: 12,
    member_price: 500,
  }),
  creator("mining_maya", "Maya ⛏️", "Halo2 circuits & late-night proofs.", {
    is_verified: true,
    zpages: 7,
    member_price: 250,
  }),
  creator("f2z", "Free2Z", "The zero-knowledge creator platform.", {
    is_verified: true,
    zpages: 24,
    member_price: null,
  }),
  creator("nine", "Nine", "Privacy maximalist. Streams from the void.", {
    zpages: 5,
    member_price: 100,
  }),
  creator("halo_hana", "Hana", "Recursive proofs & zk-SNARK explainers.", {
    zpages: 9,
    member_price: 300,
  }),
  creator("shielded_sam", "Sam", "On-chain privacy, off-chain vibes.", {
    zpages: 3,
    member_price: null,
  }),
];

export const mockModels: AIModel[] = [
  {
    id: "m-anthropic-opus",
    model: "claude-opus-4-8",
    display_name: "Claude Opus 4.8",
    system_message: "You are a helpful, privacy-respecting assistant.",
    max_tokens: 8192,
    is_ga: true,
    order: 1,
    input_price: "0.000003",
    output_price: "0.000015",
    markup: "1.15",
    provider: "anthropic",
  },
  {
    id: "m-openai-4o",
    model: "gpt-4o",
    display_name: "GPT-4o",
    system_message: "You are a helpful assistant.",
    max_tokens: 4096,
    is_ga: true,
    order: 2,
    input_price: "0.0000025",
    output_price: "0.00001",
    markup: "1.15",
    provider: "openai",
  },
  {
    id: "m-xai-grok",
    model: "grok-2",
    display_name: "Grok 2",
    system_message: "You are Grok.",
    max_tokens: 4096,
    is_ga: true,
    order: 3,
    input_price: "0.000002",
    output_price: "0.00001",
    markup: "1.2",
    provider: "xai",
  },
  {
    id: "m-kimi-k2",
    model: "kimi-k2",
    display_name: "Kimi K2",
    system_message: "You are Kimi.",
    max_tokens: 8192,
    is_ga: true,
    order: 4,
    input_price: "0.0000006",
    output_price: "0.0000025",
    markup: "1.2",
    provider: "kimi",
  },
  {
    id: "m-local-llama",
    model: "llama-3.3-70b",
    display_name: "Llama 3.3 70B (on our hardware)",
    system_message: "You are a private, open-source assistant.",
    max_tokens: 8192,
    is_ga: true,
    order: 5,
    input_price: "0.0000004",
    output_price: "0.0000008",
    markup: "1.1",
    provider: "local",
  },
];

export const mockLivestreams: Livestream[] = [
  {
    id: "ls-1",
    username: "nine",
    creator: mockCreators[3],
    title: "Shielded & Chill — building a Zcash light client live",
    kind: "broadcast",
    live: true,
    participants: 214,
    price_tuzis: 0,
    thumbnail: null,
    started_at: new Date(Date.now() - 42 * 60000).toISOString(),
    category: "Technology",
  },
  {
    id: "ls-2",
    username: "mining_maya",
    creator: mockCreators[1],
    title: "PPV: Deep dive — writing a Halo2 circuit from scratch",
    kind: "ppv",
    live: true,
    participants: 38,
    price_tuzis: 250,
    thumbnail: null,
    started_at: new Date(Date.now() - 12 * 60000).toISOString(),
    category: "Education",
  },
  {
    id: "ls-3",
    username: "zooko",
    creator: mockCreators[0],
    title: "Subscribers only: the next 12 months of Zcash",
    kind: "subscriber",
    live: true,
    participants: 91,
    price_tuzis: 0,
    thumbnail: null,
    started_at: new Date(Date.now() - 5 * 60000).toISOString(),
    category: "Zcash",
  },
  {
    id: "ls-4",
    username: "f2z",
    creator: mockCreators[2],
    title: "Community town hall — roadmap Q&A",
    kind: "broadcast",
    live: false,
    participants: 0,
    price_tuzis: 0,
    thumbnail: null,
    category: "Community",
  },
];

const featuredArticles: Article[] = [
  {
    id: 1,
    slug: "why-shielded-by-default",
    free2zaddr: "zooko",
    title: "Why Shielded-by-Default Matters",
    subtitle: "Privacy is a public good, not a premium feature.",
    content:
      "# Why Shielded-by-Default Matters\n\nFinancial privacy isn't about hiding — it's about **choosing** who sees what. When every transaction is public by default, surveillance becomes the path of least resistance...\n\n## The asymmetry problem\n\nTransparency for the powerful, privacy for everyone else. Zcash inverts that.\n\n> The right to be let alone is the most comprehensive of rights.\n\nShielded pools make privacy the default, and the default is what most people get.",
    image: null,
    category: "Zcash",
    author: mockCreators[0],
    votes: 128,
    published_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    reading_minutes: 6,
    tags: ["zcash", "privacy", "shielded"],
  },
  {
    id: 2,
    slug: "2z-micrometering-ai",
    free2zaddr: "f2z",
    title: "Micrometering AI with 2Zs",
    subtitle: "Pay for exactly the tokens you use — anonymously.",
    content:
      "# Micrometering AI with 2Zs\n\nEvery prompt has a real cost. Instead of a monthly subscription, ZUULI charges you the *actual* cost plus a thin margin, rounded up to the nearest 2Z...\n\nBecause you pay through the free2z API, the upstream provider never sees **you** — only us.",
    image: null,
    category: "Technology",
    author: mockCreators[2],
    votes: 74,
    published_at: new Date(Date.now() - 1 * 86400000).toISOString(),
    reading_minutes: 4,
    tags: ["ai", "2z", "privacy"],
  },
  {
    id: 3,
    slug: "login-with-zcash",
    free2zaddr: "nine",
    title: "Login With Zcash: No Password, No KYC",
    subtitle: "Your key is your identity.",
    content:
      "# Login With Zcash\n\nSign a challenge with your wallet and you're in. No email, no third party, no password to leak. Your Zcash address becomes a W3C DID; a ZIP-304 signature proves you hold the key.",
    image: null,
    category: "Zcash",
    author: mockCreators[3],
    votes: 203,
    published_at: new Date(Date.now() - 6 * 3600000).toISOString(),
    reading_minutes: 5,
    tags: ["zcash", "identity", "auth"],
  },
];

// A broader synthetic corpus so mock mode can demo infinite scroll, tag
// filtering and search over more than a single page.
const GEN_CATEGORIES = [
  "Zcash",
  "Technology",
  "Education",
  "Community",
  "Privacy",
  "Research",
];
const GEN_TAG_POOL = [
  "zcash",
  "privacy",
  "ai",
  "halo2",
  "mining",
  "wallet",
  "zk",
  "governance",
  "tutorial",
  "opinion",
  "research",
  "lightning",
  "nym",
  "defi",
];
const GEN_TITLE_A = [
  "Building",
  "Understanding",
  "A Field Guide to",
  "Notes on",
  "Rethinking",
  "The Case for",
  "Deep Dive:",
  "Practical",
  "Inside",
  "The Future of",
];
const GEN_TITLE_B = [
  "Halo2 Circuits",
  "Shielded Pools",
  "Note Commitments",
  "the 2Z Economy",
  "Viewing Keys",
  "Trusted Setup",
  "Light Clients",
  "Unified Addresses",
  "Zero-Knowledge Proofs",
  "Private Payments",
  "Wallet Sync",
  "Recursive SNARKs",
];

function genArticles(n: number): Article[] {
  const out: Article[] = [];
  for (let i = 0; i < n; i++) {
    const c = mockCreators[i % mockCreators.length];
    const cat = GEN_CATEGORIES[i % GEN_CATEGORIES.length];
    const t1 = GEN_TAG_POOL[i % GEN_TAG_POOL.length];
    const t2 = GEN_TAG_POOL[(i * 5 + 3) % GEN_TAG_POOL.length];
    const title = `${GEN_TITLE_A[i % GEN_TITLE_A.length]} ${
      GEN_TITLE_B[(i * 3) % GEN_TITLE_B.length]
    }`;
    const daysAgo = (i + 1) * 0.9; // strictly increasing → deterministic recency order
    out.push({
      id: 100 + i,
      slug: `mock-article-${100 + i}`,
      free2zaddr: c.username,
      title,
      subtitle:
        "A worked example from the Zcash community, written for ZUULI's mock corpus.",
      content: `# ${title}\n\nThis is placeholder long-form content for the mock feed so ZUULI is fully explorable offline. It covers ${t1} and ${t2} in enough depth to demo the reader.`,
      image: null,
      category: cat,
      author: c,
      votes: (i * 37 + 11) % 320,
      published_at: new Date(Date.now() - daysAgo * 86400000).toISOString(),
      reading_minutes: 3 + (i % 8),
      tags: Array.from(new Set([cat.toLowerCase(), t1, t2])),
    });
  }
  return out;
}

export const mockArticles: Article[] = [...featuredArticles, ...genArticles(57)];

function articleTime(a: Article): number {
  const t = a.published_at ? new Date(a.published_at).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Mock counterpart to `articles.feed` — applies tag AND-filter, a naive
 * substring "search", the requested ranking and PageNumber pagination over the
 * fixtures, so infinite scroll / filters / search all work with no backend.
 */
export function mockArticleFeed(
  params: Required<Pick<ArticleFeedParams, "page" | "pageSize" | "sort">> &
    Pick<ArticleFeedParams, "tags" | "search" | "category">,
): ArticleFeedPage {
  const { page, pageSize, sort } = params;
  let list = [...mockArticles];

  if (params.category) {
    list = list.filter((a) => a.category === params.category);
  }
  if (params.tags?.length) {
    const want = params.tags.map((t) => t.toLowerCase());
    list = list.filter((a) => {
      const have = (a.tags ?? []).map((t) => t.toLowerCase());
      return want.every((t) => have.includes(t)); // AND
    });
  }
  if (params.search) {
    const q = params.search.toLowerCase();
    list = list.filter((a) =>
      [a.title, a.subtitle ?? "", a.content, (a.tags ?? []).join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }

  // Ranking. `search` results arrive already relevance-ordered from the real
  // backend, so mock leaves the filtered order alone in that case.
  if (!params.search) {
    if (sort === "updated" || sort === "popular") {
      // Newest first; `popular` is recency-decayed and reads as fresh here.
      list.sort((a, b) => articleTime(b) - articleTime(a));
    } else if (sort === "score") {
      list.sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0));
    } else if (sort === "random") {
      list.sort((a, b) => (hashString(a.slug ?? "") % 97) - (hashString(b.slug ?? "") % 97));
    }
  }

  const count = list.length;
  const start = (page - 1) * pageSize;
  const items = list.slice(start, start + pageSize);
  const next = start + pageSize < count ? page + 1 : null;
  return { items, next, count };
}

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
];

export function mockAiReply(prompt: string, modelName: string): PromptResponse {
  const response =
    `*(${modelName}, via the free2z API — the provider never sees you)*\n\n` +
    `You asked: "${prompt.slice(0, 140)}${prompt.length > 140 ? "…" : ""}"\n\n` +
    `Here's a thoughtful answer. In the live app this streams from the model you picked, ` +
    `and you're charged the exact upstream cost plus margin, rounded up to whole 2Zs.`;
  return {
    id: `pr-${Math.abs(hashString(prompt))}`,
    prompt,
    response,
    model: modelName,
    created_at: new Date().toISOString(),
    input_tokens: Math.ceil(prompt.length / 4),
    output_tokens: Math.ceil(response.length / 4),
    tuzis_charged: 4,
  };
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}

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

/** Case-insensitive page search over title/subtitle/body/author (mock). */
export function mockSearchPages(query: string): Article[] {
  const q = query.trim().toLowerCase();
  if (!q) return mockArticles;
  return mockArticles.filter((a) =>
    [a.title, a.subtitle, a.content, a.author.display_name, a.author.username]
      .filter(Boolean)
      .some((f) => (f as string).toLowerCase().includes(q)),
  );
}

/** A full CreatorDetail for the native creator screen (mock). */
export function mockCreatorDetail(username: string): CreatorDetail {
  const base = mockCreators.find(
    (c) => c.username.toLowerCase() === username.toLowerCase(),
  );
  const uname = base?.username ?? username;
  const pages = mockArticles.filter(
    (a) => a.author.username.toLowerCase() === uname.toLowerCase(),
  ).length;
  const seed = Math.abs(hashString(uname));
  return {
    username: uname,
    free2zaddr: uname,
    display_name: base?.display_name || uname,
    bio:
      base?.bio ??
      "A creator on ZUULI, publishing on Zcash and privacy. Follow along.",
    image: base?.image ?? null,
    banner: null,
    is_verified: base?.is_verified ?? false,
    can_stream: seed % 2 === 0,
    member_price: base?.member_price ?? null,
    zpages: base?.zpages ?? pages,
    total: (seed % 900) + 42,
    p2paddr: `u1mock${uname}zcashaddressplaceholderxxxxxxxxxxxxxxxxxxxxxxxx`,
  };
}
