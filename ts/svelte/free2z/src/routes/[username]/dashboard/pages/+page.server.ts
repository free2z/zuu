import type { PageServerLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export const load: PageServerLoad = async ({ params, cookies, fetch, url }) => {
  const apiBase = env.PRIVATE_API_BASE_URL || 'http://localhost:8000';
  const page = url.searchParams.get('page') || '1';
  const search = url.searchParams.get('q') || '';

  // Check if user is authenticated
  const sessionId = cookies.get('sessionid');
  if (!sessionId) {
    throw redirect(302, `/?login=true`);
  }

  try {
    // Fetch current user to verify they are the owner
    const userResponse = await fetch(`${apiBase}/api/auth/user/`, {
      headers: {
        Cookie: `sessionid=${sessionId}`,
      },
    });

    if (!userResponse.ok) {
      throw redirect(302, `/?login=true`);
    }

    const currentUser = await userResponse.json();

    // Verify the user is accessing their own dashboard
    if (currentUser.username !== params.username) {
      throw error(403, { message: 'You can only access your own dashboard', code: 403 });
    }

    // Fetch user's zpages (both published and drafts) using the 'mine' parameter
    const queryParams = new URLSearchParams({
      mine: 'true',
      ordering: '-updated_at',
      page: page,
      page_size: '12'
    });

    if (search) {
      queryParams.set('search', search);
    }

    const zpagesResponse = await fetch(
      `${apiBase}/api/zpage/?${queryParams.toString()}`,
      {
        headers: {
          Cookie: `sessionid=${sessionId}`,
        },
      }
    );

    if (!zpagesResponse.ok) {
      console.error('Failed to fetch zpages:', zpagesResponse.status);
      return {
        zpages: [],
        count: 0,
        page: 1,
        username: currentUser.username,
      };
    }

    const zpagesData = await zpagesResponse.json();

    return {
      zpages: zpagesData.results || [],
      count: zpagesData.count || 0,
      page: parseInt(page),
      username: currentUser.username,
      search
    };
  } catch (err: any) {
    console.error('Error loading dashboard:', err);
    // If it's already a SvelteKit error, re-throw it
    if (err.status) {
      throw err;
    }
    throw error(500, { message: 'Failed to load dashboard', code: 500 });
  }
};
