import { useRealtimeKitMeeting } from "@cloudflare/realtimekit-react";
import { useEffect } from "react";

// Unmount leaves are deferred by one task so React StrictMode's development
// effect replay (cleanup immediately followed by setup for the SAME meeting,
// with no real unmount) cancels it instead of tearing the meeting down.
const pendingUnmountLeave = new WeakMap<object, ReturnType<typeof setTimeout>>();

export default function DyteLeave() {
  const { meeting } = useRealtimeKitMeeting();
  useEffect(() => {
    if (meeting) {
      const pending = pendingUnmountLeave.get(meeting);
      if (pending !== undefined) {
        clearTimeout(pending);
        pendingUnmountLeave.delete(meeting);
      }
    }
    let leaving = false;
    const leave = () => {
      if (!meeting || leaving) return;
      leaving = true;
      void meeting.leave().catch(() => {});
    };
    // A UI leave button also calls Core.leave(). Its terminal event means
    // navigation/unmount must not issue another leave for that meeting.
    // "failed" is deliberately NOT terminal here: Core 2.0.3 emits it when
    // joining the media server fails WITHOUT running its media cleanup, so
    // unmount must still call leave() or camera/microphone capture can
    // outlive the meeting.
    const onRoomLeft = ({ state }: { state: string }) => {
      if (["left", "ended", "kicked"].includes(state)) leaving = true;
    };
    meeting?.self.on("roomLeft", onRoomLeft);
    window.addEventListener("pagehide", leave);
    window.addEventListener("popstate", leave);
    return () => {
      meeting?.self.removeListener("roomLeft", onRoomLeft);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("popstate", leave);
      if (!meeting || leaving) return;
      pendingUnmountLeave.set(
        meeting,
        setTimeout(() => {
          pendingUnmountLeave.delete(meeting);
          leave();
        }, 0)
      );
    };
  }, [meeting]);
  return null;
}
