import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, Loader2, MessageCirclePlus, UserPlus } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Callout } from "../../components/ui/callout";
import { Input } from "../../components/ui/input";
import { messaging } from "../../lib/messaging/bridge";
import { listenMessaging } from "../../lib/messaging/events";
import {
  ErrorCodeSchema,
  HANDLE_PATTERN,
  type ContactRequest,
  type Conversation,
  type ErrorCode,
} from "../../lib/messaging/types";

interface FirstContactProps {
  engineRunning: boolean;
  witnessThresholdMet: boolean;
  onConversation: (conversation: Conversation) => void;
  onStateChanged: () => Promise<void>;
}

function refusalCode(error: unknown): ErrorCode {
  const parsed = ErrorCodeSchema.safeParse(error);
  return parsed.success ? parsed.data : "internal";
}

function errorPresentation(code: ErrorCode): {
  title: string;
  body: string;
  tone: "warning" | "destructive";
} {
  if (code === "directory-proof-invalid") {
    return {
      title: "Directory proof failed",
      body:
        "Cryptographic verification failed. First contact stopped; do not retry through another directory. Review the security alarms before proceeding.",
      tone: "destructive",
    };
  }
  if (code === "witness-threshold-unmet") {
    return {
      title: "Independent witness threshold not met",
      body:
        "First contact remains blocked. You can compare safety numbers over a channel you already trust; existing conversations continue.",
      tone: "warning",
    };
  }
  if (
    code === "directory-protocol-violation" ||
    code === "relay-protocol-violation" ||
    code === "internal"
  ) {
    return {
      title: "Messaging defect",
      body:
        "ZUULI or a service returned an invalid result. Update ZUULI and report this error code; do not retry it automatically.",
      tone: "destructive",
    };
  }
  if (code === "directory-unreachable") {
    return {
      title: "First contact can be retried",
      body:
        "The directory could not be reached. Existing conversations are unaffected; try first contact again after connectivity returns.",
      tone: "warning",
    };
  }
  if (
    code === "directory-rate-limited" ||
    code === "directory-version-conflict" ||
    code === "relay-unreachable" ||
    code === "relay-rate-limited" ||
    code === "relay-backpressure" ||
    code === "send-unavailable" ||
    code === "pow-required" ||
    code === "pow-failed"
  ) {
    return {
      title: "First contact can be retried",
      body:
        "The temporary attempt did not complete. Wait before trying again; established conversations are unaffected.",
      tone: "warning",
    };
  }
  if (code === "engine-not-running") {
    return {
      title: "Messaging engine stopped",
      body: "Start the messaging engine, then try first contact once more.",
      tone: "warning",
    };
  }
  return {
    title: "First contact stopped",
    body:
      "ZUULI did not establish or accept this contact. Resolve the condition named by the error code before trying again.",
    tone: "destructive",
  };
}

function formatClaimedIdentityKey(value: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value)) return "Invalid key encoding";
  return value.toUpperCase().match(/.{1,5}/g)?.join(" ") ?? value;
}

/**
 * The first-contact surface from CLIENT-CONTRACT.md §3.3.
 *
 * Handles are passed byte-for-byte. In particular, this component never trims,
 * case-folds, normalizes, or strips an `@`: the directory's exact ASCII
 * predicate is the security boundary, not a suggestion for presentation.
 */
export function FirstContact({
  engineRunning,
  witnessThresholdMet,
  onConversation,
  onStateChanged,
}: FirstContactProps) {
  const [handle, setHandle] = useState("");
  const [requests, setRequests] = useState<ContactRequest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ErrorCode | null>(null);
  const [requestLoadError, setRequestLoadError] = useState<ErrorCode | null>(
    null,
  );
  const [conversationLoadError, setConversationLoadError] =
    useState<ErrorCode | null>(null);
  const busyRef = useRef<string | null>(null);
  const requestReadGeneration = useRef(0);
  const conversationReadGeneration = useRef(0);

  const loadRequests = useCallback(async () => {
    const generation = ++requestReadGeneration.current;
    try {
      const next = await messaging.listContactRequests();
      if (generation !== requestReadGeneration.current) return;
      setRequests(next);
      setRequestLoadError(null);
    } catch (cause) {
      if (generation !== requestReadGeneration.current) return;
      setRequestLoadError(refusalCode(cause));
    }
  }, []);

  const loadConversations = useCallback(async () => {
    const generation = ++conversationReadGeneration.current;
    try {
      await onStateChanged();
      if (generation !== conversationReadGeneration.current) return;
      setConversationLoadError(null);
    } catch (cause) {
      if (generation !== conversationReadGeneration.current) return;
      setConversationLoadError(refusalCode(cause));
    }
  }, [onStateChanged]);

  const reconcileAfterSignal = useCallback(async () => {
    await Promise.all([loadRequests(), loadConversations()]);
  }, [loadConversations, loadRequests]);

  // Events are only signals. Their payloads are deliberately ignored and both
  // authoritative views are re-read (§5.2); appending either payload directly
  // would lose coalesced events and duplicate later reconciliation reads.
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const reread = () => void reconcileAfterSignal();
    void Promise.all([
      listenMessaging("f2zmsg://contact-request", reread),
      listenMessaging("f2zmsg://conversation-updated", reread),
    ])
      .then((attached) => {
        if (disposed) {
          for (const unlisten of attached) unlisten();
          return;
        }
        unlisteners.push(...attached);
        // The read starts only after both subscriptions exist. Anything that
        // landed during async attachment is therefore included here.
        void reconcileAfterSignal();
      })
      .catch((cause) => {
        if (!disposed) setConversationLoadError(refusalCode(cause));
      });

    const onFocus = () => void loadRequests();
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") void loadRequests();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      requestReadGeneration.current += 1;
      conversationReadGeneration.current += 1;
      for (const unlisten of unlisteners) unlisten();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadRequests, reconcileAfterSignal]);

  const canEstablish = engineRunning && witnessThresholdMet;
  const validHandle = HANDLE_PATTERN.test(handle);

  const run = useCallback(
    async (key: string, action: () => Promise<void>) => {
      if (busyRef.current !== null) return;
      busyRef.current = key;
      setBusy(key);
      setActionError(null);
      try {
        await action();
        await reconcileAfterSignal();
      } catch (cause) {
        setActionError(refusalCode(cause));
      } finally {
        busyRef.current = null;
        setBusy(null);
      }
    },
    [reconcileAfterSignal],
  );

  const start = useCallback(async () => {
    // Repeat both gates at the action boundary. Disabled controls are UX, not
    // authority, and a stale event must not let a click proceed silently.
    if (!canEstablish || !validHandle) return;
    await run("start", async () => {
      const conversation = await messaging.startConversation(handle);
      onConversation(conversation);
      setHandle("");
    });
  }, [canEstablish, handle, onConversation, run, validHandle]);

  const accept = useCallback(
    async (requestId: string) => {
      if (!canEstablish) return;
      await run(`accept:${requestId}`, async () => {
        onConversation(await messaging.acceptContactRequest(requestId));
      });
    },
    [canEstablish, onConversation, run],
  );

  const reject = useCallback(
    async (requestId: string, block: boolean) => {
      await run(`${block ? "block" : "reject"}:${requestId}`, () =>
        messaging.rejectContactRequest(requestId, block),
      );
    },
    [run],
  );

  const error = actionError ?? conversationLoadError ?? requestLoadError;
  const presentedError = error ? errorPresentation(error) : null;

  return (
    <section className="space-y-4" aria-labelledby="first-contact-title">
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 id="first-contact-title" className="font-medium text-foreground">
            Start a conversation
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter an exact messaging handle. Establishing first contact computes
            bounded proof of work on this device; its duration varies by device.
          </p>
        </div>

        <form
          className="flex flex-col gap-2 sm:flex-row"
          aria-busy={busy === "start"}
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <label className="sr-only" htmlFor="first-contact-handle">
            Messaging handle
          </label>
          <Input
            id="first-contact-handle"
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            placeholder="alice_123"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={handle.length > 0 && !validHandle}
          />
          <Button
            type="submit"
            disabled={!canEstablish || !validHandle || busy !== null}
          >
            {busy === "start" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <MessageCirclePlus className="size-4" aria-hidden />
            )}
            {busy === "start" ? "Computing on this device…" : "Start chat"}
          </Button>
        </form>

        {busy === "start" ? (
          <p
            className="mt-2 text-sm text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            Computing proof of work on this device within a bounded work policy.
            Duration varies by device.
          </p>
        ) : null}

        {handle.length > 0 && !validHandle ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            Use 1–30 lowercase letters, numbers, or underscores, without an @.
          </p>
        ) : null}

        {!engineRunning ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Start the messaging engine before establishing first contact.
          </p>
        ) : !witnessThresholdMet ? (
          <p className="mt-2 text-sm text-muted-foreground">
            First contact is unavailable until the independent witness threshold
            is met. Existing conversations remain available.
          </p>
        ) : null}
      </div>

      {error && presentedError ? (
        <Callout
          tone={presentedError.tone}
          title={presentedError.title}
          role="alert"
        >
          {presentedError.body} Error code:{" "}
          <span className="mono-id">{error}</span>
        </Callout>
      ) : null}

      {requests && requests.length > 0 ? (
        <div className="space-y-3">
          <h2 className="font-medium text-foreground">Contact requests</h2>
          <ul className="space-y-3">
            {requests.map((request) => {
              const requestBusy = busy?.endsWith(`:${request.requestId}`) ?? false;
              return (
                <li
                  key={request.requestId}
                  className="rounded-xl border border-border bg-card p-4"
                >
                  <p className="mono-id font-medium text-foreground">
                    @{request.peerHandle}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Unverified identity key claimed by this request
                  </p>
                  <p className="mono-id break-all text-sm text-foreground">
                    {formatClaimedIdentityKey(request.peerIdentityFingerprint)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Directory confirmation happens only if you accept. Compare
                    safety numbers afterward over a channel you already trust.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      disabled={!canEstablish || busy !== null}
                      onClick={() => void accept(request.requestId)}
                    >
                      {requestBusy && busy?.startsWith("accept:") ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                      ) : (
                        <UserPlus className="size-4" aria-hidden />
                      )}
                      Accept
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void reject(request.requestId, false)}
                    >
                      Reject
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void reject(request.requestId, true)}
                    >
                      <Ban className="size-4" aria-hidden />
                      Block on this device
                    </Button>
                  </div>
                  {!witnessThresholdMet ? (
                    <p className="mt-3 text-sm text-muted-foreground">
                      Acceptance waits for the independent witness threshold;
                      rejecting or blocking locally is still available.
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
