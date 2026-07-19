import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import {
  RealtimeKitProvider,
  useRealtimeKitClient,
} from "@cloudflare/realtimekit-react";
import { RtkMeeting } from "@cloudflare/realtimekit-react-ui";
import { Button } from "@/components/ui/button";
import type { DyteJoinTicket } from "@/lib/api/types";

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
export function Stage({ ticket }: { ticket: DyteJoinTicket }) {
  const [meeting, initMeeting] = useRealtimeKitClient();
  const [status, setStatus] = useState<StageStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("connecting");
    setError(null);

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
        setError("Failed to connect to meeting.");
        setStatus("failed");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("Failed to initialize RealtimeKit meeting:", err);
        const e = err as { message?: string; name?: string };
        const message =
          e.name === "NotAllowedError" ||
          e.message?.includes("Permission denied")
            ? "Microphone or camera permission denied. Please allow access in your browser/app settings and try again."
            : e.message || "Failed to connect to meeting.";
        setError(message);
        setStatus("failed");
      });

    return () => {
      cancelled = true;
    };
  }, [ticket.authToken, ticket.as, attempt, initMeeting]);

  useEffect(() => {
    if (!meeting) return;

    const onJoined = () => setStatus("connected");
    const onLeft = ({ state }: { state: string }) => {
      if (state === "ended") {
        setStatus("ended");
      } else if (state === "failed") {
        setError("Connection to the meeting failed.");
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

  if (error) {
    return (
      <div className="absolute inset-0 grid place-items-center px-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-full bg-red-500/20 ring-2 ring-red-400/40">
            <AlertCircle className="h-7 w-7 text-red-300" aria-hidden />
          </div>
          <p className="max-w-xs text-sm text-white/80">{error}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-1 border-white/20 bg-white/5 text-white hover:bg-white/10"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </Button>
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
