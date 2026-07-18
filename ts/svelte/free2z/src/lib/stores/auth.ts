import { writable, type Writable } from 'svelte/store';
import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { apiFetch, ensureCSRFToken } from '$lib/api/config';

// Types based on the React frontend
export interface Creator {
  id: number;
  username: string;
  full_name?: string;
  email?: string;
  avatar_image?: {
    url: string;
    thumbnail?: string;
  };
  banner_image?: {
    url: string;
    thumbnail?: string;
  };
  description?: string;
  p2paddr?: string;
  member_price?: string;
  is_verified?: boolean;
  can_stream?: boolean;
  tuzis?: string;
  total?: string;
  zpages?: number;
  stars?: string[];
  fans?: string[];
  twitter?: any;
}

export interface AuthState {
  isAuthenticated: boolean;
  creator: Creator | null;
  loading: boolean;
}

// Initial state
const initialState: AuthState = {
  isAuthenticated: false,
  creator: null,
  loading: false,
};

const AUTH_CACHE_KEY = 'auth';
const AUTH_REVALIDATE_WINDOW_MS = 15_000;

// Create the auth store
function createAuthStore() {
  const { subscribe, set }: Writable<AuthState> =
    writable(initialState);
  let currentState = initialState;
  let authCheckPromise: Promise<boolean> | null = null;
  let logoutPromise: Promise<void> | null = null;
  let lastValidatedAt = 0;

  function persistState(state: AuthState) {
    if (!browser) {
      return;
    }

    if (state.isAuthenticated && state.creator) {
      localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(state));
      return;
    }

    localStorage.removeItem(AUTH_CACHE_KEY);
  }

  function applyState(state: AuthState) {
    currentState = state;
    set(state);
    persistState(state);
  }

  function patchState(nextState: AuthState | ((state: AuthState) => AuthState)) {
    const resolvedState =
      typeof nextState === 'function' ? nextState(currentState) : nextState;
    applyState(resolvedState);
  }

  function clearAuthState(keepLoading = false) {
    applyState({
      ...initialState,
      loading: keepLoading,
    });
  }

  function setAuthenticatedState(creator: Creator, loading = false) {
    applyState({
      isAuthenticated: true,
      creator,
      loading,
    });
  }

  const store = {
    subscribe,

    // Set loading state
    setLoading: (loading: boolean) => {
      patchState((state) => ({ ...state, loading }));
    },

    updateCreator: (creator: Creator) => {
      patchState((state) => ({
        ...state,
        isAuthenticated: true,
        creator,
      }));
    },

    hydrateFromSession: (creator: Creator | null) => {
      if (creator) {
        setAuthenticatedState(creator);
        return;
      }
      clearAuthState();
    },

    handleAuthFailure: (status: number) => {
      if (status === 401 || status === 403) {
        lastValidatedAt = Date.now();
        clearAuthState();
        return true;
      }
      return false;
    },

    ensureAuthenticated: async () => {
      return store.checkAuth({ silent: true });
    },

    // Pure login function (only hits login endpoint)
    loginOnly: async (
      username: string,
      password: string,
      recaptcha?: string,
      otp?: string
    ) => {
      try {
        patchState((state) => ({ ...state, loading: true }));

        const loginData: any = { username, password };
        if (recaptcha) loginData.captcha_result = recaptcha;
        if (otp) loginData.otp = otp;

        const csrf = await ensureCSRFToken();
        const response = await fetch('/api/auth/login/', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(csrf ? { 'X-CSRFToken': csrf } : {}),
          },
          body: JSON.stringify(loginData),
        });

        if (!response.ok) {
          let errorMessage = 'Login failed';
          try {
            const errorData = await response.json();
            errorMessage =
              errorData?.message ||
              errorData?.non_field_errors?.[0] ||
              errorData?.detail ||
              (Object.values(errorData ?? {}) as string[][])?.[0]?.[0] ||
              errorMessage;
          } catch (err) {
            console.error('Failed to parse JSON response in loginOnly:', err);
          }
          throw new Error(errorMessage);
        }

        // Get user data
        const userResponse = await fetch('/api/auth/user/', {
          method: 'GET',
          credentials: 'include',
        });

        if (!userResponse.ok) {
          throw new Error('Failed to fetch user data');
        }

        const creator = await userResponse.json();

        const newState: AuthState = {
          isAuthenticated: true,
          creator,
          loading: false,
        };

        applyState(newState);
        lastValidatedAt = Date.now();

        return { success: true, creator };
      } catch (error: any) {
        patchState((state) => ({ ...state, loading: false }));

        // Check if OTP is required
        if (error.message?.includes('otp') || error.message?.includes('2FA')) {
          return { success: false, requiresOTP: true, error: error.message };
        }

        return { success: false, error: error.message };
      }
    },



    // Combined login/signup function (auto-detects whether to create account or login)
    // Strategy: attempt signup first -> if user exists (409/400/422), fallback to login.
    login: async (
      username: string,
      password: string,
      recaptcha?: string,
      otp?: string
    ) => {
      try {
        patchState((state) => ({ ...state, loading: true }));

        const loginData: any = { username, password };
        if (recaptcha) loginData.captcha_result = recaptcha;
        if (otp) loginData.otp = otp;
        // Attempt signup first (mirrors legacy React flow). If signup succeeds (201), perform explicit login.
        let signupResponse = await apiFetch('/api/start/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username,
            password,
            captcha_result: recaptcha,
          }),
        });

        let finalAuthResponse: Response | null = null;

        if (signupResponse.ok) {
          // New account created -> must now call login to establish session (backend does not auto-auth on /api/start/)
          finalAuthResponse = await apiFetch('/api/auth/login/', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(loginData),
          });
        } else if ([400, 401, 403, 409, 422].includes(signupResponse.status)) {
          // Existing user or validation style error -> try login directly
          finalAuthResponse = await apiFetch('/api/auth/login/', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(loginData),
          });
        } else {
          // Other failure from signup: surface error
          let errorMessage = 'Authentication failed';
          try {
            const errorData = await signupResponse.json();
            if (errorData?.message) errorMessage = errorData.message;
          } catch { }
          throw new Error(errorMessage);
        }

        if (!finalAuthResponse || !finalAuthResponse.ok) {
          let errorMessage = 'Authentication failed';
          try {
            const errorData = await finalAuthResponse?.json();
            if (errorData?.message) errorMessage = errorData.message;
          } catch { }
          throw new Error(errorMessage);
        }

        // Get user data
        const userResponse = await apiFetch('/api/auth/user/', {
          method: 'GET',
        });

        if (!userResponse.ok) {
          throw new Error('Failed to fetch user data');
        }

        const creator = await userResponse.json();

        const newState: AuthState = {
          isAuthenticated: true,
          creator,
          loading: false,
        };

        applyState(newState);
        lastValidatedAt = Date.now();

        return { success: true, creator };
      } catch (error: any) {
        patchState((state) => ({ ...state, loading: false }));

        // Check if OTP is required
        if (error.message?.includes('otp') || error.message?.includes('2FA')) {
          return { success: false, requiresOTP: true, error: error.message };
        }

        return { success: false, error: error.message };
      }
    },

    // Explicit signup only (in case we add a dedicated Sign Up button later)
    signup: async (username: string, password: string, recaptcha?: string) => {
      try {
        patchState((state) => ({ ...state, loading: true }));

        const response = await apiFetch('/api/start/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username,
            password,
            captcha_result: recaptcha,
          }),
        });

        if (!response.ok) {
          let errorMessage = 'Signup failed';
          try {
            const errorData = await response.json();
            if (errorData?.message) errorMessage = errorData.message;
          } catch { }
          throw new Error(errorMessage);
        }

        // Explicit login after successful signup to establish session
        const loginPayload: any = { username, password };
        if (recaptcha) loginPayload.captcha_result = recaptcha;
        const loginResponse = await apiFetch('/api/auth/login/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(loginPayload),
        });

        if (!loginResponse.ok) {
          let errorMessage = 'Login after signup failed';
          try {
            const errorData = await loginResponse.json();
            if (errorData?.message) errorMessage = errorData.message;
          } catch { }
          throw new Error(errorMessage);
        }

        // Fetch user after signup
        const userResponse = await fetch('/api/auth/user/', {
          method: 'GET',
          credentials: 'include',
        });

        if (!userResponse.ok) {
          throw new Error('Failed to fetch user data after signup');
        }

        const creator = await userResponse.json();
        const newState: AuthState = {
          isAuthenticated: true,
          creator,
          loading: false,
        };
        applyState(newState);
        lastValidatedAt = Date.now();
        return { success: true, creator };
      } catch (error: any) {
        patchState((state) => ({ ...state, loading: false }));
        return { success: false, error: error.message };
      }
    },

    // Logout function
    logout: async () => {
      if (logoutPromise) {
        return logoutPromise;
      }

      logoutPromise = (async () => {
        try {
          patchState((state) => ({ ...state, loading: true }));

          const csrf = await ensureCSRFToken();
          await fetch('/api/auth/logout/', {
            method: 'POST',
            credentials: 'include',
            headers: {
              ...(csrf ? { 'X-CSRFToken': csrf } : {}),
            },
          });

          // Clear state regardless of API response
          lastValidatedAt = Date.now();
          clearAuthState();

          // Redirect to home
          goto('/');
        } catch (error) {
          console.error('Logout error:', error);
          // Still clear state even if API call fails
          lastValidatedAt = Date.now();
          clearAuthState();
        } finally {
          logoutPromise = null;
        }
      })();

      return logoutPromise;
    },

    // Check if user is authenticated (for guards)
    checkAuth: async (
      options: { force?: boolean; silent?: boolean } = {}
    ) => {
      const { force = false, silent = false } = options;
      if (authCheckPromise) {
        return authCheckPromise;
      }

      if (
        !force &&
        Date.now() - lastValidatedAt < AUTH_REVALIDATE_WINDOW_MS
      ) {
        return currentState.isAuthenticated;
      }

      authCheckPromise = (async () => {
        if (!silent) {
          patchState((state) => ({ ...state, loading: true }));
        }

        try {
          const response = await fetch('/api/auth/user/', {
            method: 'GET',
            credentials: 'include',
          });

          if (response.ok) {
            const creator = await response.json();
            setAuthenticatedState(creator);
            lastValidatedAt = Date.now();
            return true;
          }

          if (store.handleAuthFailure(response.status)) {
            return false;
          }

          lastValidatedAt = Date.now();
          return currentState.isAuthenticated;
        } catch (error) {
          console.error('Auth check failed:', error);
          lastValidatedAt = Date.now();
          return currentState.isAuthenticated;
        } finally {
          authCheckPromise = null;
          if (!silent) {
            patchState((state) => ({ ...state, loading: false }));
          }
        }
      })();

      return authCheckPromise;
    },

    /**
     * Exposes ensureCSRFToken for other UI modules to obtain a CSRF token.
     * you can make a GET request to /api/auth/user/ to allow the backend to set the csrftoken cookie if needed.
     * @returns {Promise<string | null>} The CSRF token string if available, or null if not in browser environment or after failed attempts.
     * @throws {never} Does not throw errors; network failures are handled internally.
     */
    ensureCSRFToken,

    // Clear auth state (for errors)
    clear: () => {
      lastValidatedAt = Date.now();
      clearAuthState();
    },

    // Password reset function
    resetPassword: async (email: string) => {
      try {
        patchState((state) => ({ ...state, loading: true }));

        const csrf = await ensureCSRFToken();
        const response = await fetch('/api/emails/reset-password', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(csrf ? { 'X-CSRFToken': csrf } : {}),
          },
          body: JSON.stringify({ email }),
        });

        patchState((state) => ({ ...state, loading: false }));

        if (!response.ok) {
          let errorMessage = 'Password reset failed';
          try {
            const errorData = await response.json();
            if (errorData?.message || errorData?.detail) {
              errorMessage = errorData.message || errorData.detail;
            }
          } catch { }
          return { success: false, error: errorMessage };
        }

        return { success: true };
      } catch (error: any) {
        patchState((state) => ({ ...state, loading: false }));
        return { success: false, error: error.message || 'Password reset failed' };
      }
    },

    // Send email verification
    sendEmailVerification: async (email: string) => {
      try {
        const csrf = await ensureCSRFToken();
        const response = await fetch('/api/emails/add', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(csrf ? { 'X-CSRFToken': csrf } : {}),
          },
          body: JSON.stringify({ email }),
        });

        if (!response.ok) {
          let errorMessage = 'Email verification failed';
          try {
            const errorData = await response.json();
            if (errorData?.message || errorData?.detail) {
              errorMessage = errorData.message || errorData.detail;
            }
          } catch { }
          return { success: false, error: errorMessage };
        }

        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message || 'Email verification failed' };
      }
    },
  };

  if (browser) {
    const stored = localStorage.getItem(AUTH_CACHE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as AuthState;
        if (parsed.isAuthenticated && parsed.creator) {
          store.hydrateFromSession(parsed.creator);
        } else {
          localStorage.removeItem(AUTH_CACHE_KEY);
        }
      } catch {
        localStorage.removeItem(AUTH_CACHE_KEY);
      }
    }
  }

  return store;
}

export const authStore = createAuthStore();

// Derived stores for convenience
export const isAuthenticated = {
  subscribe: (callback: (value: boolean) => void) =>
    authStore.subscribe((state) => callback(state.isAuthenticated)),
};

export const currentUser = {
  subscribe: (callback: (value: Creator | null) => void) =>
    authStore.subscribe((state) => callback(state.creator)),
};

export const authLoading = {
  subscribe: (callback: (value: boolean) => void) =>
    authStore.subscribe((state) => callback(state.loading)),
};
