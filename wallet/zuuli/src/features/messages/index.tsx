// Encrypted messages — mounted at /messages/*.
//
// This slice covers enrollment and engine lifecycle only; the conversation
// surface arrives with the rest of the command set.

import { useCallback, useEffect, useState } from "react";
import {
  KeyRound,
  Loader2,
  Play,
  Power,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { PageHeader } from "@/components/common/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Skeleton } from "@/components/ui/skeleton";
import { enrollment, messaging } from "@/lib/messaging/bridge";
import { listenMessaging } from "@/lib/messaging/events";
import type {
  Conversation,
  DeviceInfo,
  EngineState,
  EngineStatus,
  EnrollmentStatus,
  IneligibilityReason,
} from "@/lib/messaging/types";
import { BrowserGuarantee } from "./BrowserGuarantee";
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
        <dd className="numeral mt-1 text-foreground">
          {status.relaysConnected} of {status.relaysConfigured}
        </dd>
        <dd className="mt-1 text-sm text-muted-foreground">
          Connected relays out of those configured.
        </dd>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <dt className="eyebrow text-muted-foreground">Witnesses</dt>
        <dd className="numeral mt-1 text-foreground">
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

  const reconcile = useCallback(async () => {
    const [engine, enrollmentState, deviceInfo] = await Promise.all([
      messaging.getEngineStatus(),
      enrollment.getEnrollmentStatus(),
      messaging.getDeviceInfo(),
    ]);
    setStatus(engine);
    setEnrolled(enrollmentState);
    setDevice(deviceInfo);

    if (!enrollmentState.enrolled) {
      setConversations([]);
      return;
    }
    const page = await messaging.listConversations();
    setConversations(page.conversations);
    setSelectedId(
      (current) => current ?? page.conversations[0]?.conversationId ?? null,
    );
  }, []);

  const selected =
    conversations?.find(
      (conversation) => conversation.conversationId === selectedId,
    ) ?? null;

  useEffect(() => {
    void reconcile();
  }, [reconcile]);

  // Events may be coalesced and may be missed, so they are a signal to re-read
  // rather than a state feed (§5.2). Window focus is the other re-read point.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listenMessaging("f2zmsg://engine-state", (payload) => {
      setStatus(payload);
      if (isRunning(payload.state)) void reconcile();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    const onFocus = () => void reconcile();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [reconcile]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
        await reconcile();
      } finally {
        setBusy(false);
      }
    },
    [reconcile],
  );

  if (!status || !enrolled) {
    return (
      <div className="animate-slide-up space-y-6">
        <PageHeader
          title="Messages"
          description="End-to-end encrypted messaging."
        />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const { eligibility } = enrolled;
  const candidate = eligibility.candidate;

  return (
    <div className="animate-slide-up space-y-6">
      <PageHeader
        title="Messages"
        description="End-to-end encrypted messaging."
        actions={
          enrolled.enrolled ? (
            <Button
              variant={isRunning(status.state) ? "outline" : "default"}
              disabled={busy}
              onClick={() =>
                void run(
                  isRunning(status.state)
                    ? messaging.stopEngine
                    : messaging.startEngine,
                )
              }
              aria-label={
                isRunning(status.state)
                  ? "Stop the messaging engine"
                  : "Start the messaging engine"
              }
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : isRunning(status.state) ? (
                <Power className="size-4" aria-hidden />
              ) : (
                <Play className="size-4" aria-hidden />
              )}
              {isRunning(status.state) ? "Stop" : "Start"}
            </Button>
          ) : null
        }
      />

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
            onClick={() => void run(() => enrollment.enroll(candidate))}
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
                    ? "w-full rounded-xl border border-primary/50 bg-card p-3 text-left"
                    : "w-full rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/50"
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
