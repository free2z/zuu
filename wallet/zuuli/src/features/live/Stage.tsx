import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import {
  RealtimeKitProvider,
  useRealtimeKitClient,
} from "@cloudflare/realtimekit-react";
import { RtkMeeting } from "@cloudflare/realtimekit-react-ui";
import { Button } from "@/components/ui/button";
import type { DyteJoinTicket } from "@/lib/api/types";
import {
  classifyLiveFailure,
  safeLiveDiagnostic,
  type LiveConnectionFailure,
} from "./connection-failure";

type StageStatus = "connecting" | "connected" | "failed" | "ended";

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
  const [meeting, initMeeting] = useRealtimeKitClient();
  const [status, setStatus] = useState<StageStatus>("connecting");
  const [failure, setFailure] = useState<LiveConnectionFailure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
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
  }, [ticket.authToken, ticket.as, initMeeting]);

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
    if (!refreshTicket || !onTicketRefreshed || refreshing) return;
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

  if (failure) {
    return (
      <div className="absolute inset-0 grid place-items-center px-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-full bg-destructive/20 ring-2 ring-destructive/40">
            <AlertCircle className="h-7 w-7 text-destructive-foreground" aria-hidden />
          </div>
          <p className="max-w-xs text-sm text-white/80">{failure.message}</p>
          {failure.retryable && refreshTicket && onTicketRefreshed ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-1 border-white/20 bg-white/5 text-white hover:bg-white/10"
              disabled={refreshing || !online}
              onClick={() => void retryWithFreshTicket()}
            >
              {refreshing
                ? "Getting a fresh ticket…"
                : !online
                  ? "Waiting for connection"
                  : "Try again"}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (status === "ended") {
    return (
      <div className="absolute inset-0 grid place-items-center px-6">
        <p className="text-sm text-white/80">The stream has ended.</p>
      </div>
    );
  }

  if (!meeting) {
    return (
      <div className="absolute inset-0 grid place-items-center">
        <div className="flex flex-col items-center gap-3 text-white/80">
          <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
          <span className="text-sm">Connecting to stream…</span>
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
