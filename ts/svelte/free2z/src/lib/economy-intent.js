import { newIdempotencyKey } from "./subscribe-idempotency.js";

/** @param {number} actor @param {string} action */
function slot(actor, action) {
  if (
    !Number.isSafeInteger(actor) ||
    actor <= 0 ||
    !["payment", "usage"].includes(action)
  ) {
    throw new Error("Sign in again before continuing.");
  }
  return `f2z:economy-intent:v1:${actor}:${action}`;
}

/** @typedef {{version: number, actor: number, action: string, payload: Record<string, any>, details: any, reused?: boolean}} EconomyIntent */
/** @param {Pick<Storage, "getItem" | "setItem" | "removeItem">} storage
 * @param {number} actor @param {string} action
 * @returns {EconomyIntent | null} */
export function readEconomyIntent(storage, actor, action) {
  const raw = storage.getItem(slot(actor, action));
  if (raw === null) return null;
  const record = JSON.parse(raw);
  if (
    !record ||
    typeof record !== "object" ||
    record.version !== 1 ||
    record.actor !== actor ||
    record.action !== action ||
    (record.payload?.expected_actor_id !== undefined &&
      record.payload.expected_actor_id !== record.actor) ||
    typeof record.payload?.idempotency_key !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      record.payload.idempotency_key,
    ) ||
    typeof record.payload?.amount !== "string" ||
    !/^(0|[1-9]\d*)\.\d{9}$/.test(record.payload.amount) ||
    (action === "payment" && typeof record.payload.address !== "string") ||
    (action === "usage" &&
      (typeof record.payload.quote_token !== "string" ||
        record.payload.acknowledged !== true))
  ) {
    throw new Error(
      "A saved request needs support review. Do not submit a replacement.",
    );
  }
  // Older saved envelopes inherit only their original immutable actor, never the current session.
  return {
    ...record,
    payload: { ...record.payload, expected_actor_id: record.actor },
  };
}

/** The lock serializes tabs; the durable original payload survives unknown outcomes.
 * @param {Pick<Storage, "getItem" | "setItem" | "removeItem">} storage
 * @param {LockManager | null | undefined} locks
 * @param {number} actor @param {string} action
 * @param {Record<string, unknown>} payload @param {any} details
 * @returns {Promise<EconomyIntent>} */
export async function prepareEconomyIntent(
  storage,
  locks,
  actor,
  action,
  payload,
  details = null,
) {
  if (!locks?.request)
    throw new Error(
      "This browser cannot safely save this request. Use a current browser.",
    );
  return locks.request(slot(actor, action), async () => {
    const prior = readEconomyIntent(storage, actor, action);
    if (prior) {
      storage.setItem(slot(actor, action), JSON.stringify(prior));
      return { ...prior, reused: true };
    }
    const record = {
      version: 1,
      actor,
      action,
      payload: {
        ...payload,
        expected_actor_id: actor,
        idempotency_key: newIdempotencyKey(),
      },
      details,
    };
    storage.setItem(slot(actor, action), JSON.stringify(record));
    const saved = readEconomyIntent(storage, actor, action);
    if (
      !saved ||
      saved.payload.idempotency_key !== record.payload.idempotency_key
    ) {
      throw new Error("Your request could not be saved safely. Please retry.");
    }
    return { ...saved, reused: false };
  });
}

/** A stale response must never erase a newer pending operation.
 * @param {Pick<Storage, "getItem" | "setItem" | "removeItem">} storage
 * @param {LockManager | null | undefined} locks
 * @param {number} actor @param {string} action @param {string} expectedKey */
export async function clearEconomyIntent(
  storage,
  locks,
  actor,
  action,
  expectedKey,
) {
  if (!locks?.request)
    throw new Error("The saved request cannot be updated safely.");
  return locks.request(slot(actor, action), async () => {
    const current = readEconomyIntent(storage, actor, action);
    if (current?.payload.idempotency_key === expectedKey) {
      storage.removeItem(slot(actor, action));
      return true;
    }
    return false;
  });
}
