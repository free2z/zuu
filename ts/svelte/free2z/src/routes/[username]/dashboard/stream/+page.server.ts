import type { PageServerLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export const load: PageServerLoad = async ({ params, cookies, fetch }) => {
  const apiBase = env.PRIVATE_API_BASE_URL || '';

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

    return {
      username: currentUser.username,
    };
  } catch (err: any) {
    console.error('Error loading dashboard:', err);
    if (err.status) {
      throw err;
    }
    throw error(500, { message: 'Failed to load dashboard', code: 500 });
  }
};
