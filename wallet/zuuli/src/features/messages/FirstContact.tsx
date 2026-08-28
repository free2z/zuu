import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, Loader2, MessageCirclePlus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { messaging } from "@/lib/messaging/bridge";
import { listenMessaging } from "@/lib/messaging/events";
import {
  ErrorCodeSchema,
  HANDLE_PATTERN,
  type ContactRequest,
  type Conversation,
} from "@/lib/messaging/types";

interface FirstContactProps {
  engineRunning: boolean;
  witnessThresholdMet: boolean;
  onConversation: (conversation: Conversation) => void;
  onStateChanged: () => Promise<void>;
}

function refusalCode(error: unknown): string {
  const parsed = ErrorCodeSchema.safeParse(error);
  return parsed.success ? parsed.data : "internal";
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
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);

  const loadRequests = useCallback(async () => {
    try {
      setRequests(await messaging.listContactRequests());
    } catch (cause) {
      setError(refusalCode(cause));
    }
  }, []);

  const reconcileAfterSignal = useCallback(async () => {
    try {
      const [nextRequests] = await Promise.all([
        messaging.listContactRequests(),
        onStateChanged(),
      ]);
      setRequests(nextRequests);
    } catch (cause) {
      setError(refusalCode(cause));
    }
  }, [onStateChanged]);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  // Events are only signals. Their payloads are deliberately ignored and both
  // authoritative views are re-read (§5.2); appending either payload directly
  // would lose coalesced events and duplicate later reconciliation reads.
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const attach = (promise: Promise<() => void>) => {
      void promise.then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      });
    };

    const reread = () => void reconcileAfterSignal();
    attach(listenMessaging("f2zmsg://contact-request", reread));
    attach(listenMessaging("f2zmsg://conversation-updated", reread));

    const onFocus = () => void loadRequests();
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") void loadRequests();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
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
      setError(null);
      try {
        await action();
        await reconcileAfterSignal();
      } catch (cause) {
        setError(refusalCode(cause));
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

  return (
    <section className="space-y-4" aria-labelledby="first-contact-title">
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 id="first-contact-title" className="font-medium text-foreground">
            Start a conversation
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter an exact messaging handle. Establishing first contact computes
            proof of work on this device and can take several seconds.
          </p>
        </div>

        <form
          className="flex flex-col gap-2 sm:flex-row"
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

      {error ? (
        <Callout tone="destructive" title="First contact was refused" role="alert">
          Messaging error: <span className="mono-id">{error}</span>
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
                    Identity fingerprint
                  </p>
                  <p className="mono-id break-all text-sm text-foreground">
                    {request.peerIdentityFingerprint}
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
