import { error, redirect } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export const load = async ({ params, url, fetch, request }: RequestEvent) => {
  const username = params.username;
  if (!username) {
     throw error(400, { message: 'Username is required', code: 400 });
  }

  const type = url.searchParams.get('type') || 'broadcast';
  const apiBase = env.PRIVATE_API_BASE_URL || '';

  // 1. Fetch creator profile to ensure existence and get SEO data
  let creator;
  try {
    const creatorResponse = await fetch(`${apiBase}/api/creator/${username}/`);

    if (creatorResponse.ok) {
      creator = await creatorResponse.json();
    } else if (creatorResponse.status === 404) {
      throw error(404, { message: 'Creator not found', code: 404 });
    } else {
      console.error('Creator API error:', creatorResponse.status);
      throw error(500, { message: 'Failed to load creator profile', code: 500 });
    }
  } catch (err: any) {
    if (err?.status && err?.body) throw err;
    console.error('Error fetching creator:', err);
    throw error(500, { message: 'Internal Server Error', code: 500 });
  }

  // 2. Route Guard for Protected Streams
  const protectedTypes = ['subscribers-only', 'ppv', 'private'];
  if (protectedTypes.includes(type)) {
    try {
      // Forward cookies to check authentication
      const cookieHeader = request.headers.get('cookie') || '';
      
      const userResponse = await fetch(`${apiBase}/api/auth/user/`, {
        headers: {
          cookie: cookieHeader
        }
      });

      if (!userResponse.ok) {
        // User is not authenticated or session invalid
        const returnUrl = url.pathname + url.search;
        throw redirect(302, `/login?next=${encodeURIComponent(returnUrl)}`);
      }
      
    } catch (err: any) {
      if (err.status === 302) throw err; // Re-throw redirect
      console.error('Auth check failed:', err);
      // Fail safely to redirect if we can't verify auth for a protected stream
      const returnUrl = url.pathname + url.search;
      throw redirect(302, `/login?next=${encodeURIComponent(returnUrl)}`);
    }
  }

  return {
    creator,
    type,
    username
  };
};
