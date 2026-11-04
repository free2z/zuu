/**
 * The one owner of the sign-in modal.
 *
 * Before this, `AuthButton` and the `/login` page each carried their own copy
 * of the password → OTP handoff, and every other sign-in CTA — the Converse
 * composer, the comment form, the donate panel, the notification bell, the
 * editor after an expired session — could only navigate to an inert `?login`
 * sentinel on the homepage, which nothing read. The visitor lost their page
 * and got no login.
 *
 * Now any component calls `requestLogin()` and `AuthModalHost` (mounted once
 * in the root layout) renders the modal IN PLACE: the pathname, query, hash,
 * scroll position and history entry are all untouched, and on success the
 * auth store updates and the caller's own UI re-renders around the visitor so
 * they can carry on with what they were doing. Server guards that have
 * nothing to render without a session still redirect to `/login?next=…`
 * (`$lib/login-destination`); that page is itself just another caller of
 * this store.
 *
 * Module-scoped store, browser-only by usage: every caller is a click
 * handler or `onMount`, so nothing writes to it during SSR.
 */
import { writable } from "svelte/store";
import type { Creator } from "$lib/stores/auth";

export type AuthModalView = "login" | "signup";

export interface LoginRequestOptions {
  /** Which form the modal opens on. Default: login. */
  view?: AuthModalView;
  /**
   * Already-translated copy shown above the login form: why the visitor is
   * being asked to sign in ("Your email address was changed…").
   */
  notice?: string;
  reauthentication?: boolean;
  /**
   * The control that opened the modal. Focus returns to it if the visitor
   * dismisses without signing in — a dialog that strands keyboard focus on
   * `<body>` is a regression on the link it replaced.
   */
  trigger?: HTMLElement | null;
  /** Runs after a successful password or OTP login. */
  onSuccess?: (creator: Creator | null) => void;
}

export interface AuthModalRequest extends LoginRequestOptions {
  /** Monotonic; the host reacts to a NEW id, never to a re-set of the same. */
  id: number;
  view: AuthModalView;
  notice: string;
}

export interface AuthModalState {
  open: boolean;
  request: AuthModalRequest | null;
}

function createAuthModalStore() {
  const { subscribe, update } = writable<AuthModalState>({
    open: false,
    request: null,
  });
  let sequence = 0;

  return {
    subscribe,

    /** Open a fresh sign-in request where the visitor is, superseding any prior request. */
    requestLogin(options: LoginRequestOptions = {}): number {
      sequence += 1;
      update(() => ({
        open: true,
        request: {
          id: sequence,
          view: options.view ?? "login",
          notice: options.notice ?? "",
          reauthentication: options.reauthentication ?? false,
          trigger: options.trigger ?? null,
          onSuccess: options.onSuccess,
        },
      }));
      return sequence;
    },

    /** The host reports the modal closed — signed in or dismissed. */
    close(requestId?: number): void {
      update((state) => {
        if (requestId !== undefined && state.request?.id !== requestId)
          return state;
        return { open: false, request: null };
      });
    },
  };
}

export const authModal = createAuthModalStore();

/** Convenience for click handlers: `onclick={(e) => requestLogin({ trigger: e.currentTarget })}`. */
export function requestLogin(options: LoginRequestOptions = {}): number {
  return authModal.requestLogin(options);
}
