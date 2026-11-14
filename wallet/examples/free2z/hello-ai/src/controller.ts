import {
  Client,
  SdkError,
  type Balance,
  type CallRecord,
  type Charge,
  type ChatRequest,
  type ChatStream,
  type Model,
  type Session,
} from "@free2z/sdk";

// This journal contains user text. It contains NO credentials. Production apps
// must choose retention/encryption appropriate to their audience.
export interface Entry {
  subject: string;
  operationId: string;
  idempotencyKey: string;
  startedAt: number;
  model: string;
  prompt: string;
  maxOutputTokens: string;
  callId?: string;
}
export interface Journal {
  read(subject: string): Entry | undefined;
  write(entry: Entry): void;
}
export interface View {
  session: Session;
  balance?: Balance;
  models: Model[];
  text: string;
  status: string;
  charge: Charge;
  entry?: Entry;
  busy: boolean;
  authenticating: boolean;
}
// Leave an hour for clock skew and a slow request. Never replay an old key
// after the server's 24-hour idempotency retention window.
const RECOVERY_WINDOW_MS = 23 * 60 * 60 * 1000;
const sameSession = (a: Session, b: Session) =>
  a.signedIn === b.signedIn &&
  a.subject === b.subject &&
  a.generation === b.generation;
const signedOut: Session = {
  signedIn: false,
  subject: null,
  generation: "",
  grantedScopes: [],
  persistence: "memory_only",
};

export class HelloAI {
  view: View = {
    session: signedOut,
    models: [],
    text: "",
    status: "Sign in to begin.",
    charge: { state: "pending" },
    busy: false,
    authenticating: false,
  };
  #epoch = 0;
  #stream: ChatStream | undefined;
  #abort: AbortController | undefined;
  constructor(
    readonly client: Client,
    private readonly journal: Journal,
    private readonly render: (view: View) => void,
    private readonly now = Date.now,
    private readonly uuid = () => crypto.randomUUID(),
  ) {}
  #emit() {
    this.render(this.view);
  }
  async #latest(epoch: number): Promise<Session | undefined> {
    if (epoch !== this.#epoch) return;
    const session = await this.client.session();
    return epoch === this.#epoch ? session : undefined;
  }
  #adopt(session: Session) {
    this.#epoch++;
    const abort = this.#abort;
    this.#abort = undefined;
    this.#stream = undefined;
    abort?.abort();
    this.view = {
      session,
      models: [],
      text: "",
      status: session.signedIn ? "Signed in." : "Sign in to begin.",
      charge: { state: "pending" },
      busy: false,
      authenticating: false,
    };
    if (session.subject) {
      const entry = this.journal.read(session.subject);
      if (entry) this.view.entry = entry;
    }
    this.#emit();
  }
  async #owns(epoch: number, expected: Session): Promise<boolean> {
    const actual = await this.#latest(epoch);
    if (!actual || epoch !== this.#epoch) return false;
    // A native session may change outside this UI. Drop old account data
    // before returning control, rather than publish a result under its label.
    if (!sameSession(actual, expected)) {
      this.#adopt(actual);
      return false;
    }
    return sameSession(this.view.session, expected);
  }
  #status(error: unknown) {
    const code = error instanceof SdkError ? error.code : "local_error";
    this.view.status =
      code === "insufficient_balance" || code === "account_in_debt"
        ? "Your Free2Z balance needs attention. Use the account or billing button, then refresh."
        : code === "cap_exceeded"
          ? "Manage this app's budget on Free2Z; getting more 2Z does not raise it."
          : code === "cancelled"
            ? "Delivery stopped. The call may still be charged; recover its receipt."
            : `${code}. No automatic paid retry. Recover any existing call before trying again.`;
  }
  async refresh() {
    const openingEpoch = this.#epoch;
    const session = await this.#latest(openingEpoch);
    if (!session || openingEpoch !== this.#epoch) return;
    if (!sameSession(session, this.view.session)) this.#adopt(session);
    else {
      this.view.session = session;
      this.#emit();
    }
    if (!session.signedIn) return;
    const epoch = this.#epoch;
    try {
      const [balance, models] = await Promise.all([
        this.client.balance(),
        this.client.models(),
      ]);
      if (!(await this.#owns(epoch, session)) || epoch !== this.#epoch) return;
      this.view.balance = balance;
      this.view.models = models.models;
      this.#emit();
    } catch (error) {
      if ((await this.#owns(epoch, session)) && epoch === this.#epoch) {
        this.#status(error);
        this.#emit();
      }
    }
  }
  async signIn(switchAccount = false) {
    if (this.view.busy) throw new SdkError("invalid_request");
    // Starting a newer transition fences a still-pending sign-out immediately.
    const epoch = ++this.#epoch,
      previous = this.view.session;
    this.view.busy = true;
    this.view.authenticating = true;
    this.view.status = "Signing in…";
    this.#emit();
    try {
      // Still synchronous with the button gesture: render does not await.
      const signed = await this.client.signIn(
        switchAccount ? { prompt: "login" } : {},
      );
      const actual = await this.#latest(epoch);
      if (!actual || epoch !== this.#epoch) return;
      this.#adopt(actual);
      if (sameSession(actual, signed)) await this.refresh();
    } catch (error) {
      if ((await this.#owns(epoch, previous)) && epoch === this.#epoch)
        this.#status(error);
    } finally {
      if ((await this.#owns(epoch, previous)) && epoch === this.#epoch) {
        this.view.busy = false;
        this.view.authenticating = false;
        this.#emit();
      }
    }
  }
  async signOut() {
    const epoch = ++this.#epoch,
      previous = this.view.session;
    const abort = this.#abort;
    this.#abort = undefined;
    this.#stream = undefined;
    abort?.abort();
    this.view = {
      session: signedOut,
      models: [],
      text: "",
      status: "Signing out…",
      charge: { state: "pending" },
      busy: false,
      authenticating: false,
    };
    this.#emit();
    try {
      const result = await this.client.signOut();
      const actual = await this.#latest(epoch);
      if (!actual || epoch !== this.#epoch) return;
      this.#adopt(actual);
      if (!actual.signedIn && actual.generation === result.generation) {
        this.view.status = result.revoked
          ? "Signed out; revocation confirmed."
          : "Signed out locally; server revocation was not confirmed.";
        this.#emit();
      }
    } catch (error) {
      const actual = await this.#latest(epoch);
      if (!actual || epoch !== this.#epoch) return;
      this.#adopt(actual);
      if (sameSession(actual, previous)) {
        this.#status(error);
        this.#emit();
      }
    }
  }
  #request(entry: Entry): ChatRequest {
    return {
      model: entry.model,
      messages: [
        { role: "user", content: [{ type: "text", text: entry.prompt }] },
      ],
      max_output_tokens: BigInt(entry.maxOutputTokens),
      max_output_tokens_strict: true,
    };
  }
  #save(entry: Entry) {
    this.journal.write(entry);
    this.view.entry = entry;
  }
  async send(model: string, prompt: string) {
    if (
      !prompt.trim() ||
      prompt.length > 8000 ||
      !this.view.models.some((m) => m.id === model)
    )
      throw new SdkError("invalid_request");
    if (this.view.entry && this.view.charge.state === "pending")
      throw new SdkError("unconfirmed");
    await this.#work(async (epoch, session, signal) => {
      const grant = await this.client.grant(signal);
      if (!(await this.#owns(epoch, session)) || epoch !== this.#epoch) return;
      if (
        !grant.enforced ||
        grant.sub !== session.subject ||
        !grant.scopes.includes("ai:invoke")
      ) {
        this.view.status =
          "This grant is not enforced or lacks AI access. Manage Free2Z account before spending.";
        return;
      }
      const entry: Entry = {
        subject: session.subject!,
        operationId: this.uuid(),
        idempotencyKey: this.uuid(),
        startedAt: this.now(),
        model,
        prompt,
        maxOutputTokens: "256",
      };
      const request = this.#request(entry);
      const check = await this.client.preflight(request, signal);
      if (!(await this.#owns(epoch, session)) || epoch !== this.#epoch) return;
      if (check.kind !== "ready") {
        this.view.status =
          check.kind === "needs_top_up"
            ? "Not enough 2Z. Use the account or billing button, then refresh."
            : check.kind === "needs_budget"
              ? "Manage this app's budget; getting more 2Z does not raise it."
              : "Shorten the prompt or choose a model that supports 256 output tokens.";
        return;
      }
      // A failed journal write aborts BEFORE any paid request is sent.
      this.#save(entry);
      this.view.text = "";
      this.view.charge = { state: "pending" };
      await this.#deliver(entry, epoch, session, signal);
    });
  }
  async recover() {
    await this.#work(async (epoch, session, signal) => {
      const entry = this.view.entry;
      if (!entry || entry.subject !== session.subject)
        throw new SdkError("signed_out");
      if (entry.callId) {
        const record = await this.client.waitForCall(entry.callId, {
          timeoutMs: 0,
          signal,
        });
        if (!(await this.#owns(epoch, session)) || epoch !== this.#epoch)
          return;
        this.#record(record);
      } else {
        const age = this.now() - entry.startedAt;
        if (age < 0 || age >= RECOVERY_WINDOW_MS) {
          this.view.status =
            "Same-key recovery is too old. Do not resend it: consult Free2Z call history/support. No new call was started.";
          return;
        }
        // Explicit user action, identical request and key, current same account.
        await this.#deliver(entry, epoch, session, signal);
      }
    });
  }
  #record(record: CallRecord) {
    if (this.view.entry)
      this.#save({ ...this.view.entry, callId: record.call_id });
    this.view.charge = record.charge;
    this.view.status =
      record.charge.state === "pending"
        ? "Still settling. Recover the receipt again later."
        : "Receipt recovered. The server does not replay answer text.";
  }
  async #deliver(
    entry: Entry,
    epoch: number,
    session: Session,
    signal: AbortSignal,
  ) {
    let stream: ChatStream | undefined;
    try {
      stream = await this.client.chat(this.#request(entry), {
        operationId: entry.operationId,
        idempotencyKey: entry.idempotencyKey,
        sessionGeneration: session.generation,
        signal,
      });
      if (!(await this.#owns(epoch, session)) || epoch !== this.#epoch) return;
      this.#stream = stream;
      if (stream.callId) this.#save({ ...entry, callId: stream.callId });
      for await (const event of stream) {
        if (!(await this.#owns(epoch, session)) || epoch !== this.#epoch)
          return;
        if (signal.aborted) throw new SdkError("cancelled");
        if (stream.callId) this.#save({ ...entry, callId: stream.callId });
        if (event.type === "delta") this.view.text += event.text;
        if (event.type === "replay") this.#record(event.record);
        if (event.type === "done" || event.type === "error") {
          this.view.charge = event.charge;
          this.view.status =
            event.type === "error"
              ? `Answer failed (${event.code}); inspect the charge.`
              : "Answer delivered; inspect the charge.";
        }
        this.#emit();
      }
    } catch (error) {
      if (!(await this.#owns(epoch, session)) || epoch !== this.#epoch) return;
      if (error instanceof SdkError && error.callId)
        this.#save({ ...entry, callId: error.callId });
      throw error;
    } finally {
      await stream?.cancel();
      if (this.#stream === stream) this.#stream = undefined;
    }
  }
  async #work(
    action: (
      epoch: number,
      session: Session,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {
    if (this.view.busy) throw new SdkError("invalid_request");
    const openingEpoch = this.#epoch;
    const session = await this.#latest(openingEpoch);
    if (!session || openingEpoch !== this.#epoch) return;
    if (
      this.view.busy ||
      !session.signedIn ||
      session.subject !== this.view.session.subject ||
      session.generation !== this.view.session.generation ||
      !session.grantedScopes.includes("ai:invoke")
    )
      throw new SdkError("signed_out");
    const epoch = ++this.#epoch;
    this.view.busy = true;
    const abort = new AbortController();
    this.#abort = abort;
    this.#emit();
    try {
      await action(epoch, session, abort.signal);
      if (!(await this.#owns(epoch, session)) || epoch !== this.#epoch) return;
      if (this.view.charge.state !== "pending") {
        const balance = await this.client.balance(abort.signal);
        if (!(await this.#owns(epoch, session)) || epoch !== this.#epoch)
          return;
        this.view.balance = balance;
      }
    } catch (error) {
      if ((await this.#owns(epoch, session)) && epoch === this.#epoch)
        this.#status(error);
    } finally {
      if ((await this.#owns(epoch, session)) && epoch === this.#epoch) {
        this.view.busy = false;
        this.#emit();
      }
      if (this.#abort === abort) this.#abort = undefined;
    }
  }
  async cancel() {
    // Never re-read these handles after an await: they may belong to a newer call.
    const epoch = this.#epoch,
      session = this.view.session;
    const abort = this.#abort,
      stream = this.#stream;
    abort?.abort();
    try {
      await stream?.cancel();
      if (!(await this.#owns(epoch, session)) || epoch !== this.#epoch) return;
      this.view.status =
        "Delivery stopped. Generation and charging may continue; recover the receipt.";
      this.#emit();
    } catch (error) {
      if ((await this.#owns(epoch, session)) && epoch === this.#epoch) {
        this.#status(error);
        this.#emit();
      }
    }
  }
}

export function browserJournal(storage: Storage, appId: string): Journal {
  const prefix = `hello-ai:${encodeURIComponent(appId)}:`;
  return {
    read(subject) {
      const raw = storage.getItem(prefix + subject);
      if (!raw) return;
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object")
        throw new Error("Invalid recovery journal");
      const e = value as Entry;
      if (
        e.subject !== subject ||
        !Number.isSafeInteger(e.startedAt) ||
        e.startedAt < 0 ||
        ![e.operationId, e.idempotencyKey].every(
          (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v),
        ) ||
        typeof e.model !== "string" ||
        !e.model ||
        typeof e.prompt !== "string" ||
        e.prompt.length > 8000 ||
        e.maxOutputTokens !== "256" ||
        (e.callId !== undefined &&
          (typeof e.callId !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(e.callId)))
      )
        throw new Error("Invalid recovery journal");
      return e;
    },
    write(entry) {
      storage.setItem(prefix + entry.subject, JSON.stringify(entry));
    },
  };
}
