import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export const load: PageServerLoad = async ({ params, fetch, cookies, url }) => {
  const apiBase = env.PRIVATE_API_BASE_URL || 'http://localhost:8000';
  let isOwner = false;
  const sessionId = cookies.get('sessionid');
  const page = url.searchParams.get('page') || '1';
  const search = url.searchParams.get('search') || '';
  const ordering = url.searchParams.get('ordering') || '-created_at';
  const tag = url.searchParams.get('tag') || '';

  if (sessionId) {
    try {
      const userRes = await fetch(`${apiBase}/api/auth/user/`, {
        headers: { Cookie: `sessionid=${sessionId}` }
      });
      if (userRes.ok) {
        const user = await userRes.json();
        if (user.username === params.username) {
          isOwner = true;
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error checking auth:', message);
    }
  }

  try {
    // Try to fetch tags for filtering
    let tags: string[] = [];
    try {
      const tagsRes = await fetch(`${apiBase}/api/tagging/autocomplete`);
      if (tagsRes.ok) tags = await tagsRes.json();
    } catch (e) {
      console.warn('Could not fetch tags:', e);
    }

    // Try to fetch creator details - this will tell us if it's a creator
    const creatorResponse = await fetch(
      `${apiBase}/api/creator/${params.username}/`
    );

    if (creatorResponse.ok) {
      // It's a creator, get the data
      const creator = await creatorResponse.json();

      let zpagesData;
      let query = `page=${page}&ordering=${ordering}&page_size=6`;
      if (search) {
        query += `&search=${encodeURIComponent(search)}`;
      }
      if (tag) {
        query += `&tags=${encodeURIComponent(tag)}`;
      }

      if (isOwner) {
        // Fetch owner's zpages (includes drafts)
        const zpagesResponse = await fetch(
          `${apiBase}/api/zpage/?mine=true&${query}`,
          {
            headers: { Cookie: `sessionid=${sessionId}` }
          }
        );
        zpagesData = zpagesResponse.ok ? await zpagesResponse.json() : { results: [], count: 0, next: null, previous: null };
      } else {
        // Fetch public zpages
        const zpagesResponse = await fetch(
          `${apiBase}/api/zpage/?username=${params.username}&${query}`
        );
        zpagesData = zpagesResponse.ok ? await zpagesResponse.json() : { results: [], count: 0, next: null, previous: null };
      }

      return {
        creator,
        zpages: zpagesData,
        tags,
        type: 'creator',
        isOwner,
      };
    } else if (creatorResponse.status === 404) {
      // Not a creator, might be a zpage or doesn't exist
      // Let the backend handle this route since it might be a zpage
      throw error(404, { message: 'Not found', code: 404 });
    } else {
      // Some other error occurred
      console.error(
        'Creator API response error:',
        creatorResponse.status
      );
      throw error(500, { message: 'Server error', code: 500 });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error loading creator profile:', message);
    // If it's already a SvelteKit error, re-throw it
    if (err && typeof err === 'object' && 'status' in err) {
      throw err;
    }
    throw error(404, { message: 'Creator not found', code: 404 });
  }
};
