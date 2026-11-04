/** Bind the paid-admission completion callback to one join attempt. */
/**
 * @param {any} meeting
 * @param {AbortSignal | undefined} signal
 * @param {() => void} onJoin
 */
export function listenForPpvAdmissionJoin(meeting, signal, onJoin) {
  if (!meeting?.self || signal?.aborted) return () => {};
  let active = true;
  const remove = () => {
    if (!active) return;
    active = false;
    meeting.self.off("roomJoined", joined);
    signal?.removeEventListener("abort", cancelled);
  };
  const joined = () => {
    if (!active) return;
    remove();
    onJoin();
  };
  const cancelled = () => remove();
  meeting.self.on("roomJoined", joined);
  signal?.addEventListener("abort", cancelled, { once: true });
  return remove;
}
