export const UNSAVED_TRANSITION_MESSAGE =
  "This draft could not be saved locally. Leave anyway?";

type UnsavedTransitionGuard = () => boolean;

const guards = new Set<UnsavedTransitionGuard>();

/** Register a synchronous persistence boundary owned by the mounted editor. */
export function registerUnsavedTransitionGuard(
  guard: UnsavedTransitionGuard,
): () => void {
  guards.add(guard);
  return () => guards.delete(guard);
}

/** Try every mounted boundary; one failure makes the transition unsafe. */
export function saveBeforeExplicitAccountTransition(): boolean {
  let safe = true;
  for (const guard of guards) {
    try {
      if (!guard()) safe = false;
    } catch {
      safe = false;
    }
  }
  return safe;
}

export function confirmUnsavedTransition(): boolean {
  return window.confirm(UNSAVED_TRANSITION_MESSAGE);
}

/** Account changes do not pass through the router, so guard them explicitly. */
export function allowExplicitAccountTransition(): boolean {
  return saveBeforeExplicitAccountTransition() || confirmUnsavedTransition();
}
