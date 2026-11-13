import { isTauri } from "@/lib/platform";
export const NOTIFICATION_STATES = ["unsupported", "unconfigured", "off", "denied", "waiting-token", "enabled", "queued", "expired", "revocation-pending", "offline", "unavailable"] as const;
export type NotificationState = typeof NOTIFICATION_STATES[number];
export type NotificationStatus = { state: NotificationState; wake: boolean };
export async function notificationCommand(command: "status" | "enable" | "disable" | "reconcile" | "test_wake"): Promise<NotificationStatus> {
  if (!isTauri()) return { state: "unsupported", wake: false };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const value = await invoke<NotificationStatus>(`plugin:notify|${command}`);
    if (!value || Object.keys(value).sort().join(",") !== "state,wake" || !NOTIFICATION_STATES.includes(value.state) || typeof value.wake !== "boolean") throw new Error();
    return value;
  } catch (error) {
    // Never display raw native/network errors, which may contain a private token.
    return { state: error === "offline" ? "offline" : error === "expired" ? "expired" : "unavailable", wake: false };
  }
}

export async function listenForNotificationChanges(callback: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("notify://changed", callback);
}
