import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  RealtimeKitProvider,
  useRealtimeKitClient,
} from "@cloudflare/realtimekit-react";
import { RtkMeeting } from "@cloudflare/realtimekit-react-ui";
import { Button } from "@/components/ui/button";
import { MESSAGE_KEYS } from "@/i18n/messages";
import type { DyteJoinTicket } from "@/lib/api/types";
import {
  classifyLiveFailure,
  safeLiveDiagnostic,
  type LiveConnectionFailure,
} from "./connection-failure";

type StageStatus = "connecting" | "connected" | "failed" | "ended";

function FailureMessage({
  messageKey,
}: Pick<LiveConnectionFailure, "messageKey">) {
  const { t } = useTranslation();
  switch (messageKey) {
    case MESSAGE_KEYS.liveFailurePolicy:
      return <>{t(MESSAGE_KEYS.liveFailurePolicy)}</>;
    case MESSAGE_KEYS.liveFailureOffline:
      return <>{t(MESSAGE_KEYS.liveFailureOffline)}</>;
    case MESSAGE_KEYS.liveFailureTransport:
      return <>{t(MESSAGE_KEYS.liveFailureTransport)}</>;
    case MESSAGE_KEYS.liveFailureTimeout:
      return <>{t(MESSAGE_KEYS.liveFailureTimeout)}</>;
    case MESSAGE_KEYS.liveFailureMalformedTicket:
      return <>{t(MESSAGE_KEYS.liveFailureMalformedTicket)}</>;
    case MESSAGE_KEYS.liveFailureExpiredTicket:
      return <>{t(MESSAGE_KEYS.liveFailureExpiredTicket)}</>;
    case MESSAGE_KEYS.liveFailureReplayedTicket:
      return <>{t(MESSAGE_KEYS.liveFailureReplayedTicket)}</>;
    case MESSAGE_KEYS.liveFailureTokenRejected:
      return <>{t(MESSAGE_KEYS.liveFailureTokenRejected)}</>;
    case MESSAGE_KEYS.liveFailureEndedRoom:
      return <>{t(MESSAGE_KEYS.liveFailureEndedRoom)}</>;
    case MESSAGE_KEYS.liveFailureLifecycleRace:
      return <>{t(MESSAGE_KEYS.liveFailureLifecycleRace)}</>;
    case MESSAGE_KEYS.liveFailureUnknown:
      return <>{t(MESSAGE_KEYS.liveFailureUnknown)}</>;
    default:
      return <>{t(messageKey)}</>;
  }
}

/**
 * Mounts the real Cloudflare RealtimeKit meeting for a join ticket returned by
 * `live.start` / `live.join`. Mirrors the web app's reference implementation
 * (`tuzi/ts/svelte/free2z`'s `rtk-manager.ts` + `<rtk-meeting>`): the auth
 * token goes straight into `RealtimeKitClient.init`, and the full
 * `mode="fill"` meeting UI — self + participant tiles, mic/cam/leave
 * controls, and chat — is rendered as-is. No custom media plumbing needed;
 * RealtimeKit owns the whole stage.
 */
export function Stage({
  ticket,
  refreshTicket,
  onTicketRefreshed,
}: {
  ticket: DyteJoinTicket;
  refreshTicket?: (previous: DyteJoinTicket) => Promise<DyteJoinTicket>;
  onTicketRefreshed?: (fresh: DyteJoinTicket) => void;
}) {
  const { t } = useTranslation();
  const [meeting, initMeeting] = useRealtimeKitClient();
  const [status, setStatus] = useState<StageStatus>("connecting");
  const [failure, setFailure] = useState<LiveConnectionFailure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [hostAttempt, setHostAttempt] = useState(0);
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );

  useEffect(() => {
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("connecting");
    setFailure(null);

    initMeeting({
      authToken: ticket.authToken,
      defaults: {
        // Hosts publish immediately; viewers join with mic/cam off.
        audio: ticket.as === "host",
        video: ticket.as === "host",
      },
    })
      .then((client) => {
        if (cancelled || client) return;
        // A falsy resolution (no thrown error) still means we never got a
        // connected client — surface it rather than rendering a blank stage.
        const classified = classifyLiveFailure(
          new Error("RealtimeKit returned no client"),
          "sdk-init",
        );
        console.warn("RealtimeKit connection failed", safeLiveDiagnostic(classified));
        setFailure(classified);
        setStatus("failed");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const classified = classifyLiveFailure(err, "sdk-init");
        // Never log the raw SDK error: provider errors can echo credentials or
        // private endpoints. The allowlisted boundary/category is sufficient.
        console.warn("RealtimeKit connection failed", safeLiveDiagnostic(classified));
        setFailure(classified);
        setStatus("failed");
      });

    return () => {
      cancelled = true;
    };
  }, [ticket.authToken, ticket.as, hostAttempt, initMeeting]);

  useEffect(() => {
    if (!meeting) return;

    const onJoined = () => {
      setFailure(null);
      setStatus("connected");
    };
    const onLeft = ({ state }: { state: string }) => {
      if (state === "ended") {
        setFailure(null);
        setStatus("ended");
      } else if (state === "failed") {
        const classified = classifyLiveFailure(
          new TypeError("room transport failed"),
          "room-session",
        );
        console.warn("RealtimeKit connection failed", safeLiveDiagnostic(classified));
        setFailure(classified);
        setStatus("failed");
      }
    };

    meeting.self.on("roomJoined", onJoined);
    meeting.self.on("roomLeft", onLeft);

    return () => {
      meeting.self.off("roomJoined", onJoined);
      meeting.self.off("roomLeft", onLeft);
    };
  }, [meeting]);

  async function retryWithFreshTicket() {
    if (
      ticket.as !== "participant" ||
      !refreshTicket ||
      !onTicketRefreshed ||
      refreshing
    ) {
      return;
    }
    setRefreshing(true);
    setFailure(null);
    setStatus("connecting");
    try {
      const fresh = await refreshTicket(ticket);
      onTicketRefreshed(fresh);
    } catch (error) {
      const classified = classifyLiveFailure(error, "ticket-refresh");
      console.warn("RealtimeKit connection failed", safeLiveDiagnostic(classified));
      setFailure(classified);
      setStatus("failed");
    } finally {
      setRefreshing(false);
    }
  }

  function reconnectHost() {
    if (ticket.as !== "host") return;
    // A host retry is deliberately local: reinitialize the SDK with the
    // existing host ticket. Never call the overloaded start/join route here;
    // doing so could mutate or duplicate the creator's live room.
    setFailure(null);
    setStatus("connecting");
    setHostAttempt((attempt) => attempt + 1);
  }

  const participantCanRefresh =
    ticket.as === "participant" && refreshTicket && onTicketRefreshed;
  const canRetry =
    failure?.retryable && (ticket.as === "host" || participantCanRefresh);

  if (failure) {
    return (
      <div className="absolute inset-0 grid place-items-center px-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-full bg-destructive/20 ring-2 ring-destructive/40">
            <AlertCircle className="h-7 w-7 text-destructive-foreground" aria-hidden />
          </div>
          <p className="max-w-xs text-sm text-white/80">
            <FailureMessage messageKey={failure.messageKey} />
          </p>
          {failure.retryable && ticket.as === "host" ? (
            <p className="max-w-xs text-xs text-white/70">
              {t(MESSAGE_KEYS.liveStageHostRecoveryHint)}
            </p>
          ) : null}
          {canRetry ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-1 border-white/20 bg-white/5 text-white hover:bg-white/10"
              disabled={refreshing || !online}
              onClick={() => {
                if (ticket.as === "host") reconnectHost();
                else void retryWithFreshTicket();
              }}
            >
              {refreshing
                ? t(MESSAGE_KEYS.liveStageRefreshingTicket)
                : !online
                  ? t(MESSAGE_KEYS.liveStageWaitingForConnection)
                  : ticket.as === "host"
                    ? t(MESSAGE_KEYS.liveStageReconnect)
                    : t(MESSAGE_KEYS.liveStageTryAgain)}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (status === "ended") {
    return (
      <div className="absolute inset-0 grid place-items-center px-6">
        <p className="text-sm text-white/80">
          {t(MESSAGE_KEYS.liveStageEnded)}
        </p>
      </div>
    );
  }

  if (!meeting) {
    return (
      <div className="absolute inset-0 grid place-items-center">
        <div className="flex flex-col items-center gap-3 text-white/80">
          <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
          <span className="text-sm">
            {t(MESSAGE_KEYS.liveStageConnecting)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <RealtimeKitProvider value={meeting}>
      <div className="absolute inset-0">
        <RtkMeeting
          meeting={meeting}
          mode="fill"
          showSetupScreen={false}
          leaveOnUnmount
          className="h-full w-full"
        />
      </div>
    </RealtimeKitProvider>
  );
}
