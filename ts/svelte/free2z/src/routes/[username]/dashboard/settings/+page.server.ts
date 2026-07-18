import type { PageServerLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export const load: PageServerLoad = async ({ params, cookies, fetch }) => {
  const apiBase = env.PRIVATE_API_BASE_URL || 'http://localhost:8000';

  const sessionId = cookies.get('sessionid');
  if (!sessionId) {
    throw redirect(302, '/?login=true');
  }

  try {
    const userResponse = await fetch(`${apiBase}/api/auth/user/`, {
      headers: {
        Cookie: `sessionid=${sessionId}`,
      },
    });

    if (!userResponse.ok) {
      throw redirect(302, '/?login=true');
    }

    const creator = await userResponse.json();

    if (creator.username !== params.username) {
      throw error(403, {
        message: 'You can only access your own settings',
        code: 403,
      });
    }

    return { creator };
  } catch (err: any) {
    console.error(
      'Error loading settings:',
      err instanceof Error ? err.message : String(err)
    );
    if (err.status) {
      throw err;
    }
    throw error(500, { message: 'Failed to load settings', code: 500 });
  }
};
