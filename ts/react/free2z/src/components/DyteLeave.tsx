import { useRealtimeKitMeeting } from "@cloudflare/realtimekit-react";
import { useEffect } from "react";

export default function DyteLeave() {
  const { meeting } = useRealtimeKitMeeting();
  useEffect(() => {
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
      leave();
    };
  }, [meeting]);
  return null;
}
