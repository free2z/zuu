export const ARTICLE_DRAFT_STORAGE_KEY = "zuuli.article-drafts.v1";
export const ARTICLE_DRAFT_STORAGE_PREFIX = "zuuli.article-drafts.v2.";

const STORE_VERSION = 1;
const RECORD_VERSION = 2;
const MAX_DRAFTS = 100;
const MAX_TITLE_LENGTH = 1_000;
const MAX_SUBTITLE_LENGTH = 5_000;
const MAX_CONTENT_LENGTH = 2_000_000;
const MAX_CATEGORY_LENGTH = 100;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 64;
const DRAFT_ID = /^[a-zA-Z0-9_-]{8,80}$/;
const CLAIM_ID = /^[a-zA-Z0-9_-]{8,100}$/;

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

interface DraftHead {
  version: typeof RECORD_VERSION;
  kind: "head";
  parent: string;
  claimId: string;
  account: string;
  draftId: string;
  deleted: boolean;
}

interface DraftClaim {
  version: typeof RECORD_VERSION;
  kind: "claim";
  claimId: string;
  account: string;
  draftId: string;
  parent: string;
  draft: StoredArticleDraft | null;
}

interface Snapshot {
  legacy: ArticleDraftStore;
  heads: Map<string, DraftHead>;
  claims: Map<string, DraftClaim>;
}

interface CurrentDraft {
  draft: StoredArticleDraft | null;
  token: string;
  backingClaimId: string | null;
}

export interface DraftStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type SaveArticleDraftResult =
  | { status: "saved"; draft: StoredArticleDraft }
  | {
      status: "conflict";
      draft: StoredArticleDraft | null;
      rescue: StoredArticleDraft | null;
    };

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

export function isArticleDraftStorageKey(key: string | null): boolean {
  return key === ARTICLE_DRAFT_STORAGE_KEY || Boolean(key?.startsWith(ARTICLE_DRAFT_STORAGE_PREFIX));
}

export function newArticleDraftId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2);
  return `draft-${Date.now().toString(36)}-${random}`;
}

function newClaimId(): string {
  return `claim-${newArticleDraftId()}`;
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

function parseLegacyStore(raw: string | null):
  | { status: "current"; store: ArticleDraftStore }
  | { status: "corrupt" }
  | { status: "unsupported" } {
  if (raw === null) {
    return { status: "current", store: { version: STORE_VERSION, drafts: [] } };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "corrupt" };
    }
    const value = parsed as Record<string, unknown>;
    if (value.version !== STORE_VERSION) return { status: "unsupported" };
    if (!Array.isArray(value.drafts)) return { status: "corrupt" };
    const drafts = value.drafts.map(parseDraft);
    if (drafts.some((draft) => draft === null)) return { status: "corrupt" };
    const identities = new Set<string>();
    for (const draft of drafts as StoredArticleDraft[]) {
      const identity = draftIdentity(draft.account, draft.id);
      if (identities.has(identity)) return { status: "corrupt" };
      identities.add(identity);
    }
    return {
      status: "current",
      store: { version: STORE_VERSION, drafts: drafts as StoredArticleDraft[] },
    };
  } catch {
    return { status: "corrupt" };
  }
}

function parseHead(raw: string): DraftHead | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (
      value.version !== RECORD_VERSION ||
      value.kind !== "head" ||
      typeof value.parent !== "string" ||
      typeof value.claimId !== "string" ||
      !CLAIM_ID.test(value.claimId) ||
      typeof value.account !== "string" ||
      !value.account ||
      typeof value.draftId !== "string" ||
      !isArticleDraftId(value.draftId) ||
      typeof value.deleted !== "boolean"
    ) {
      return null;
    }
    return {
      version: RECORD_VERSION,
      kind: "head",
      parent: value.parent,
      claimId: value.claimId,
      account: value.account,
      draftId: value.draftId,
      deleted: value.deleted,
    };
  } catch {
    return null;
  }
}

function parseClaim(raw: string): DraftClaim | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (
      value.version !== RECORD_VERSION ||
      value.kind !== "claim" ||
      typeof value.claimId !== "string" ||
      !CLAIM_ID.test(value.claimId) ||
      typeof value.account !== "string" ||
      !value.account ||
      typeof value.draftId !== "string" ||
      !isArticleDraftId(value.draftId) ||
      typeof value.parent !== "string"
    ) {
      return null;
    }
    const draft = value.draft === null ? null : parseDraft(value.draft);
    if (value.draft !== null && !draft) return null;
    if (draft && (draft.account !== value.account || draft.id !== value.draftId)) {
      return null;
    }
    return {
      version: RECORD_VERSION,
      kind: "claim",
      claimId: value.claimId,
      account: value.account,
      draftId: value.draftId,
      parent: value.parent,
      draft,
    };
  } catch {
    return null;
  }
}

function requireLegacy(raw: string | null): ArticleDraftStore {
  const parsed = parseLegacyStore(raw);
  if (parsed.status === "unsupported") throw new UnsupportedArticleDraftStoreError();
  if (parsed.status === "corrupt") throw new CorruptArticleDraftStoreError();
  return parsed.store;
}

function draftIdentity(account: string, id: string): string {
  return `${account}\u0000${id}`;
}

function headKey(account: string, id: string): string {
  return `${ARTICLE_DRAFT_STORAGE_PREFIX}head:${encodeURIComponent(account)}:${id}`;
}

function claimKey(claimId: string): string {
  return `${ARTICLE_DRAFT_STORAGE_PREFIX}claim:${claimId}`;
}

function legacyToken(account: string, id: string): string {
  return `legacy:${account}:${id}`;
}

function headToken(head: DraftHead): string {
  return `head:${head.claimId}`;
}

function claimToken(claim: DraftClaim): string {
  return `rescue:${claim.claimId}`;
}

function storageKeys(storage: DraftStorage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}

function snapshot(storage: DraftStorage): Snapshot {
  const rootRaw = storage.getItem(ARTICLE_DRAFT_STORAGE_KEY);
  const legacy = requireLegacy(rootRaw);
  const heads = new Map<string, DraftHead>();
  const claims = new Map<string, DraftClaim>();
  for (const key of storageKeys(storage)) {
    if (!key.startsWith(ARTICLE_DRAFT_STORAGE_PREFIX)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    if (key.startsWith(`${ARTICLE_DRAFT_STORAGE_PREFIX}head:`)) {
      const head = parseHead(raw);
      if (!head) throw new CorruptArticleDraftStoreError();
      if (key !== headKey(head.account, head.draftId)) {
        throw new CorruptArticleDraftStoreError();
      }
      heads.set(key, head);
    } else if (key.startsWith(`${ARTICLE_DRAFT_STORAGE_PREFIX}claim:`)) {
      const claim = parseClaim(raw);
      if (!claim || key !== claimKey(claim.claimId)) {
        throw new CorruptArticleDraftStoreError();
      }
      claims.set(claim.claimId, claim);
    } else {
      throw new CorruptArticleDraftStoreError();
    }
  }
  for (const head of heads.values()) {
    const claim = claims.get(head.claimId);
    if (
      !claim ||
      claim.account !== head.account ||
      claim.draftId !== head.draftId ||
      (head.deleted ? claim.draft !== null : claim.draft === null)
    ) {
      throw new CorruptArticleDraftStoreError();
    }
  }
  return { legacy, heads, claims };
}

function currentDraft(state: Snapshot, account: string, id: string): CurrentDraft {
  const head = state.heads.get(headKey(account, id));
  if (head) {
    const backing = state.claims.get(head.claimId);
    if (!backing) throw new CorruptArticleDraftStoreError();
    return {
      draft: head.deleted ? null : backing.draft,
      token: headToken(head),
      backingClaimId: head.claimId,
    };
  }
  const rescue = state.claims.get(id);
  if (rescue && rescue.account === account && rescue.draft && rescue.claimId === id) {
    return {
      draft: { ...rescue.draft, id: rescue.claimId, revision: 1 },
      token: claimToken(rescue),
      backingClaimId: rescue.claimId,
    };
  }
  const legacy = state.legacy.drafts.find(
    (draft) => draft.account === account && draft.id === id,
  ) ?? null;
  return {
    draft: legacy,
    token: legacyToken(account, id),
    backingClaimId: null,
  };
}

function unresolvedClaims(state: Snapshot, account: string, id: string, parent: string): DraftClaim[] {
  return [...state.claims.values()].filter((claim) => {
    if (claim.account !== account || claim.draftId !== id || claim.parent !== parent) return false;
    const rescueHead = state.heads.get(headKey(account, claim.claimId));
    return !rescueHead;
  });
}

function visibleDrafts(state: Snapshot): StoredArticleDraft[] {
  const drafts = new Map<string, StoredArticleDraft>();
  for (const draft of state.legacy.drafts) drafts.set(draftIdentity(draft.account, draft.id), draft);
  for (const [key, head] of state.heads) {
    const prefix = `${ARTICLE_DRAFT_STORAGE_PREFIX}head:`;
    const encodedAndId = key.slice(prefix.length);
    const separator = encodedAndId.lastIndexOf(":");
    if (separator < 0) throw new CorruptArticleDraftStoreError();
    const account = decodeURIComponent(encodedAndId.slice(0, separator));
    const id = encodedAndId.slice(separator + 1);
    drafts.delete(draftIdentity(account, id));
    const backing = state.claims.get(head.claimId);
    if (!backing) throw new CorruptArticleDraftStoreError();
    if (!head.deleted && backing.draft) {
      drafts.set(draftIdentity(account, id), backing.draft);
    }
  }
  for (const claim of state.claims.values()) {
    if (!claim.draft) continue;
    const sourceHead = state.heads.get(headKey(claim.account, claim.draftId));
    if (sourceHead?.claimId === claim.claimId) continue;
    const rescueHead = state.heads.get(headKey(claim.account, claim.claimId));
    if (rescueHead) continue;
    drafts.set(draftIdentity(claim.account, claim.claimId), {
      ...claim.draft,
      id: claim.claimId,
      revision: 1,
    });
  }
  return [...drafts.values()];
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

function writeClaim(storage: DraftStorage, claim: DraftClaim): void {
  const key = claimKey(claim.claimId);
  if (storage.getItem(key) !== null) throw new Error("Article draft claim id collision.");
  const raw = JSON.stringify(claim);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("Article draft could not be saved reliably.");
}

function sameDraft(
  left: StoredArticleDraft | null,
  right: StoredArticleDraft | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parentUnchanged(
  state: Snapshot,
  account: string,
  id: string,
  expected: CurrentDraft,
): boolean {
  const current = currentDraft(state, account, id);
  return current.token === expected.token && sameDraft(current.draft, expected.draft);
}

function settleHead(
  storage: DraftStorage,
  claim: DraftClaim,
  expected: CurrentDraft,
): boolean {
  let state = snapshot(storage);
  if (
    !parentUnchanged(state, claim.account, claim.draftId, expected) ||
    unresolvedClaims(state, claim.account, claim.draftId, claim.parent).length !== 1
  ) {
    return false;
  }
  const head: DraftHead = {
    version: RECORD_VERSION,
    kind: "head",
    parent: claim.parent,
    claimId: claim.claimId,
    account: claim.account,
    draftId: claim.draftId,
    deleted: claim.draft === null,
  };
  const key = headKey(claim.account, claim.draftId);
  const raw = JSON.stringify(head);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) return false;
  state = snapshot(storage);
  const installed = state.heads.get(key);
  if (
    installed?.claimId !== claim.claimId ||
    unresolvedClaims(state, claim.account, claim.draftId, claim.parent).length !== 1
  ) {
    return false;
  }
  return true;
}

function removeClaimBestEffort(storage: DraftStorage, claimId: string): void {
  try {
    storage.removeItem(claimKey(claimId));
  } catch {
    // The installed head makes this staging record harmless and hidden.
  }
}

export function listArticleDrafts(
  username: string,
  storage: DraftStorage = window.localStorage,
): StoredArticleDraft[] {
  try {
    const account = accountKey(username);
    return visibleDrafts(snapshot(storage))
      .filter((draft) => draft.account === account)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

export function loadArticleDraft(
  username: string,
  id: string,
  storage: DraftStorage = window.localStorage,
): StoredArticleDraft | null {
  if (!isArticleDraftId(id)) return null;
  return listArticleDrafts(username, storage).find((draft) => draft.id === id) ?? null;
}

export function hasArticleDraftConflict(
  username: string,
  id: string,
  storage: DraftStorage = window.localStorage,
): boolean {
  if (!isArticleDraftId(id)) return false;
  try {
    const account = accountKey(username);
    const state = snapshot(storage);
    const current = currentDraft(state, account, id);
    if (unresolvedClaims(state, account, id, current.token).length > 0) return true;
    const head = state.heads.get(headKey(account, id));
    return Boolean(
      head &&
        unresolvedClaims(state, account, id, head.parent).some(
          (claim) => claim.claimId !== head.claimId,
        ),
    );
  } catch {
    return true;
  }
}

export function saveArticleDraft(
  username: string,
  id: string,
  fields: ArticleDraftFields,
  expectedRevision: number,
  storage: DraftStorage = window.localStorage,
  now = Date.now(),
  requestedClaimId = newClaimId(),
): SaveArticleDraftResult {
  if (!isArticleDraftId(id)) throw new Error("Invalid article draft id.");
  if (!CLAIM_ID.test(requestedClaimId) || !isArticleDraftId(requestedClaimId)) {
    throw new Error("Invalid article draft claim id.");
  }
  const account = accountKey(username);
  if (!account) throw new Error("An account is required to save a draft.");
  const initial = snapshot(storage);
  const existing = currentDraft(initial, account, id);
  if ((existing.draft?.revision ?? 0) !== expectedRevision) {
    return { status: "conflict", draft: existing.draft, rescue: null };
  }
  if (
    !existing.draft &&
    visibleDrafts(initial).length >= MAX_DRAFTS &&
    !initial.claims.has(id)
  ) {
    throw new Error("Too many local article drafts are stored on this device.");
  }
  if (visibleDrafts(initial).some((draft) => draftIdentity(draft.account, draft.id) === draftIdentity(account, requestedClaimId))) {
    throw new Error("Article draft claim id collision.");
  }
  const validFields = validateFields(fields);
  const saved: StoredArticleDraft = {
    ...validFields,
    id,
    account,
    revision: expectedRevision + 1,
    updatedAt: now,
  };
  const rescue: StoredArticleDraft = { ...saved, id: requestedClaimId, revision: 1 };
  const claim: DraftClaim = {
    version: RECORD_VERSION,
    kind: "claim",
    claimId: requestedClaimId,
    account,
    draftId: id,
    parent: existing.token,
    draft: saved,
  };
  writeClaim(storage, claim);
  if (!settleHead(storage, claim, existing)) {
    return { status: "conflict", draft: currentDraft(snapshot(storage), account, id).draft, rescue };
  }
  // Keep the winning claim until this head is superseded. If two tabs both
  // believe they won a non-atomic head write, the overwritten winner's full
  // body consequently remains a visible rescue instead of disappearing.
  if (existing.backingClaimId) {
    removeClaimBestEffort(storage, existing.backingClaimId);
  }
  return { status: "saved", draft: saved };
}

export function discardArticleDraft(
  username: string,
  id: string,
  expectedRevision: number,
  storage: DraftStorage = window.localStorage,
  requestedClaimId = newClaimId(),
): DiscardArticleDraftResult {
  if (!isArticleDraftId(id)) return "missing";
  if (!CLAIM_ID.test(requestedClaimId)) throw new Error("Invalid article draft claim id.");
  const account = accountKey(username);
  const initial = snapshot(storage);
  const existing = currentDraft(initial, account, id);
  if (!existing.draft) return expectedRevision === 0 ? "missing" : "conflict";
  if (existing.draft.revision !== expectedRevision) return "conflict";
  const claim: DraftClaim = {
    version: RECORD_VERSION,
    kind: "claim",
    claimId: requestedClaimId,
    account,
    draftId: id,
    parent: existing.token,
    draft: null,
  };
  writeClaim(storage, claim);
  if (!settleHead(storage, claim, existing)) {
    removeClaimBestEffort(storage, requestedClaimId);
    return "conflict";
  }
  if (existing.backingClaimId) {
    removeClaimBestEffort(storage, existing.backingClaimId);
  }
  return "discarded";
}

export function articleDraftLabel(draft: StoredArticleDraft): string {
  return draft.title.trim() || "Untitled draft";
}
