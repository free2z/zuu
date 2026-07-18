import { zpageRetrieve } from '$lib/api/zpage/zpage';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, request }) => {
  try {
    const id = parseInt(params.id);
    if (isNaN(id)) {
      throw error(404, { message: 'Article not found', code: 404 });
    }

    console.log('Fetching article:', id);
    const cookie = request?.headers?.get('cookie');

    const article = await zpageRetrieve(id, {
      headers: cookie ? { cookie } : undefined,
    });

    console.log('Article loaded:', article);
    return {
      article,
    };
  } catch (err) {
    console.error('Failed to load article', err);
    throw error(404, { message: 'Article not found', code: 404 });
  }
};
