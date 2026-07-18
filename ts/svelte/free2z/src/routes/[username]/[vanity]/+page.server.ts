import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, request, fetch }) => {
  try {
    const { vanity } = params;

    console.log('Fetching article by vanity:', vanity);
    const cookie = request?.headers?.get('cookie');
    const apiBase = env.PRIVATE_API_BASE_URL || '';

    // Use the direct vanity endpoint to get the full article content
    const response = await fetch(
      `${apiBase}/api/zpage/${vanity}/`,
      {
        headers: cookie ? { cookie } : undefined,
      }
    );

    if (!response.ok) {
      throw error(404, { message: 'Article not found', code: 404 });
    }

    const article = await response.json();

    console.log(
      'Full article loaded with content length:',
      article.content?.length || 0
    );

    return {
      article,
      username: params.username,
      vanity,
    };
  } catch (err) {
    console.error('Failed to load article', err);
    throw error(404, { message: 'Article not found', code: 404 });
  }
};
