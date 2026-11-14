import React, { useEffect } from "react";
// Only app-owned lifecycle behavior is under test. No provider acceptance,
// WebRTC, prejoin UI, or reconnection behavior is simulated by this boundary.
export const useRealtimeKitMeeting = () => ({
  meeting: window.rtkContract.meeting,
});
export const RtkMeeting = ({ meeting, leaveOnUnmount }) => {
  useEffect(() => {
    window.rtkContract.uiLeaveOnUnmount = leaveOnUnmount;
    return () => {
      if (leaveOnUnmount) void meeting.leave();
    };
  }, [meeting, leaveOnUnmount]);
  return <div data-testid="meeting-boundary">Provider meeting boundary</div>;
};
export const useTransitionNavigate = () => (path) =>
  window.rtkContract.navigate.push(path);
export const useGlobalState = () => [{ username: "host" }];
