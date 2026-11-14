import { useEffect } from "react";

import { RtkMeeting } from "@cloudflare/realtimekit-react-ui";
import { useRealtimeKitMeeting } from "@cloudflare/realtimekit-react";
import type { leaveRoomState } from "@cloudflare/realtimekit";

import { useTransitionNavigate } from "../hooks/useTransitionNavigate";
import { useGlobalState } from "../state/global";

export default function DyteCreator() {
  const { meeting } = useRealtimeKitMeeting();
  const navigate = useTransitionNavigate();
  const [creator] = useGlobalState("creator");

  const onRoomLeft = ({ state }: { state: leaveRoomState }) => {
    // maybe "left" should count here too
    const doRedirect = state !== "disconnected";
    if (doRedirect) {
      if (creator.username) {
        navigate("/profile");
      } else {
        navigate("/");
      }
    }
  };

  useEffect(() => {
    if (meeting) {
      meeting.self.on("roomLeft", onRoomLeft);
      return () => {
        meeting.self.removeListener("roomLeft", onRoomLeft);
      };
    }
  }, [meeting]);

  return (
    <>
      <RtkMeeting
        meeting={meeting}
        showSetupScreen={true}
        leaveOnUnmount={false}
      />
    </>
  );
}
