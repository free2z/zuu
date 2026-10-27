import { toast as sonnerToast } from "svelte-sonner";
import { get, writable } from "svelte/store";
import { goto } from "$app/navigation";
import { tStore as t, locale } from "$lib/i18n";

type Id = string | number;
type Notice = {
  id: Id;
  create: (...args: any[]) => any;
  message: any;
  options: any;
  payment: boolean;
  urgent: boolean;
  baseMessage?: string;
  repeatCount?: number;
  overflowCount?: number;
};
const MAX_QUEUED = 50;
const ROUTINE_DURATION = 5_000;
const EXIT_DELAY = 250; // pinned Sonner removes exiting nodes after 200 ms
const rendered = new Map<Id, Notice>();
const closing = new Set<Id>();
const postponed = new Set<Id>();
const queue: Notice[] = [];
let payment: Notice | undefined;
let overflow = 0;
let nextId = 0;
let currentAccount = "";
let currentUsername = "";
let identityGeneration = 0;
let ready = true;
let pumpTimer: ReturnType<typeof setTimeout> | undefined;
let pendingPresentations = 0;
let presentationObserver: MutationObserver | undefined;
function observePresentation() {
  if (presentationObserver || typeof document === "undefined") return;
  presentationObserver = new MutationObserver(() => {
    const active = new Set(
      sonnerToast.getActiveToasts().map((notice) => notice.id),
    );
    // Vendor action/cancel buttons remove notices without invoking onDismiss.
    for (const id of rendered.keys()) if (!active.has(id)) finish(id);
  });
  presentationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}
export const toastPresentation = writable({ generation: 0, ready: true });

function schedulePump() {
  if (pumpTimer !== undefined) return;
  pumpTimer = setTimeout(() => {
    pumpTimer = undefined;
    pump();
  }, EXIT_DELAY);
}
function finish(id: Id) {
  if (rendered.delete(id)) closing.add(id);
  schedulePump();
}
function show(notice: Notice) {
  postponed.delete(notice.id);
  const newPresentation = !rendered.has(notice.id);
  rendered.set(notice.id, notice);
  if (newPresentation) pendingPresentations++;
  const options = notice.options;
  const generation = identityGeneration;
  const closingButton = (button: any, cancel = false) => {
    if (!button || typeof button !== "object") return button;
    return {
      ...button,
      onClick: (event: MouseEvent) => {
        if (generation !== identityGeneration) {
          event.preventDefault();
          return;
        }
        button.onClick?.(event);
        // Match the pinned vendor: actions honor preventDefault, cancels
        // always close. Account resets must never retire a reused ID.
        if (
          generation !== identityGeneration ||
          (!cancel && event.defaultPrevented)
        )
          return;
        const latest = rendered.get(notice.id);
        if (!latest) return;
        finish(notice.id);
        // A callback may itself update this ID. Preserve that newer notice
        // behind the old DOM exit instead of letting its timer delete it.
        if (latest !== notice)
          enqueue(
            latest.create,
            latest.message,
            latest.options,
            latest.payment,
            latest.urgent,
          );
      },
    };
  };
  Reflect.apply(notice.create, undefined, [
    notice.message,
    {
      ...options,
      id: notice.id,
      action: closingButton(options?.action),
      cancel: closingButton(options?.cancel, true),
      duration:
        options?.duration ??
        (notice.urgent ||
        notice.payment ||
        notice.create === sonnerToast.loading
          ? Infinity
          : ROUTINE_DURATION),
      onDismiss: (value: any) => {
        if (generation !== identityGeneration) return;
        finish(notice.id);
        if (!postponed.delete(notice.id)) options?.onDismiss?.(value);
      },
      onAutoClose: (value: any) => {
        if (generation !== identityGeneration) return;
        finish(notice.id);
        if (!postponed.delete(notice.id)) options?.onAutoClose?.(value);
      },
    },
  ]);
  if (newPresentation)
    queueMicrotask(() => {
      if (generation !== identityGeneration) return;
      pendingPresentations--;
      if (payment || queue.length || overflow) schedulePump();
    });
}
function presentationHasRoom() {
  return (
    document.querySelectorAll("[data-sonner-toast]").length +
      pendingPresentations <
    3
  );
}
function pump() {
  if (typeof document === "undefined" || !ready) return;
  // Wait for actual vendor unmount, including delayed/background animations.
  if (closing.size) {
    if (
      pumpTimer !== undefined ||
      document.querySelector("[data-sonner-toast][data-removed='true']")
    ) {
      schedulePump();
      return;
    }
    closing.clear();
  }
  if (!presentationHasRoom()) {
    if (payment || queue.length || overflow) schedulePump();
    return;
  }
  if (payment && !rendered.has(payment.id)) {
    const next = payment;
    payment = undefined;
    show(next);
  }
  // Routine acknowledgements occupy at most one generic slot. Actionable
  // notices may use either free slot, without evicting an active important one.
  while (
    [...rendered.values()].filter((notice) => !notice.payment).length < 2 &&
    presentationHasRoom()
  ) {
    const urgentIndex = queue.findIndex((notice) => notice.urgent);
    if (urgentIndex >= 0) {
      show(queue.splice(urgentIndex, 1)[0]);
      continue;
    }
    if (
      [...rendered.values()].some((notice) => !notice.payment && !notice.urgent)
    )
      break;
    const next = queue.shift();
    if (next) show(next);
    else if (overflow) {
      const omitted = overflow;
      overflow = 0;
      show({
        id: `notice-overflow-${identityGeneration}-${nextId++}`,
        create: sonnerToast.warning,
        message: get(t)(
          "notifications.noticeOverflow",
          "{count} additional notices could not be displayed.",
          { count: omitted.toLocaleString(get(locale)) },
        ),
        options: {
          duration: Infinity,
          description: get(t)(
            "notifications.noticeOverflowDetails",
            "Review your notifications and the affected activity for details.",
          ),
          action: currentUsername
            ? {
                label: get(t)(
                  "notifications.noticeOverflowReview",
                  "Review notifications",
                ),
                onClick: () => {
                  if (currentUsername)
                    void goto(
                      `/${encodeURIComponent(currentUsername)}/dashboard/notifications`,
                    );
                },
              }
            : undefined,
        },
        payment: false,
        urgent: false,
        overflowCount: omitted,
      });
    } else break;
  }
}
export function setToastAccount(identity: string, username = "") {
  if (identity === currentAccount) {
    currentUsername = username;
    return;
  }
  currentAccount = identity;
  currentUsername = username;
  identityGeneration++;
  ready = false;
  if (pumpTimer !== undefined) clearTimeout(pumpTimer);
  pumpTimer = undefined;
  queue.length = 0;
  payment = undefined;
  overflow = 0;
  rendered.clear();
  pendingPresentations = 0;
  closing.clear();
  postponed.clear();
  sonnerToast.dismiss();
  // Keyed, hidden presentation removes old private DOM immediately; allow the
  // replacement to complete queued vendor removals before showing new notices.
  toastPresentation.set({ generation: identityGeneration, ready: false });
  const generation = identityGeneration;
  setTimeout(() => {
    if (generation !== identityGeneration) return;
    ready = true;
    toastPresentation.set({ generation, ready: true });
    pump();
  }, EXIT_DELAY);
}
function enqueue(
  create: Notice["create"],
  message: any,
  options: any,
  isPayment = false,
  important = false,
) {
  if (typeof window === "undefined")
    return options?.id ?? `f2z-notice-${identityGeneration}-${nextId++}`;
  observePresentation();
  const urgent =
    important ||
    create === sonnerToast.error ||
    create === sonnerToast.warning ||
    Boolean(options?.action || options?.cancel);
  const baseMessage = typeof message === "string" ? message : undefined;
  if (
    urgent &&
    options?.id === undefined &&
    !options?.action &&
    !options?.cancel &&
    baseMessage !== undefined
  ) {
    const repeated = [...rendered.values(), ...queue].find(
      (entry) =>
        entry.urgent &&
        entry.create === create &&
        entry.options?.id === undefined &&
        !entry.options?.action &&
        !entry.options?.cancel &&
        entry.baseMessage === baseMessage,
    );
    if (repeated) {
      repeated.repeatCount = (repeated.repeatCount ?? 1) + 1;
      repeated.message = `${baseMessage} (×${repeated.repeatCount})`;
      if (rendered.has(repeated.id)) show(repeated);
      return repeated.id;
    }
  }
  const id = options?.id ?? `f2z-notice-${identityGeneration}-${nextId++}`;
  const notice = {
    id,
    create,
    message,
    options,
    payment: isPayment,
    urgent,
    baseMessage,
    repeatCount: 1,
  };
  if (rendered.has(id)) {
    show(notice);
    return id;
  }
  // Reclaim only a routine presentation when an actionable outcome arrives.
  // It is queued again, not acknowledged; never displace a payment/failure/action.
  if (
    !isPayment &&
    urgent &&
    [...rendered.values()].filter((entry) => !entry.payment).length >= 2
  ) {
    const routine = [...rendered.values()].find(
      (entry) => !entry.payment && !entry.urgent,
    );
    if (routine) {
      if (queue.length < MAX_QUEUED) queue.unshift(routine);
      else
        overflow = Math.min(
          overflow + (routine.overflowCount ?? 1),
          Number.MAX_SAFE_INTEGER,
        );
      postponed.add(routine.id);
      finish(routine.id);
      sonnerToast.dismiss(routine.id);
    }
  }
  const existing = queue.findIndex((entry) => entry.id === id);
  if (
    !isPayment &&
    urgent &&
    ready &&
    !closing.size &&
    presentationHasRoom() &&
    [...rendered.values()].filter((entry) => !entry.payment).length < 2
  ) {
    if (existing >= 0) queue.splice(existing, 1);
    show(notice);
    return id;
  }
  if (isPayment) payment = notice;
  else if (existing >= 0) queue[existing] = notice;
  else if (queue.length < MAX_QUEUED) queue.push(notice);
  else if (urgent) {
    // Important/actionable outcomes must remain individually available until
    // acknowledged. The rendered surface stays capped, but this queue is
    // deliberately allowed to grow when distinct urgent outcomes exceed the
    // routine backlog limit; reporting only a count would lose the outcome.
    queue.push(notice);
  } else {
    // Routine outcomes compact into the accessible aggregate below.
    overflow = Math.min(overflow + 1, Number.MAX_SAFE_INTEGER);
  }
  pump();
  return id;
}
function dismissNotice(id?: Id) {
  if (id === undefined) {
    queue.length = 0;
    payment = undefined;
    overflow = 0;
    for (const active of rendered.keys()) finish(active);
  } else {
    const index = queue.findIndex((entry) => entry.id === id);
    if (index >= 0) queue.splice(index, 1);
    if (payment?.id === id) payment = undefined;
    finish(id);
  }
  return sonnerToast.dismiss(id);
}
function queued<T extends (...args: any[]) => any>(
  create: T,
  important = false,
): T {
  return new Proxy(create, {
    apply(_target, _thisArg, [message, options]) {
      return enqueue(create, message, options, false, important);
    },
  });
}
// One reserved slot describes the latest actual credit. Durable notifications
// retain individual receipts; this summary never fabricates cumulative totals.
export function paymentCreditedToast(message: string, options: any) {
  return enqueue(
    sonnerToast.success,
    message,
    {
      ...options,
      id: `payment-summary-${identityGeneration}`,
      duration: Infinity,
    },
    true,
  );
}
export function toastQueueStatus() {
  return {
    rendered: rendered.size,
    queued: queue.length,
    urgentQueued: queue.filter((notice) => notice.urgent).length,
    overflow,
    paymentQueued: Boolean(payment),
  };
}

// The pinned vendor also omits options on terminal promise notifications.
// Forward them explicitly even without a loading message, or after a loading
// toast has been dismissed, while retaining its return and callback behavior.
const promise = new Proxy(sonnerToast.promise, {
  apply(_target, _thisArg, [pending, data]) {
    if (!data) return undefined;
    const generation = identityGeneration;
    const options = { ...data };
    let id: string | number | undefined;
    if (data.loading !== undefined) {
      id = Reflect.apply(toast.loading, undefined, [
        typeof data.loading === "function" ? data.loading() : data.loading,
        { ...options, promise: pending },
      ]);
    }
    const result = pending instanceof Promise ? pending : pending();
    let shouldDismiss = id !== undefined;
    const notify = (method: typeof toast.success, message: unknown) => {
      shouldDismiss = false;
      // Account reset already removed old progress. Never dismiss an explicit
      // ID here: the current account may have reused it for a new notice.
      if (generation !== identityGeneration) return;
      Reflect.apply(method, undefined, [
        message,
        { ...options, id: id ?? data.id },
      ]);
    };
    result
      .then((response: any) => {
        if (
          response &&
          typeof response === "object" &&
          typeof response.ok === "boolean" &&
          !response.ok
        ) {
          notify(
            toast.error,
            "status" in response
              ? `HTTP error! Status: ${response.status}`
              : `Error! ${response}`,
          );
        } else if (data.success !== undefined) {
          notify(
            toast.success,
            typeof data.success === "function"
              ? data.success(response)
              : data.success,
          );
        }
      })
      .catch((error: unknown) => {
        if (data.error !== undefined) {
          notify(
            toast.error,
            typeof data.error === "function" ? data.error(error) : data.error,
          );
        }
      })
      .finally(() => {
        if (shouldDismiss && generation === identityGeneration)
          toast.dismiss(id);
        data.finally?.();
      });
    return id;
  },
});

export const toast: typeof sonnerToast & {
  acknowledge: typeof sonnerToast.success;
} = Object.assign(
  (...args: Parameters<typeof sonnerToast>) => queued(sonnerToast)(...args),
  {
    success: queued(sonnerToast.success),
    acknowledge: queued(sonnerToast.success, true),
    info: queued(sonnerToast.info),
    warning: queued(sonnerToast.warning),
    error: queued(sonnerToast.error),
    custom: queued(sonnerToast.custom),
    message: queued(sonnerToast.message),
    promise,
    loading: queued(sonnerToast.loading),
    dismiss: dismissNotice,
    getActiveToasts: sonnerToast.getActiveToasts,
  },
);

// Capture before starting a private operation, so a late response cannot
// display its receipt after sign-out, account switching, or A → B → A.
export function captureAccountToast(
  hooks: { onError?: (message: unknown) => void } = {},
) {
  const generation = identityGeneration;
  const scoped = <T extends typeof toast.success>(method: T): T =>
    new Proxy(method, {
      apply(target, thisArg, args) {
        if (generation !== identityGeneration) {
          // Only generic sign-in guidance may cross a transition to anonymous.
          // Do not forward private server text, amounts, actions or callbacks.
          if (target === toast.error && !currentAccount)
            return toast.error(
              get(t)("economy.signInAgain", "Sign in again before continuing."),
              { id: `signin-required-${identityGeneration}` },
            );
          return args[1]?.id ?? "stale-account-notification";
        }
        if (target === toast.error) hooks.onError?.(args[0]);
        return Reflect.apply(target, thisArg, args);
      },
    });
  return {
    isCurrent: () => generation === identityGeneration,
    success: scoped(toast.success),
    acknowledge: scoped(toast.acknowledge),
    info: scoped(toast.info),
    warning: scoped(toast.warning),
    error: scoped(toast.error),
    message: scoped(toast.message),
  };
}
