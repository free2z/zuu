import type { PageLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import type { ZPage } from '$lib/types/zpage';

export const ssr = false;

async function fetchCurrentUser(fetchFn: typeof fetch) {
  const response = await fetchFn('/api/auth/user/', {
    credentials: 'include',
  });

  if (response.status === 401 || response.status === 403) {
    throw redirect(302, '/?login=true');
  }

  if (!response.ok) {
    throw error(502, {
      message: 'Failed to load editor user',
      code: response.status,
    });
  }

  return response.json();
}

async function fetchOwnedZPage(fetchFn: typeof fetch, identifier: string) {
  const response = await fetchFn(`/api/zpage/${encodeURIComponent(identifier)}/`, {
    credentials: 'include',
  });

  if (response.status === 401 || response.status === 403) {
    throw redirect(302, '/?login=true');
  }

  if (response.status === 404) {
    throw error(404, { message: 'Article not found', code: 404 });
  }

  if (!response.ok) {
    throw error(502, {
      message: 'Failed to load article',
      code: response.status,
    });
  }

  return (await response.json()) as ZPage;
}

export const load: PageLoad = async ({ fetch, url }) => {
  try {
    const currentUser = await fetchCurrentUser(fetch);
    const requestedId = url.searchParams.get('id')?.trim() || 'new';

    if (requestedId === 'new') {
      return {
        currentUser,
        requestedId,
        zpage: null,
      };
    }

    const zpage = await fetchOwnedZPage(fetch, requestedId);

    if (zpage.creator.username !== currentUser.username) {
      throw redirect(302, `/${currentUser.username}/dashboard/pages`);
    }

    return {
      currentUser,
      requestedId,
      zpage,
    };
  } catch (err: any) {
    if (err?.status) {
      throw err;
    }

    throw error(502, {
      message: 'Unable to reach the backend',
      code: 502,
    });
  }
};
