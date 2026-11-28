/** HTTP-only producer v1. No wallet, renderer-provided provider facts or SDK. */
export const producerStates = [
  "draft",
  "provisioning",
  "ready",
  "live",
  "interrupted",
  "ending",
  "ended",
  "failed",
  "cleaned_up",
] as const;
export type ProducerState = (typeof producerStates)[number];
export type ProducerStream = {
  id: string;
  state: ProducerState;
  version: number;
  title: string;
  description: string;
  audience: string;
  access: string;
  owner: string;
  room_id: string | null;
  participants: number | null;
  error_code: string;
  ended_at: string | null;
};
export type ProducerAction =
  | "draft"
  | "update"
  | "provision"
  | "refresh"
  | "publish"
  | "heartbeat"
  | "interrupt"
  | "takeover"
  | "end";
export type ProducerInstruction = {
  action: ProducerAction;
  idempotency_key: string;
  expected_actor_id: number;
  owner: string;
  version: number;
  title: string;
  description: string;
  audience: string;
  access: string;
};
export type ProducerTransport = (
  method: "GET" | "POST",
  path: string,
  body?: ProducerInstruction,
) => Promise<unknown>;
export class ProducerFailure extends Error {
  constructor(
    public code: string,
    public body?: unknown,
  ) {
    super(code);
  }
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function parseProducer(value: unknown): ProducerStream {
  if (
    !record(value) ||
    !uuid(value.id) ||
    !uuid(value.owner) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    !producerStates.includes(value.state as ProducerState) ||
    typeof value.title !== "string" ||
    typeof value.description !== "string" ||
    value.audience !== "public" ||
    value.access !== "free" ||
    !(value.room_id === null || uuid(value.room_id)) ||
    !(
      value.participants === null ||
      (Number.isSafeInteger(value.participants) &&
        (value.participants as number) >= 0)
    ) ||
    typeof value.error_code !== "string" ||
    !(value.ended_at === null || typeof value.ended_at === "string")
  )
    throw new ProducerFailure("invalid_response");
  return value as ProducerStream;
}

export class ProducerClient {
  stream: ProducerStream | null = null;
  readonly owner: string;
  private pending: { target: string; body: ProducerInstruction } | null = null;
  private busy = false;
  private active = true;
  private observedAt = Number.NEGATIVE_INFINITY;
  private readonly storageKey: string;
  constructor(
    readonly actor: number,
    private transport: ProducerTransport,
    private storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  ) {
    this.storageKey = `free2z.producer.v1.${actor}`;
    let saved: unknown;
    try {
      saved = JSON.parse(storage?.getItem(this.storageKey) || "null");
    } catch {
      /* no saved intent */
    }
    this.owner =
      record(saved) && uuid(saved.owner) ? saved.owner : crypto.randomUUID();
    if (record(saved) && record(saved.pending)) {
      const pending = saved.pending;
      // Persisted bytes are untrusted. Only our own actor's exact typed
      // instruction may be replayed; never take an arbitrary stored URL.
      if (
        typeof pending.target === "string" &&
        /^\/api\/dyte\/producer\/v1(?:\/[0-9a-f-]{36})?$/.test(
          pending.target,
        ) &&
        record(pending.body) &&
        pending.body.expected_actor_id === actor &&
        pending.body.owner === this.owner &&
        uuid(pending.body.idempotency_key)
      )
        this.pending = pending as typeof this.pending;
    }
  }
  private save() {
    // Persistence is required BEFORE a POST, so response loss/reload retains
    // its key. Credentials never enter this storage.
    if (!this.storage) throw new ProducerFailure("storage_unavailable");
    this.storage.setItem(
      this.storageKey,
      JSON.stringify({ owner: this.owner, pending: this.pending }),
    );
  }
  dispose() {
    this.active = false;
  }
  get uncertain() {
    return this.pending !== null;
  }
  get fresh() {
    return this.freshFor > 0;
  }
  get freshFor() {
    return Math.max(0, this.observedAt + 60_000 - performance.now());
  }
  async load() {
    const rows = await this.transport("GET", "/api/dyte/producer/v1/history");
    if (!this.active) throw new ProducerFailure("actor_changed");
    if (!Array.isArray(rows)) throw new ProducerFailure("invalid_response");
    const streams = rows.map(parseProducer);
    this.stream =
      streams.find((s) => s.state !== "cleaned_up") ?? streams[0] ?? null;
    this.observedAt = performance.now();
    return this.stream;
  }
  async command(
    action: ProducerAction,
    metadata?: {
      title: string;
      description: string;
      audience: string;
      access: string;
    },
  ) {
    if (!this.active) throw new ProducerFailure("actor_changed");
    if (this.busy) throw new ProducerFailure("operation_in_progress");
    if (this.pending && this.pending.body.action !== action)
      throw new ProducerFailure("retry_pending");
    this.busy = true;
    try {
      if (!this.pending) {
        const stream = this.stream;
        this.pending = {
          target:
            "/api/dyte/producer/v1" +
            (action === "draft" ? "" : `/${stream?.id}`),
          body: {
            action,
            idempotency_key: crypto.randomUUID(),
            expected_actor_id: this.actor,
            owner: this.owner,
            version: stream?.version ?? 1,
            title: stream?.title ?? "",
            description: stream?.description ?? "",
            audience: stream?.audience ?? "public",
            access: stream?.access ?? "free",
            ...metadata,
          },
        };
        this.save();
      }
      this.save();
      const value = await this.transport(
        "POST",
        this.pending.target,
        this.pending.body,
      );
      if (!this.active) throw new ProducerFailure("actor_changed");
      if (
        !record(value) ||
        !(value.auth_token === null || typeof value.auth_token === "string")
      )
        throw new ProducerFailure("invalid_response");
      this.stream = parseProducer(value.stream);
      this.observedAt = performance.now();
      this.pending = null;
      this.save();
      return { stream: this.stream, token: value.auth_token as string | null };
    } catch (error) {
      // A definite HTTP refusal can be inspected without repeating I/O.
      if (error instanceof ProducerFailure && record(error.body)) {
        if (error.body.stream) {
          this.stream = parseProducer(error.body.stream);
          this.observedAt = performance.now();
        }
        if (error.code !== "operation_in_progress") {
          this.pending = null;
          this.save();
        }
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async retry() {
    if (!this.pending) throw new ProducerFailure("no_pending_operation");
    return this.command(this.pending.body.action);
  }
}
