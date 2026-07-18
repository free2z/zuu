import { authStore } from '$lib/stores/auth';
import { goto } from '$app/navigation';
import { browser } from '$app/environment';

/**
 * Auth guard for protecting routes
 * Call this in +page.ts or +layout.ts to require authentication
 */
export async function requireAuth(redirectTo?: string) {
  if (!browser) return; // Skip on server

  const isAuthenticated = await authStore.ensureAuthenticated();

  if (!isAuthenticated) {
    // Store the intended destination for redirect after login
    if (redirectTo) {
      localStorage.setItem('authRedirectTo', redirectTo);
    }

    // Redirect to home with login modal trigger
    goto('/?login=true');
    return false;
  }

  return true;
}

/**
 * Check if user has a specific role or permission
 * Extend this based on your backend user model
 */
export function hasPermission(permission: string): boolean {
  // This is a placeholder - implement based on your backend user model
  // You might check user.roles, user.permissions, etc.
  return true;
}

/**
 * Redirect user after successful login
 */
export function handlePostLoginRedirect() {
  if (!browser) return;

  const redirectTo = localStorage.getItem('authRedirectTo');

  if (redirectTo) {
    localStorage.removeItem('authRedirectTo');
    goto(redirectTo);
  } else {
    // Default redirect to profile or dashboard
    goto('/');
  }
}
