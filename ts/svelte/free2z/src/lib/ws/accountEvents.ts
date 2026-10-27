/** These backend events reuse their UUID and advance by one integral vote. */
const VOTE_EVENTS = new Set([
  "PAGE_VOTE",
  "VOTE_COMMENT_SENT",
  "VOTE_COMMENT_RECEIVED",
]);
export function isVoteEvent(event: { type: string }): boolean {
  return VOTE_EVENTS.has(event.type);
}
export function voteRevision(event: {
  type: string;
  amount?: unknown;
}): number | undefined {
  return VOTE_EVENTS.has(event.type) &&
    typeof event.amount === "number" &&
    Number.isSafeInteger(event.amount) &&
    event.amount > 0
    ? event.amount
    : undefined;
}
export function newerVote(
  event: { type: string; amount?: unknown },
  previous: { type: string; amount?: unknown },
): boolean {
  const next = voteRevision(event),
    old = voteRevision(previous);
  return (
    event.type === previous.type &&
    next !== undefined &&
    old !== undefined &&
    next > old
  );
}

/** Shared delivery policy; rendering and authoritative account reads belong to the client. */
export type AccountEvent = {
  id: string;
  type: string;
  read: boolean;
  receiving_user: { username: string };
  created_at?: string;
  amount?: number | null;
  payment_reference?: {
    intent_id?: string;
    payment_id?: string;
    status: string;
  } | null;
};

const RECEIPT_EVENTS = new Set(["BOUGHT_TUZI", "ZEC_PENDING"]);

const BALANCE_EVENTS = new Set([
  "BOUGHT_TUZI",
  "ENCRYPTED_CHAT_REQUEST",
  "PAGE_VOTE",
  "DONATION_RECEIVED",
  "DONATION_SENT",
  "SUBSCRIPTION_RECEIVED",
  "SUBSCRIPTION_SENT",
  "PLATFORM_FEE",
  "PAY_PER_VIEW_REVENUE",
  "PAY_PER_VIEW_SPEND",
  "CHAT2Z",
  "AISCORE_COMMENT",
  "MADE_COMMENT",
  "VOTE_COMMENT_RECEIVED",
  "VOTE_COMMENT_SENT",
]);

export function createAccountEventDelivery<E extends AccountEvent>(options: {
  username: () => string;
  add: (event: E, countUnread?: boolean) => void | boolean;
  notify: (event: E) => void;
  paymentSettled?: (intentId: string) => void;
  refresh: (username: string, routes: boolean) => Promise<void>;
  retryDelaysMs?: readonly number[];
  history?: (username: string, signal: AbortSignal) => Promise<E[] | null>;
  historyTimeoutMs?: number;
}) {
  const seen = new Set<string>();
  const voteRevisions = new Map<string, number>();
  // Receipt rescans must also recognize IDs evicted from the social-event LRU.
  // Retain IDs only, for this account session, until reset.
  const acknowledgedReceipts = new Set<string>();
  const creditedIntents = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let running = false;
  let historyController: AbortController | null = null;
  let refreshController: AbortController | null = null;
  let dirty = false;
  let refreshRoutes = false;
  let retries = 0;
  let recoverHistory = false;
  let historyInitialized = false;
  let historyDemand = 0;
  let activeHistoryDemand: number | null = null;
  const retryDelays = options.retryDelaysMs ?? [1000, 3000];

  async function readHistory(username: string) {
    const controller = new AbortController();
    historyController = controller;
    const timeout = setTimeout(
      () =>
        controller.abort(
          new DOMException("Receipt recovery timed out", "TimeoutError"),
        ),
      options.historyTimeoutMs ?? 15_000,
    );
    let abort: (() => void) | undefined;
    try {
      // Bound headers and body reads, even if an adapter ignores cancellation.
      // The store also fences aborted results before any feed mutation.
      return await new Promise<E[] | null>((resolve, reject) => {
        abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) return abort();
        Promise.resolve(options.history!(username, controller.signal)).then(
          (records) =>
            controller.signal.aborted
              ? reject(controller.signal.reason)
              : resolve(records),
          reject,
        );
      });
    } finally {
      clearTimeout(timeout);
      if (abort) controller.signal.removeEventListener("abort", abort);
      if (historyController === controller) historyController = null;
    }
  }

  async function readBalance(username: string, routes: boolean) {
    const controller = new AbortController();
    refreshController = controller;
    let abort: (() => void) | undefined;
    try {
      // The auth store bounds the actual request. A new credit must also retire
      // this queue phase immediately, so its fresh read does not wait for an
      // older GET's headers/body. Fresh auth checks fence the older response.
      await new Promise<void>((resolve, reject) => {
        abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) return abort();
        Promise.resolve(options.refresh(username, routes)).then(
          resolve,
          reject,
        );
      });
    } finally {
      if (abort) controller.signal.removeEventListener("abort", abort);
      if (refreshController === controller) refreshController = null;
    }
  }

  function scheduleRefresh(delay = 100) {
    if (timer || running) return;
    const epoch = generation;
    timer = setTimeout(async () => {
      timer = null;
      const username = options.username();
      if (!username || epoch !== generation) return;
      running = true;
      dirty = false;
      const routes = refreshRoutes;
      refreshRoutes = false;
      let failed = false;
      let historyAttempt = false;
      try {
        await readBalance(username, routes);
        if (epoch !== generation || options.username() !== username) return;
        if (recoverHistory && options.history) {
          recoverHistory = false;
          historyAttempt = true;
          activeHistoryDemand ??= historyDemand;
          const scanDemand = activeHistoryDemand;
          const records = await readHistory(username);
          if (epoch !== generation || options.username() !== username) return;
          if (records === null) {
            // A bounded receipt batch has a continuation. Do not acknowledge
            // an incomplete initial scan; resume without spending error retries.
            recoverHistory = true;
            dirty = true;
            return;
          }
          if (!historyInitialized) {
            for (const event of records) {
              if (event.receiving_user?.username !== username) continue;
              // Initial receipts remain quiet, but their current status must
              // retire an earlier live pending notice after a missed credit.
              observePaymentSettlement(event);
              remember(event.id);
              if (RECEIPT_EVENTS.has(event.type))
                acknowledgedReceipts.add(event.id);
            }
            historyInitialized = true;
          } else {
            let surfaced = 0;
            for (const event of records) {
              // Keep normal pagination bounded even after a long absence.
              // Every new receipt is acknowledged/announced, but at most a
              // normal page of newly unread receipts is surfaced automatically.
              const addToFeed = !event.read && surfaced < 12;
              if (
                receive(
                  event,
                  RECEIPT_EVENTS.has(event.type),
                  false,
                  addToFeed,
                  false,
                ) &&
                addToFeed
              )
                surfaced += 1;
            }
          }
          activeHistoryDemand = null;
          if (historyDemand !== scanDemand) {
            recoverHistory = true;
            dirty = true;
          }
          // A credit can commit after the pre-history read, including a read
          // or deduplicated receipt. Always settle balances after observation.
          await readBalance(username, true);
          if (epoch !== generation || options.username() !== username) return;
        }
      } catch {
        // Retry reads independently of deduplicated durable notifications.
        if (epoch === generation && options.username() === username) {
          failed = true;
          refreshRoutes ||= routes;
          recoverHistory ||= historyAttempt;
        }
      } finally {
        if (epoch === generation) {
          running = false;
          if (dirty) {
            retries = 0;
            scheduleRefresh();
          } else if (failed && retries < retryDelays.length) {
            scheduleRefresh(retryDelays[retries++]);
          } else {
            retries = 0;
          }
        }
      }
    }, delay);
  }

  function remember(id: string) {
    seen.add(id);
    if (seen.size > 2000) {
      const oldest = seen.values().next().value!;
      seen.delete(oldest);
    }
  }

  function reconcile(history = false, routes = true) {
    if (!options.username()) return;
    dirty = true;
    if (history) historyDemand += 1;
    recoverHistory ||= history;
    refreshRoutes ||= routes;
    scheduleRefresh();
  }

  function observePaymentSettlement(event: E) {
    const reference = RECEIPT_EVENTS.has(event.type)
      ? event.payment_reference
      : null;
    const paymentId = reference?.payment_id || reference?.intent_id;
    const settled =
      reference &&
      (event.type === "BOUGHT_TUZI" ||
        [
          "credited",
          "refunded",
          "partially_refunded",
          "disputed",
          "clawed_back",
        ].includes(reference.status));
    if (settled && paymentId && !creditedIntents.has(paymentId)) {
      creditedIntents.add(paymentId);
      options.paymentSettled?.(paymentId);
    }
    return (
      event.type === "ZEC_PENDING" &&
      paymentId &&
      creditedIntents.has(paymentId)
    );
  }

  function receive(
    event: E,
    announce = true,
    refresh = true,
    addToFeed = true,
    countUnread = true,
  ): boolean {
    const username = options.username();
    if (!username || !event?.id || event.receiving_user?.username !== username)
      return false;
    const obsoletePending = observePaymentSettlement(event);
    const revision = voteRevision(event);
    const priorRevision = voteRevisions.get(event.id);
    if (
      (priorRevision !== undefined &&
        (revision === undefined || revision <= priorRevision)) ||
      (seen.has(event.id) && priorRevision === undefined) ||
      acknowledgedReceipts.has(event.id)
    )
      return false;
    // Bound generic delivery memory; receipt IDs and vote revisions remain
    // account-scoped so full recovery and delayed social replays stay quiet.
    remember(event.id);
    if (revision !== undefined) voteRevisions.set(event.id, revision);
    if (RECEIPT_EVENTS.has(event.type)) acknowledgedReceipts.add(event.id);
    // Feed membership is not evidence that the account balance was refreshed.
    // Only a rejected vote revision suppresses its notice. A first unread
    // receipt still announces even if HTTP already inserted its normal row.
    const added = addToFeed ? options.add(event, countUnread) : undefined;
    if (
      announce &&
      !obsoletePending &&
      !event.read &&
      (added !== false || !isVoteEvent(event))
    )
      options.notify(event);
    if (refresh && BALANCE_EVENTS.has(event.type)) {
      dirty = true;
      refreshRoutes = true;
      // A live credit must not wait behind receipt history or metadata reads.
      refreshController?.abort(
        new DOMException(
          "Account read superseded by a balance event",
          "AbortError",
        ),
      );
      historyController?.abort(
        new DOMException(
          "Receipt recovery yielded to a balance event",
          "AbortError",
        ),
      );
      scheduleRefresh();
    }
    return true;
  }

  function reset() {
    generation += 1;
    historyController?.abort(new DOMException("Account changed", "AbortError"));
    historyController = null;
    refreshController?.abort(new DOMException("Account changed", "AbortError"));
    refreshController = null;
    if (timer) clearTimeout(timer);
    timer = null;
    running = false;
    dirty = false;
    refreshRoutes = false;
    retries = 0;
    seen.clear();
    voteRevisions.clear();
    recoverHistory = false;
    historyInitialized = false;
    historyDemand = 0;
    activeHistoryDemand = null;
    acknowledgedReceipts.clear();
    creditedIntents.clear();
  }

  return { receive, reset, reconcile };
}
