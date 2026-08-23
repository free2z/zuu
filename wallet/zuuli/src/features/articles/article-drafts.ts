export const ARTICLE_DRAFT_STORAGE_KEY = "zuuli.article-drafts.v1";

const STORE_VERSION = 1;
const MAX_DRAFTS = 100;
const MAX_TITLE_LENGTH = 1_000;
const MAX_SUBTITLE_LENGTH = 5_000;
const MAX_CONTENT_LENGTH = 2_000_000;
const MAX_CATEGORY_LENGTH = 100;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 64;
const DRAFT_ID = /^[a-zA-Z0-9_-]{8,80}$/;

export interface ArticleDraftFields {
  title: string;
  subtitle: string;
  category: string;
  tags: string[];
  content: string;
}

export interface StoredArticleDraft extends ArticleDraftFields {
  id: string;
  account: string;
  revision: number;
  updatedAt: number;
}

interface ArticleDraftStore {
  version: typeof STORE_VERSION;
  drafts: StoredArticleDraft[];
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type SaveArticleDraftResult =
  | { status: "saved"; draft: StoredArticleDraft }
  | { status: "conflict"; draft: StoredArticleDraft | null };

export type DiscardArticleDraftResult = "discarded" | "missing" | "conflict";

export class UnsupportedArticleDraftStoreError extends Error {
  constructor() {
    super("A newer article-draft format is already stored on this device.");
    this.name = "UnsupportedArticleDraftStoreError";
  }
}

export class CorruptArticleDraftStoreError extends Error {
  constructor() {
    super("The local article-draft store is corrupt and cannot be changed safely.");
    this.name = "CorruptArticleDraftStoreError";
  }
}

function accountKey(username: string): string {
  return username.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function isArticleDraftId(value: string | null): value is string {
  return Boolean(value && DRAFT_ID.test(value));
}

export function newArticleDraftId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2);
  return `draft-${Date.now().toString(36)}-${random}`;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function parseDraft(value: unknown): StoredArticleDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const draft = value as Record<string, unknown>;
  const title = boundedString(draft.title, MAX_TITLE_LENGTH);
  const subtitle = boundedString(draft.subtitle, MAX_SUBTITLE_LENGTH);
  const category = boundedString(draft.category, MAX_CATEGORY_LENGTH);
  const content = boundedString(draft.content, MAX_CONTENT_LENGTH);
  const id = typeof draft.id === "string" ? draft.id : null;
  const account = typeof draft.account === "string" ? draft.account : null;
  if (
    !isArticleDraftId(id) ||
    !account ||
    account.length > 256 ||
    !Number.isSafeInteger(draft.revision) ||
    Number(draft.revision) < 1 ||
    !Number.isFinite(draft.updatedAt) ||
    Number(draft.updatedAt) < 0 ||
    title === null ||
    subtitle === null ||
    category === null ||
    content === null ||
    !Array.isArray(draft.tags) ||
    draft.tags.length > MAX_TAGS
  ) {
    return null;
  }
  const tags = draft.tags.map((tag) => boundedString(tag, MAX_TAG_LENGTH));
  if (tags.some((tag) => tag === null)) return null;
  return {
    id,
    account,
    revision: Number(draft.revision),
    updatedAt: Number(draft.updatedAt),
    title,
    subtitle,
    category,
    content,
    tags: tags as string[],
  };
}

function parseStore(raw: string | null):
  | { status: "current"; store: ArticleDraftStore }
  | { status: "corrupt" }
  | { status: "unsupported" } {
  if (raw === null) {
    return { status: "current", store: { version: STORE_VERSION, drafts: [] } };
  }
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object") {
      return { status: "corrupt" };
    }
    if (value.version !== STORE_VERSION) {
      return { status: "unsupported" };
    }
    if (!Array.isArray(value.drafts)) {
      return { status: "corrupt" };
    }
    const drafts = value.drafts.map(parseDraft);
    if (drafts.some((draft) => draft === null)) return { status: "corrupt" };
    const identities = new Set<string>();
    for (const draft of drafts as StoredArticleDraft[]) {
      const identity = `${draft.account}\u0000${draft.id}`;
      if (identities.has(identity)) return { status: "corrupt" };
      identities.add(identity);
    }
    return {
      status: "current",
      store: {
        version: STORE_VERSION,
        drafts: drafts as StoredArticleDraft[],
      },
    };
  } catch {
    return { status: "corrupt" };
  }
}

function currentStore(storage: DraftStorage): ArticleDraftStore {
  const parsed = parseStore(storage.getItem(ARTICLE_DRAFT_STORAGE_KEY));
  if (parsed.status === "unsupported") {
    throw new UnsupportedArticleDraftStoreError();
  }
  if (parsed.status === "corrupt") {
    throw new CorruptArticleDraftStoreError();
  }
  return parsed.store;
}

function validateFields(fields: ArticleDraftFields): ArticleDraftFields {
  const parsed = parseDraft({
    ...fields,
    id: "validation-id",
    account: "validation-account",
    revision: 1,
    updatedAt: 0,
  });
  if (!parsed) throw new Error("Article draft exceeds its local storage limits.");
  return {
    title: parsed.title,
    subtitle: parsed.subtitle,
    category: parsed.category,
    content: parsed.content,
    tags: parsed.tags,
  };
}

export function listArticleDrafts(
  username: string,
  storage: DraftStorage = window.localStorage,
): StoredArticleDraft[] {
  let raw: string | null;
  try {
    raw = storage.getItem(ARTICLE_DRAFT_STORAGE_KEY);
  } catch {
    return [];
  }
  const parsed = parseStore(raw);
  if (parsed.status !== "current") return [];
  const account = accountKey(username);
  return parsed.store.drafts
    .filter((draft) => draft.account === account)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function loadArticleDraft(
  username: string,
  id: string,
  storage: DraftStorage = window.localStorage,
): StoredArticleDraft | null {
  if (!isArticleDraftId(id)) return null;
  return (
    listArticleDrafts(username, storage).find((draft) => draft.id === id) ?? null
  );
}

export function saveArticleDraft(
  username: string,
  id: string,
  fields: ArticleDraftFields,
  expectedRevision: number,
  storage: DraftStorage = window.localStorage,
  now = Date.now(),
): SaveArticleDraftResult {
  if (!isArticleDraftId(id)) throw new Error("Invalid article draft id.");
  const account = accountKey(username);
  if (!account) throw new Error("An account is required to save a draft.");
  const store = currentStore(storage);
  const index = store.drafts.findIndex(
    (draft) => draft.account === account && draft.id === id,
  );
  const existing = index >= 0 ? store.drafts[index] : null;
  if ((existing?.revision ?? 0) !== expectedRevision) {
    return { status: "conflict", draft: existing };
  }
  if (!existing && store.drafts.length >= MAX_DRAFTS) {
    throw new Error("Too many local article drafts are stored on this device.");
  }
  const validFields = validateFields(fields);
  const saved: StoredArticleDraft = {
    ...validFields,
    id,
    account,
    revision: expectedRevision + 1,
    updatedAt: now,
  };
  const drafts = [...store.drafts];
  if (index >= 0) drafts[index] = saved;
  else drafts.push(saved);
  storage.setItem(
    ARTICLE_DRAFT_STORAGE_KEY,
    JSON.stringify({ version: STORE_VERSION, drafts } satisfies ArticleDraftStore),
  );
  return { status: "saved", draft: saved };
}

export function discardArticleDraft(
  username: string,
  id: string,
  expectedRevision: number,
  storage: DraftStorage = window.localStorage,
): DiscardArticleDraftResult {
  if (!isArticleDraftId(id)) return "missing";
  const account = accountKey(username);
  const store = currentStore(storage);
  const index = store.drafts.findIndex(
    (draft) => draft.account === account && draft.id === id,
  );
  if (index < 0) return expectedRevision === 0 ? "missing" : "conflict";
  if (store.drafts[index].revision !== expectedRevision) return "conflict";
  const drafts = store.drafts.filter((_, candidate) => candidate !== index);
  if (drafts.length === 0) {
    storage.removeItem(ARTICLE_DRAFT_STORAGE_KEY);
    return "discarded";
  }
  storage.setItem(
    ARTICLE_DRAFT_STORAGE_KEY,
    JSON.stringify({ version: STORE_VERSION, drafts } satisfies ArticleDraftStore),
  );
  return "discarded";
}

export function articleDraftLabel(draft: StoredArticleDraft): string {
  return draft.title.trim() || "Untitled draft";
}
