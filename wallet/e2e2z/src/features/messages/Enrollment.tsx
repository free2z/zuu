// "Enroll with ZUULI" (#1022, workstream 5).
//
// This app never holds the wallet seed, so it cannot sign for a handle itself.
// ZUULI can. The flow sends ZUULI an `issue-device-credential` request over
// the verified App Link (#1019), waits while the person confirms in ZUULI,
// installs the credential that comes back, and hands control back to the
// screen, which re-reads the engine.
//
// Every state below is something the person can act on. None of them claims
// more than the engine said: the screen only shows "enrolled" after
// `e2e2z_enrollment_status` reports it.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
  Clock,
  KeyRound,
  Loader2,
  ShieldAlert,
  Smartphone,
  Wallet,
  X,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import { Callout, type CalloutTone } from "../../components/ui/callout";
import { Input } from "../../components/ui/input";
import {
  enrollment,
  enrollmentTransport,
  messaging,
} from "../../lib/messaging/bridge";
import { REQUEST_LIFETIME_MS } from "../../lib/enrollment/lifetime";
import {
  classifyEnrollmentFailure,
  type EnrollmentFailure,
} from "../../lib/enrollment/outcome";
import type {
  EnrollmentStatus,
  HandleEligibility,
  IneligibilityReason,
} from "../../lib/messaging/types";

const INELIGIBILITY_COPY: Record<IneligibilityReason, string> = {
  punctuation:
    "A messaging handle can only use the letters a to z, the digits 0 to 9 and the underscore.",
  "non-ascii":
    "A messaging handle can only use the letters a to z, the digits 0 to 9 and the underscore.",
  "too-long": "A messaging handle can be at most 30 characters long.",
  "not-signed-in": "Enter your free2z username.",
};

const LIFETIME_MINUTES = Math.round(REQUEST_LIFETIME_MS / 60_000);

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "waiting"; readonly handle: string; readonly deadline: number }
  | {
      readonly kind: "failed";
      readonly handle: string;
      readonly failure: EnrollmentFailure;
    };

interface FailureCopy {
  readonly tone: CalloutTone;
  readonly title: string;
  readonly body: string;
  /** Whether "ZUULI may not be installed" is a likely explanation. */
  readonly maybeMissing?: boolean;
  /** Whether to show the detail line for a bug report. */
  readonly showDetail?: boolean;
}

function failureCopy(failure: EnrollmentFailure, handle: string): FailureCopy {
  switch (failure.kind) {
    case "unavailable":
      return {
        tone: "info",
        title: "Enrollment happens in the wallet app",
        body: "This build of e2e2z can't reach ZUULI. Enrolling works on iPhone and Android.",
      };
    case "busy":
      return {
        tone: "warning",
        title: "A request is already waiting for ZUULI",
        body: "Confirm or decline it in ZUULI, or cancel it here, then try again.",
      };
    case "cancelled":
      return {
        tone: "info",
        title: "Enrollment cancelled",
        body: "Nothing was installed on this device. If you had already confirmed in ZUULI, that approval won't be used. Enroll again whenever you're ready.",
      };
    case "expired":
      return {
        tone: "warning",
        title: "The request expired",
        body: `ZUULI didn't answer within ${LIFETIME_MINUTES} minutes, so the request can't be used any more. Nothing was installed. Try again, and confirm in ZUULI when it opens.`,
        maybeMissing: true,
      };
    case "declined":
      return {
        tone: "info",
        title: "You declined in ZUULI",
        body: "ZUULI didn't issue anything, and nothing changed on this device. If that was a mistake, try again.",
      };
    case "wallet-not-ready":
      return {
        tone: "warning",
        title: "ZUULI couldn't vouch for this device",
        body: "Open ZUULI, make sure your wallet is set up and unlocked, then try again.",
      };
    case "not-registered":
      return {
        tone: "destructive",
        title: "ZUULI doesn't recognize e2e2z",
        body: "This version of ZUULI doesn't list e2e2z as an app it answers. Update both apps, then try again.",
      };
    case "link-failed":
      return {
        tone: "warning",
        title: "ZUULI didn't open",
        body: "This device couldn't open ZUULI's link, so no request was sent.",
        maybeMissing: true,
        showDetail: true,
      };
    case "handle-unavailable":
      return {
        tone: "warning",
        title: `ZUULI couldn't confirm @${handle} is yours`,
        body: `ZUULI publishes this device under the handle of the free2z account signed in there. Open ZUULI, sign in to free2z as @${handle}, claim your messaging handle if you haven't yet, then try again. Nothing was published and nothing was installed.`,
      };
    case "no-relay":
      return {
        tone: "warning",
        title: "This build has no messaging service",
        body: "e2e2z opens a mailbox at a relay before it enrolls, so other people can reach this device. This build has no relay configured, so there is nothing to enroll into yet.",
        showDetail: true,
      };
    case "handle-mismatch":
      return {
        tone: "destructive",
        title: "ZUULI signed a different handle",
        body: `This device asked for @${handle}, but the credential that came back is for another handle. It was refused, and nothing was installed. Try again, and check that ZUULI shows @${handle} before you confirm.`,
      };
    case "durability":
      return {
        tone: "destructive",
        title: "This device can't keep messaging keys safely",
        body: "Its secure storage isn't available, so e2e2z won't enroll: a device that can't keep its key would lose access to your messages. Make sure this device has a passcode set, then try again.",
        showDetail: true,
      };
    case "unknown-outcome":
      return {
        tone: "warning",
        title: "ZUULI's answer couldn't be read",
        body: "ZUULI replied with a status this version of e2e2z doesn't understand, so nothing was installed. Update e2e2z, then try again.",
        showDetail: true,
      };
    case "defect":
      return {
        tone: "destructive",
        title: "Enrollment stopped",
        body: "Something unexpected went wrong, and nothing was installed. If it happens again, please report the detail below.",
        showDetail: true,
      };
  }
}

/** Why a web page may have opened instead of ZUULI. */
function ZuuliMissingHint() {
  return (
    <p className="text-sm text-muted-foreground" data-zuuli-missing-hint>
      Did a web page open instead of ZUULI? Then ZUULI isn't installed on this
      device. Install ZUULI from the same TestFlight or Google Play test you
      got e2e2z from, set up your wallet, then come back and try again.
    </p>
  );
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The standing state for a build that cannot reach ZUULI at all. */
export function EnrollmentUnavailable() {
  return (
    <Callout
      tone="info"
      icon={Wallet}
      title="Enrollment happens in the wallet app"
      data-enrollment-unavailable
    >
      <p>
        Your messaging handle is vouched for by ZUULI, the wallet app that
        holds your recovery phrase, which is exactly why this app never needs
        it. Enrolling with ZUULI works in e2e2z on iPhone and Android, where the
        two apps can pass requests to each other securely. This build can't,
        so nothing here is enrolled and no conversation can start.
      </p>
    </Callout>
  );
}

interface EnrollmentProps {
  /** Called once the engine reports the installed credential. */
  readonly onEnrolled: (status: EnrollmentStatus) => Promise<void>;
}

export function Enrollment({ onEnrolled }: EnrollmentProps) {
  const available = enrollmentTransport.canEnroll();
  const [username, setUsername] = useState("");
  const [eligibility, setEligibility] = useState<HandleEligibility | null>(
    null,
  );
  const [eligibilityError, setEligibilityError] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const checkGeneration = useRef(0);
  const inFlight = useRef(false);

  // The engine's own eligibility rule, not a copy of it. A candidate that is
  // eligible here is still only a request: the directory decides whether the
  // handle belongs to this person's free2z account.
  useEffect(() => {
    const generation = ++checkGeneration.current;
    if (username === "") {
      setEligibility(null);
      setEligibilityError(false);
      return;
    }
    messaging
      .checkHandleEligibility(username)
      .then((result) => {
        if (generation !== checkGeneration.current) return;
        setEligibility(result);
        setEligibilityError(false);
      })
      .catch(() => {
        if (generation !== checkGeneration.current) return;
        setEligibility(null);
        setEligibilityError(true);
      });
  }, [username]);

  const waiting = phase.kind === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  const candidate =
    eligibility?.eligible && eligibility.candidate ? eligibility.candidate : null;

  const enroll = useCallback(async () => {
    if (!candidate || inFlight.current) return;
    inFlight.current = true;
    const startedAt = Date.now();
    setNow(startedAt);
    setPhase({
      kind: "waiting",
      handle: candidate,
      deadline: startedAt + REQUEST_LIFETIME_MS,
    });
    try {
      const status = await enrollment.enroll(candidate);
      if (!status.enrolled) {
        setPhase({
          kind: "failed",
          handle: candidate,
          failure: {
            kind: "defect",
            detail: status.blocked ?? "the engine did not report an enrollment",
          },
        });
        return;
      }
      setPhase({ kind: "idle" });
      await onEnrolled(status);
    } catch (cause) {
      setPhase({
        kind: "failed",
        handle: candidate,
        failure: classifyEnrollmentFailure(cause),
      });
    } finally {
      inFlight.current = false;
    }
  }, [candidate, onEnrolled]);

  const cancel = useCallback(() => {
    enrollmentTransport.cancelEnroll();
  }, []);

  if (!available) return <EnrollmentUnavailable />;

  if (phase.kind === "waiting") {
    return (
      <section
        className="space-y-4 rounded-xl border border-border bg-card p-5"
        aria-labelledby="enrollment-title"
        data-enrollment-waiting
      >
        <div className="flex items-start gap-3">
          <Loader2
            className="mt-0.5 size-5 shrink-0 animate-spin text-primary"
            aria-hidden
          />
          <div className="min-w-0 space-y-1" role="status" aria-live="polite">
            <h2 id="enrollment-title" className="font-medium text-foreground">
              Waiting for ZUULI
            </h2>
            <p className="text-sm text-muted-foreground">
              Confirm in ZUULI that this device may send and receive messages
              as <span className="mono-id text-foreground">@{phase.handle}</span>.
              You'll come back here on your own when you're done.
            </p>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Clock className="size-4 shrink-0" aria-hidden />
              <span>
                This request expires in{" "}
                <span className="bidi-number numeral text-foreground">
                  {formatRemaining(phase.deadline - now)}
                </span>
                .
              </span>
            </p>
          </div>
        </div>
        <ZuuliMissingHint />
        <Button variant="outline" onClick={cancel}>
          <X className="size-4" aria-hidden />
          Cancel
        </Button>
      </section>
    );
  }

  const failed = phase.kind === "failed" ? phase : null;
  const copy = failed ? failureCopy(failed.failure, failed.handle) : null;
  const inputInvalid =
    username.length > 0 && eligibility !== null && !eligibility.eligible;

  return (
    <section
      className="space-y-5 rounded-xl border border-border bg-card p-5"
      aria-labelledby="enrollment-title"
      data-enrollment
    >
      <div className="space-y-2">
        <h2 id="enrollment-title" className="font-medium text-foreground">
          Set up messaging on this device
        </h2>
        <p className="text-sm text-muted-foreground">
          e2e2z never holds your wallet's recovery phrase. Instead, ZUULI, your
          wallet app, vouches for this device: it signs a credential that lets
          this device send and receive messages under your handle. Nothing is
          issued until you confirm in ZUULI.
        </p>
        <ol className="list-decimal space-y-1 ps-5 text-sm text-muted-foreground">
          <li>Enter your free2z username.</li>
          <li>Tap Enroll with ZUULI. ZUULI opens and asks you to confirm.</li>
          <li>Confirm, and you'll come back here.</li>
        </ol>
      </div>

      {failed && copy ? (
        <Callout
          tone={copy.tone}
          icon={
            failed.failure.kind === "declined"
              ? Ban
              : failed.failure.kind === "handle-unavailable"
                ? KeyRound
                : failed.failure.kind === "durability"
                ? ShieldAlert
                : failed.failure.kind === "cancelled"
                  ? X
                  : failed.failure.kind === "expired"
                    ? Clock
                    : failed.failure.kind === "link-failed"
                      ? Smartphone
                      : AlertTriangle
          }
          title={copy.title}
          role="alert"
          data-enrollment-failure={failed.failure.kind}
        >
          <p>{copy.body}</p>
          {copy.maybeMissing ? <ZuuliMissingHint /> : null}
          {copy.showDetail ? (
            <p className="mono-id break-words text-xs text-muted-foreground">
              {failed.failure.detail}
            </p>
          ) : null}
        </Callout>
      ) : null}

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void enroll();
        }}
      >
        <div className="space-y-1.5">
          <label
            htmlFor="enrollment-username"
            className="text-sm font-medium text-foreground"
          >
            Your free2z username
          </label>
          <Input
            id="enrollment-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="alice_123"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            spellCheck={false}
            aria-invalid={inputInvalid}
            aria-describedby="enrollment-handle-note"
          />
        </div>

        <div id="enrollment-handle-note" className="space-y-1 text-sm">
          {candidate ? (
            <p className="text-foreground">
              Handle to request:{" "}
              <span className="mono-id" data-enrollment-candidate>
                @{candidate}
              </span>
            </p>
          ) : null}
          {inputInvalid && eligibility?.reason ? (
            <p className="text-destructive" role="alert">
              {INELIGIBILITY_COPY[eligibility.reason]}
            </p>
          ) : null}
          {eligibilityError ? (
            <p className="text-destructive" role="alert">
              This device couldn't check that username. Try again.
            </p>
          ) : null}
          <p className="flex items-start gap-1.5 text-muted-foreground">
            <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Your handle is your username in lowercase. It becomes yours for
              messaging once free2z's directory confirms it belongs to your
              account, so enter the username you sign in to free2z with.
            </span>
          </p>
        </div>

        <Button type="submit" disabled={!candidate}>
          <Wallet className="size-4" aria-hidden />
          {failed ? "Try again with ZUULI" : "Enroll with ZUULI"}
        </Button>
      </form>
    </section>
  );
}
