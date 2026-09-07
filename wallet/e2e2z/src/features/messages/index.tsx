// Encrypted messages — this app's whole screen.
//
// Moved from `wallet/zuuli/src/features/messages/index.tsx` in #904 phase 3.
// The only behavioural change is the enrollment gap: e2e2z holds no wallet
// seed, so `enrollment.getEnrollmentStatus()` refuses rather than answering,
// and that refusal gets its own rendered state instead of an unhandled
// rejection that would leave the page on its loading skeleton forever.
//
// # #973 — the header above was right, and applied to one call in three
//
// The first packaged build of this app never left its skeleton on a real
// device, and the reason was structural rather than exotic. `reconcile` read
// three things through one `Promise.all`, and only the enrollment call carried
// the protection this header describes. Any rejection from the other two took
// the whole read down, the `void reconcile()` that started it swallowed the
// rejection, `status` stayed `null`, and the gate below rendered a skeleton
// forever with nothing said to the user.
//
// What was actually rejecting is `get_device_info`, and it rejects on **every**
// e2e2z install rather than occasionally. `Engine::device_info` reads the
// stored device identity and answers §8 `not-enrolled` when there is none; the
// only writer of that record is `Engine::install_identity`, whose only
// production caller is ZUULI's app crate. This app holds no seed and has no
// transport for the `issue-device-credential` intent (#905, blocked on #461),
// so it never installs an identity and never can, today. The refusal is
// permanent and by construction — which is exactly why the app was unusable on
// the first device it ever ran on, and exactly why every test passed: they all
// mocked a `DeviceInfo` that a packaged build cannot produce.
//
// So two things changed, and the second is the more important one:
//
//   1. **`Promise.allSettled`, judged per call.** The three reads are not
//      equals. The engine status has no substitute — every branch below reads
//      it — so its rejection is a rendered failure. The enrollment refusal is a
//      designed state. Device info is supplementary, its only consumer is the
//      already-conditional `<BrowserGuarantee>`, and losing it must not cost
//      the user a working engine summary.
//   2. **Nothing here can end in an unrendered state.** `not-enrolled` from
//      device info reads as the enrollment gap, because that is what it means
//      and it is true. Every other refusal is named on screen, with the wire
//      command that produced it, because the cost of #973 was not the outage —
//      it was that a device could not tell anyone which of three calls failed.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Play,
  Power,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { PageHeader } from "../../components/common/PageHeader";
import { Button } from "../../components/ui/button";
import { Callout } from "../../components/ui/callout";
import { Skeleton } from "../../components/ui/skeleton";
import {
  enrollment,
  isEnrollmentUnavailable,
  messaging,
} from "../../lib/messaging/bridge";
import { listenMessaging } from "../../lib/messaging/events";
import {
  ErrorCodeSchema,
  type Conversation,
  type DeviceInfo,
  type EngineState,
  type EngineStatus,
  type EnrollmentStatus,
  type IneligibilityReason,
} from "../../lib/messaging/types";
import { BrowserGuarantee } from "./BrowserGuarantee";
import { FirstContact } from "./FirstContact";
import { Transcript } from "./Transcript";

const STATE_COPY: Record<EngineState, string> = {
  uninitialized: "No wallet, or the engine has not started.",
  ineligible: "This account's username cannot be a messaging handle.",
  "not-enrolled": "Eligible, with no directory entry yet.",
  enrolling: "Submitted to the directory, waiting for the log to merge it.",
  locked:
    "Enrolled, but the seed is unavailable, so local history stays sealed.",
  starting: "Connecting to relays.",
  running: "Connected.",
  degraded:
    "Connected, with relays unreachable or the witness threshold unmet.",
  stopped: "Stopped. Local history is untouched.",
  faulted: "Stopped by an error that needs you to act before restarting.",
};

const INELIGIBILITY_COPY: Record<IneligibilityReason, string> = {
  punctuation:
    "A messaging handle cannot contain a dot, an at sign, a plus or a hyphen.",
  "non-ascii":
    "A messaging handle can only use the characters a to z, 0 to 9, and the underscore.",
  "too-long": "A messaging handle can be at most 30 characters long.",
  "not-signed-in": "Sign in to see whether your username can be a handle.",
};

/** A running state, in §6.1's sense: degraded still sends and receives. */
function isRunning(state: EngineState): boolean {
  return state === "running" || state === "degraded";
}

/**
 * A rejected bridge call, as something the screen can render.
 *
 * `call` is the **wire** command name rather than a friendly label, and that is
 * deliberate: it is the string a bug report has to carry, and #973 cost a
 * TestFlight build and a device precisely because the screen could not say
 * which of three calls had failed.
 */
interface CallFailure {
  call: string;
  detail: string;
}

/**
 * The text of a rejection, whatever shape it arrived in.
 *
 * `tauri-plugin-f2zmsg` serializes every error as the **bare** §8 `ErrorCode`
 * and nothing else (`error.rs`: `serializer.serialize_str(self.code.as_str())`),
 * so a real `invoke` rejection is a `string`, not an `Error`. A formatter that
 * only understood `Error` would render `[object Object]` for every genuine
 * backend failure while looking perfectly correct against the fakes in the
 * tests — the same shape of blind spot that let #973 ship.
 *
 * Unlike `FirstContact`'s `refusalCode`, an unrecognized cause is **not**
 * flattened to `internal` here. This is the surface of last resort, and
 * collapsing the one piece of evidence it exists to show would defeat it.
 */
function failureDetail(cause: unknown): string {
  const code = ErrorCodeSchema.safeParse(cause);
  if (code.success) return code.data;
  if (cause instanceof Error && cause.message !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause.trim();
  return String(cause);
}

/**
 * §8 `not-enrolled`, which for **this** app is a standing condition, not a
 * fault.
 *
 * `Engine::device_info` answers it whenever no device identity is installed,
 * and installing one is the wallet authority's job (#905, blocked on #461). So
 * e2e2z gets this answer on every install, indefinitely — it has to read as the
 * enrollment gap, which is true, rather than as an error, which is not.
 */
function isNotEnrolled(cause: unknown): boolean {
  return failureDetail(cause) === "not-enrolled";
}

/**
 * The reads that failed while the rest of the screen still works.
 *
 * Separate from the blocking failure state on purpose: taking a whole surface
 * away because one supplementary call refused is the `Promise.all` mistake in
 * a different costume.
 */
function DegradedReads({ failures }: { failures: CallFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <Callout
      tone="warning"
      icon={ShieldAlert}
      title="Part of this screen could not be read"
    >
      <p>
        Everything else below is current. What did not come back, and what the
        engine said about it:
      </p>
      <ul className="mt-2 space-y-1">
        {failures.map((failure) => (
          <li key={failure.call} className="mono-id break-words">
            {failure.call} — {failure.detail}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

function EngineSummary({ status }: { status: EngineStatus }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-3">
      <div className="rounded-xl border border-border bg-card p-4">
        <dt className="eyebrow text-muted-foreground">Engine</dt>
        <dd className="mt-1 font-medium text-foreground">{status.state}</dd>
        <dd className="mt-1 text-sm text-muted-foreground">
          {STATE_COPY[status.state]}
        </dd>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <dt className="eyebrow text-muted-foreground">Relays</dt>
        <dd className="bidi-number numeral mt-1 text-foreground">
          {status.relaysConnected} of {status.relaysConfigured}
        </dd>
        <dd className="mt-1 text-sm text-muted-foreground">
          Connected relays out of those configured.
        </dd>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <dt className="eyebrow text-muted-foreground">Witnesses</dt>
        <dd className="bidi-number numeral mt-1 text-foreground">
          {status.independentWitnesses}
        </dd>
        <dd className="mt-1 text-sm text-muted-foreground">
          Independent witnesses currently cosigning the directory log.
        </dd>
      </div>
    </dl>
  );
}

export default function MessagesFeature() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [enrolled, setEnrolled] = useState<EnrollmentStatus | null>(null);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [conversations, setConversations] = useState<Conversation[] | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrollmentGap, setEnrollmentGap] = useState(false);
  const [failure, setFailure] = useState<CallFailure | null>(null);
  const [degraded, setDegraded] = useState<CallFailure[]>([]);
  const [actionFailure, setActionFailure] = useState<CallFailure | null>(null);
  const [listenFailure, setListenFailure] = useState<CallFailure | null>(null);
  const reconcileGeneration = useRef(0);

  /**
   * Read everything the screen needs, and **end in a rendered state whatever
   * happens** (#973 — see the file header).
   *
   * `allSettled` rather than `all` because the three reads are not equals, and
   * treating them as equals is what broke: a failed device-info read threw away
   * a perfectly good engine status, and there was nowhere for the rejection to
   * go.
   */
  const reconcile = useCallback(async () => {
    const generation = ++reconcileGeneration.current;
    const superseded = () => generation !== reconcileGeneration.current;

    const [engineResult, enrollmentResult, deviceResult] =
      await Promise.allSettled([
        messaging.getEngineStatus(),
        // The one call this app cannot make. A refusal is a state to render,
        // not an error to swallow: anything else here reads as "not enrolled
        // yet", which is a different and untrue thing.
        enrollment.getEnrollmentStatus(),
        messaging.getDeviceInfo(),
      ]);

    // The one answer with no substitute — every branch below reads `status`.
    // The plugin answers this even when its store failed to open (it reports
    // §6.1 `faulted` with a code rather than refusing, #753), so a rejection
    // here means the IPC surface itself is unreachable and naming it is all
    // that is left to do.
    if (engineResult.status === "rejected") {
      if (superseded()) return;
      setFailure({
        call: "get_engine_status",
        detail: failureDetail(engineResult.reason),
      });
      return;
    }

    // The typed refusal is the enrollment gap. Anything else is a real failure
    // and is now rendered: it used to propagate out of `reconcile` and die in
    // the `void` at the call site, which is the permanent skeleton by a second
    // route.
    let enrollmentState: EnrollmentStatus | null = null;
    if (enrollmentResult.status === "rejected") {
      if (!isEnrollmentUnavailable(enrollmentResult.reason)) {
        if (superseded()) return;
        setFailure({
          call: "f2zmsg_enrollment_status",
          detail: failureDetail(enrollmentResult.reason),
        });
        return;
      }
    } else {
      enrollmentState = enrollmentResult.value;
    }

    // Supplementary. `not-enrolled` is this app's permanent answer and is
    // absorbed in silence, because the enrollment gap below already says what
    // it means, in words, and says it better. Anything else is worth naming
    // but must not take the screen down, since everything else on it works.
    const nextDegraded: CallFailure[] = [];
    let deviceInfo: DeviceInfo | null = null;
    if (deviceResult.status === "fulfilled") {
      deviceInfo = deviceResult.value;
    } else if (!isNotEnrolled(deviceResult.reason)) {
      nextDegraded.push({
        call: "get_device_info",
        detail: failureDetail(deviceResult.reason),
      });
    }

    let nextConversations: Conversation[] = [];
    if (enrollmentState?.enrolled) {
      try {
        nextConversations = (await messaging.listConversations()).conversations;
      } catch (cause) {
        nextDegraded.push({
          call: "list_conversations",
          detail: failureDetail(cause),
        });
      }
    }

    if (superseded()) return;

    setFailure(null);
    setDegraded(nextDegraded);
    setStatus(engineResult.value);
    setEnrolled(enrollmentState);
    setEnrollmentGap(enrollmentState === null);
    setDevice(deviceInfo);
    setConversations(nextConversations);
    setSelectedId(
      (current) =>
        nextConversations.some(
          (conversation) => conversation.conversationId === current,
        )
          ? current
          : (nextConversations[0]?.conversationId ?? null),
    );
  }, []);

  /**
   * The only way this screen starts a reconcile.
   *
   * A bare `void reconcile()` is what shipped #973, so every call site in this
   * file now goes through here. `reconcile` is written to end in a rendered
   * state on its own; this is the backstop for the day an edit makes it throw
   * anyway, and it costs three lines to make that unable to strand anyone.
   *
   * **The returned promise cannot reject**, which is what makes `void
   * refresh()` a safe thing to write at the call sites that do not need to
   * wait, and lets `run` await the re-read before it clears its spinner.
   *
   * The one remaining reference to `reconcile` itself is `FirstContact`'s
   * `onStateChanged`, which awaits it inside its own `try`/`catch` and has its
   * own rendered error for it. It stays on `reconcile` deliberately: handing it
   * a promise that never rejects would silently retire that branch.
   */
  const refresh = useCallback(
    (): Promise<void> =>
      reconcile().catch((cause: unknown) => {
        setFailure({ call: "reconcile", detail: failureDetail(cause) });
      }),
    [reconcile],
  );

  const selected =
    conversations?.find(
      (conversation) => conversation.conversationId === selectedId,
    ) ?? null;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Events may be coalesced and may be missed, so they are a signal to re-read
  // rather than a state feed (§5.2). Window focus is the other re-read point.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listenMessaging("f2zmsg://engine-state", (payload) => {
      setStatus(payload);
      if (isRunning(payload.state)) void refresh();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      // Losing the event subscription is survivable — focus still re-reads —
      // but it must not be invisible, and it must never reach the window as an
      // unhandled rejection. It gets its own state rather than joining
      // `degraded`, which every reconcile replaces: this failure happened once,
      // outside any reconcile, and stays true until the effect is torn down.
      .catch((cause: unknown) => {
        if (cancelled) return;
        setListenFailure({
          call: "listen f2zmsg://engine-state",
          detail: failureDetail(cause),
        });
      });

    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  /**
   * Run something the user asked for, then re-read.
   *
   * `call` is its wire name for the same reason `CallFailure` carries one. The
   * failure is kept out of the blocking state deliberately: a start that
   * refused should say so *next to* the screen the user is looking at, not
   * replace it — the surface was fine a moment ago and still is.
   */
  const run = useCallback(
    async (call: string, action: () => Promise<unknown>) => {
      setBusy(true);
      setActionFailure(null);
      try {
        await action();
      } catch (cause) {
        setActionFailure({ call, detail: failureDetail(cause) });
      } finally {
        // Even a failed action can have moved the engine, so the re-read is
        // unconditional, and it is awaited so the spinner outlasts it the way
        // it always did. `refresh` owns its own rejection, so this cannot
        // throw out of the `finally`.
        await refresh();
        setBusy(false);
      }
    },
    [refresh],
  );

  const selectConversation = useCallback((conversation: Conversation) => {
    setConversations((current) => {
      const withoutSelected = (current ?? []).filter(
        (candidate) => candidate.conversationId !== conversation.conversationId,
      );
      return [conversation, ...withoutSelected];
    });
    setSelectedId(conversation.conversationId);
  }, []);

  // Reconcile replaces `degraded` wholesale; the listen failure is outside that
  // cycle, so the two are joined only here, where they are rendered.
  const reads = listenFailure ? [...degraded, listenFailure] : degraded;

  // Before the skeleton, always. A screen that cannot read the engine has to
  // say which call refused and what it said — the outage is survivable, being
  // unable to name it is what made #973 a device-only mystery.
  if (failure) {
    return (
      <div className="animate-slide-up space-y-6" data-messages-failure>
        <PageHeader
          title="Messages"
          description="End-to-end encrypted messaging."
        />

        <Callout
          tone="destructive"
          icon={AlertTriangle}
          title="Messaging could not be read"
        >
          <p>
            The engine did not answer{" "}
            <span className="mono-id">{failure.call}</span>, so there is nothing
            here this screen can honestly show yet. Your conversations and your
            keys are untouched: this is a read that did not come back, not data
            that was lost.
          </p>
          <p className="mono-id mt-2 break-words">{failure.detail}</p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={refresh}
            aria-label="Read the messaging engine again"
          >
            <RotateCw className="size-4" aria-hidden />
            Try again
          </Button>
        </Callout>
      </div>
    );
  }

  if (!status || (!enrolled && !enrollmentGap)) {
    return (
      <div className="animate-slide-up space-y-6" data-messages-loading>
        <PageHeader
          title="Messages"
          description="End-to-end encrypted messaging."
        />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  // The enrollment gap (#904, #905). This app can run the engine, hold device
  // keys and render everything below — but it cannot claim a handle, because
  // claiming one means signing with a key derived from the wallet seed
  // (ARCHITECTURE.md §4.2). Rather than guess, it says so and stops: no claim
  // control, no conversation list, and nothing that could be read as enrolled.
  if (!enrolled) {
    return (
      <div className="animate-slide-up space-y-6">
        <PageHeader
          title="Messages"
          description="End-to-end encrypted messaging."
        />

        <DegradedReads failures={reads} />

        {device && <BrowserGuarantee device={device} />}

        <EngineSummary status={status} />

        <Callout
          tone="info"
          icon={Wallet}
          title="Enrollment happens in the wallet app"
        >
          Your messaging handle is published to the key transparency directory
          under a key derived from your wallet's recovery phrase, and this app
          never holds that phrase — which is exactly why it is safe to run your
          conversations here. Claiming a handle, and issuing this device its
          credential, is done in the wallet app. That handover is not built yet,
          so nothing here is enrolled and no conversation can start.
        </Callout>
      </div>
    );
  }

  const { eligibility } = enrolled;
  const candidate = eligibility.candidate;
  const running = isRunning(status.state);

  return (
    <div className="animate-slide-up space-y-6">
      <PageHeader
        title="Messages"
        description="End-to-end encrypted messaging."
        actions={
          enrolled.enrolled ? (
            <Button
              variant={running ? "outline" : "default"}
              disabled={busy}
              onClick={() =>
                void run(
                  running ? "stop_engine" : "start_engine",
                  running ? messaging.stopEngine : messaging.startEngine,
                )
              }
              aria-label={
                running
                  ? "Stop the messaging engine"
                  : "Start the messaging engine"
              }
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : running ? (
                <Power className="size-4" aria-hidden />
              ) : (
                <Play className="size-4" aria-hidden />
              )}
              {running ? "Stop" : "Start"}
            </Button>
          ) : null
        }
      />

      {actionFailure && (
        <Callout
          tone="destructive"
          icon={AlertTriangle}
          title="That did not go through"
        >
          <p>
            <span className="mono-id">{actionFailure.call}</span> was refused,
            and nothing about your conversations changed. What the engine said:
          </p>
          <p className="mono-id mt-2 break-words">{actionFailure.detail}</p>
        </Callout>
      )}

      <DegradedReads failures={reads} />

      {device && <BrowserGuarantee device={device} />}

      <EngineSummary status={status} />

      {/*
        §9 rule 5: never proceed silently below the witness threshold. On day
        one free2z runs the only relay and is therefore the only witness, so
        this is the normal state rather than an incident — the copy has to say
        what is and is not protected without overclaiming either way.
      */}
      {!status.witnessThresholdMet && (
        <Callout
          tone="warning"
          icon={ShieldAlert}
          title="The directory is not independently witnessed yet"
        >
          A log that is also its own only witness can present different answers
          to different people without leaving evidence. Existing conversations
          are unaffected, because their keys were checked when they were pinned.
          What is held back is resolving a new handle and accepting a key
          change. Comparing safety numbers with someone in person, or over a
          call you already trust, works regardless and is the strongest check
          available.
        </Callout>
      )}

      {!eligibility.eligible && eligibility.reason && (
        <Callout tone="info" icon={KeyRound} title="No messaging handle">
          {INELIGIBILITY_COPY[eligibility.reason]}
        </Callout>
      )}

      {eligibility.eligible && !enrolled.enrolled && candidate && (
        <div className="space-y-4 rounded-xl border border-border bg-card p-6">
          <div>
            <h2 className="font-medium text-foreground">Claim your handle</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Your handle is published to the key transparency directory so
              other people can find your keys. It is derived from your username.
            </p>
          </div>
          <p className="mono-id text-lg text-foreground">@{candidate}</p>
          <Button
            disabled={busy}
            onClick={() =>
              void run("f2zmsg_enroll", () => enrollment.enroll(candidate))
            }
            aria-label={`Claim the handle ${candidate}`}
          >
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Claim @{candidate}
          </Button>
        </div>
      )}

      {enrolled.enrolled && enrolled.mergedAtEpoch === null && (
        <Callout tone="info" icon={Loader2} title="Submitted, not yet active">
          The directory merges new entries at an epoch boundary, so your handle
          is not resolvable by other people until that happens. There is no
          deadline to show you here, and nothing to retry.
        </Callout>
      )}

      {enrolled.enrolled && enrolled.mergedAtEpoch !== null && (
        <FirstContact
          engineRunning={running}
          witnessThresholdMet={status.witnessThresholdMet}
          onConversation={selectConversation}
          onStateChanged={reconcile}
        />
      )}

      {conversations !== null && conversations.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
          <nav aria-label="Conversations" className="space-y-2">
            {conversations.map((conversation) => (
              <button
                key={conversation.conversationId}
                type="button"
                onClick={() => setSelectedId(conversation.conversationId)}
                aria-current={
                  conversation.conversationId === selectedId
                    ? "true"
                    : undefined
                }
                className={
                  conversation.conversationId === selectedId
                    ? "w-full rounded-xl border border-primary/50 bg-card p-3 text-start"
                    : "w-full rounded-xl border border-border bg-card p-3 text-start transition-colors hover:border-primary/50"
                }
              >
                <span className="mono-id block text-foreground">
                  @{conversation.peerHandle}
                </span>
                <span className="block text-sm text-muted-foreground">
                  {conversation.verification.state === "verified"
                    ? "Safety numbers verified"
                    : conversation.verification.state === "changed"
                      ? "Their key changed"
                      : "Not verified yet"}
                </span>
              </button>
            ))}
          </nav>

          {selected ? (
            <div className="min-h-[24rem] rounded-xl border border-border bg-card/40 p-4">
              <Transcript conversation={selected} />
            </div>
          ) : null}
        </div>
      )}

      {enrolled.enrolled && enrolled.mergedAtEpoch !== null && (
        <Callout tone="success" icon={ShieldCheck} title="Handle active">
          <span className="mono-id">@{enrolled.handle}</span> is published in
          the directory.
        </Callout>
      )}
    </div>
  );
}
