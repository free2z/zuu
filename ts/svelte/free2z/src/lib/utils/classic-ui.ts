import { browser } from '$app/environment';

// nginx route (not a SvelteKit route) that clears the f2z_ui cookie and
// redirects to /, landing the user back on the classic React UI. It only
// exists on the domains where nginx serves both UIs side by side.
export const CLASSIC_UI_PATH = '/classic-ui';

const CLASSIC_UI_HOSTS = /(^|\.)(free2z\.cash|free2z\.com|free2give\.xyz)$/;

export function classicUiAvailable(): boolean {
  return browser && CLASSIC_UI_HOSTS.test(window.location.hostname);
}

export function switchToClassicUi(): void {
  // Full-page navigation on purpose — the SvelteKit client router must not
  // intercept this path.
  window.location.href = CLASSIC_UI_PATH;
}
