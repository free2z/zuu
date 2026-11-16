import axios from "axios";
import Cookies from "js-cookie";

export type HostClient = {
  leave: () => Promise<unknown>;
  self: {
    on: (
      event: "roomLeft",
      listener: (event: { state: string }) => void
    ) => void;
    removeListener: (
      event: "roomLeft",
      listener: (event: { state: string }) => void
    ) => void;
  };
  connectedMeetings?: {
    on: (
      event: "meetingChanged",
      listener: (client: HostClient) => void
    ) => void;
    removeListener: (
      event: "meetingChanged",
      listener: (client: HostClient) => void
    ) => void;
  };
};

/** A single host intent, including provisioning before an SDK client exists. */
export function createHostSeat({
  username,
  actorId,
  type,
  price,
  isCurrent,
  isIntentCurrent,
  initialize,
  onReady,
  onError,
  onLost,
  onClosed,
}: {
  username: string;
  actorId: number;
  type: string;
  price?: string;
  isCurrent: () => boolean;
  isIntentCurrent: () => boolean;
  initialize: (authToken: string) => Promise<HostClient | undefined>;
  onReady: (client: HostClient) => void;
  onClosed: () => void;
  onError: (error: unknown) => void;
  onLost: (reason: "superseded" | "authentication") => void;
}) {
  const session = crypto.randomUUID();
  const path = `/api/dyte/${encodeURIComponent(username)}/host-session`;
  let closed = false;
  let client: HostClient | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposal: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let left = false;
  let handoff: ReturnType<typeof setTimeout> | undefined;
  const current = () => isCurrent() && isIntentCurrent();
  const release = () => {
    // Cookie credentials belong to the current actor. Never send an old
    // actor's cleanup after the UI has observed an account transition.
    if (!isCurrent()) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    // A normal close can be followed immediately by navigation, so every
    // exact-seat release must survive document unload, not only pagehide.
    void fetch(path, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": Cookies.get("csrftoken") || "",
      },
      body: JSON.stringify({ host_session: session, action: "release" }),
      signal: controller.signal,
    })
      .catch(() => {})
      .finally(() => clearTimeout(timeout));
  };
  const leave = (target = client) => {
    if (!target || (target === client && left)) return;
    if (target === client) left = true;
    void target.leave().catch(() => {});
  };
  const close = (giveBack = true) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearTimeout(disposal);
    clearTimeout(handoff);
    window.removeEventListener("pagehide", pageHide);
    client?.self.removeListener("roomLeft", roomLeft);
    client?.connectedMeetings?.removeListener("meetingChanged", meetingChanged);
    leave();
    if (giveBack) release();
    onClosed();
  };
  const roomLeft = ({ state }: { state: string }) => {
    if (["left", "ended", "kicked"].includes(state)) {
      left = true;
      close();
    } else if (state === "failed") close();
    else if (state === "connected-meeting") left = true;
    // A disconnected socket keeps ownership while RTK reconnects.
  };
  const meetingChanged = (next: HostClient) => {
    if (closed || !current()) {
      leave(next);
      close();
      return;
    }
    client?.self.removeListener("roomLeft", roomLeft);
    client?.connectedMeetings?.removeListener("meetingChanged", meetingChanged);
    client = next;
    left = false;
    next.self.on("roomLeft", roomLeft);
    next.connectedMeetings?.on("meetingChanged", meetingChanged);
    onClosed();
    clearTimeout(handoff);
    handoff = setTimeout(() => {
      if (!closed && current() && client === next) onReady(next);
    }, 100);
  };
  const pageHide = () => close();
  window.addEventListener("pagehide", pageHide);
  const beat = async () => {
    if (closed || pending) return;
    if (!current()) {
      close();
      return;
    }
    pending = true;
    try {
      await axios.post(
        path,
        { host_session: session, action: "heartbeat" },
        { timeout: 10_000 }
      );
    } catch (error: any) {
      const response = error?.response ?? error;
      const authDenied = response?.status === 401 || response?.status === 403;
      if (
        !closed &&
        (authDenied ||
          (response?.status === 409 &&
            response?.data?.code === "host_session_superseded"))
      ) {
        close(false);
        if (current()) onLost(authDenied ? "authentication" : "superseded");
      }
    } finally {
      pending = false;
    }
  };
  void (async () => {
    try {
      const { data } = await axios.post(
        `/api/dyte/${encodeURIComponent(username)}/${type}`,
        {
          role: "host",
          host_session: session,
          expected_actor_id: actorId,
          ...(type === "ppv" ? { price_per_minute: price } : {}),
        },
        { timeout: 30_000 }
      );
      if (closed) {
        release();
        return;
      }
      if (!current()) {
        close();
        return;
      }
      if (data.host_session !== session || typeof data.auth_token !== "string")
        throw new Error(
          "The broadcaster session could not be confirmed. Start the stream again."
        );
      timer = setInterval(() => void beat(), 15_000);
      void beat();
      const initialized = await initialize(data.auth_token);
      if (closed || !current()) {
        leave(initialized);
        close();
        return;
      }
      if (!initialized)
        throw new Error(
          "The meeting could not be initialized. Start the stream again."
        );
      client = initialized;
      client.self.on("roomLeft", roomLeft);
      client.connectedMeetings?.on("meetingChanged", meetingChanged);
      onReady(client);
    } catch (error) {
      const report = !closed && current();
      close();
      if (report) onError(error);
    }
  })();
  return {
    retain() {
      clearTimeout(disposal);
      return () => {
        disposal = setTimeout(() => close(), 0);
      };
    },
    close,
    get closed() {
      return closed;
    },
  };
}
