import { zpageList } from '$lib/api/zpage/zpage';
import { creatorList } from '$lib/api/creator/creator';
import { env } from '$env/dynamic/private';

// Calculate date one week ago
function getOneWeekAgo(): string {
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  return oneWeekAgo.toISOString().split('T')[0]; // YYYY-MM-DD format
}

// Find the best hero article with featured image
function findHeroStory(articles: any[]): any | null {
  // Look for articles with featured images
  const articlesWithImages = articles.filter(
    (article) =>
      article.featured_image &&
      (article.featured_image.url || article.featured_image.thumbnail)
  );

  if (articlesWithImages.length > 0) {
    // Return the highest scoring article with an image
    return articlesWithImages[0];
  }

  return null;
}

// server-side load receives an event; forward incoming cookies so backend
// can authenticate the request if the user has a session cookie or token.
export async function load(event) {
  try {
    console.log('Fetching trending and hero story...');
    const cookie = event.request?.headers?.get('cookie');
    const oneWeekAgo = getOneWeekAgo();
    const apiBase = env.PRIVATE_API_BASE_URL || '';
    // Hero: the 20 newest pages that have a featured image. Any homeSort
    // value makes the backend exclude pages without images, and the DRF
    // `ordering` param is applied after it, so this combo means
    // "newest-first, images only".
    //
    // NOTE: /api/zpage/ has no date filterset — params like
    // created_at__gte are silently IGNORED by DRF, which is how the old
    // version served random all-time articles as "recent". Recency is
    // therefore applied client-side below.
    let heroStory = null;
    try {
      const heroResponse = await zpageList(
        {
          homeSort: 'score',
          ordering: '-created_at',
          page: 1,
          page_size: 20,
        } as any,
        {
          headers: cookie ? { cookie } : undefined,
        }
      );

      const candidates = heroResponse.results || [];
      // Prefer this week's articles; if the week was quiet, fall back to
      // the newest image-bearing articles overall. ISO strings compare
      // lexicographically, so >= works on created_at vs YYYY-MM-DD.
      const recent = candidates.filter(
        (a) => (a.created_at || '') >= oneWeekAgo
      );
      const pool = recent.length > 0 ? recent : candidates;
      const byScore = [...pool].sort(
        (a, b) => Number(b.f2z_score || 0) - Number(a.f2z_score || 0)
      );
      heroStory = findHeroStory(byScore);
      console.log(
        'Hero story found:',
        heroStory?.title || 'None with image',
        recent.length > 0 ? '(this week)' : '(fallback: newest overall)'
      );
    } catch (error) {
      console.log('Hero fetch failed:', error);
    }

    // Get regular trending articles for the Top Stories section
    const trendingResponse = await zpageList(
      {
        homeSort: 'updated',
        page: 1,
        page_size: 20,
      } as any,
      {
        headers: cookie ? { cookie } : undefined,
      }
    );

    // Popular Reads: recency-decayed popularity (#528) rather than all-time
    // f2z_score, so the front page doesn't get permanently owned by 2022
    // content. homeSort=popular also drops imageless pages (cards need art).
    const popularParams = {
      homeSort: 'popular',
      page: 1,
      // Let Django use its default page_size, then slice first 5
    };

    console.log('=== POPULAR API CALL DEBUG ===');
    console.log('Parameters being sent to zpageList:', popularParams);

    const popularResponse = await zpageList(popularParams as any, {
      headers: cookie ? { cookie } : undefined,
      baseURL: '', // Override to use Django backend directly
    });

    console.log(
      'Popular articles by f2z_score fetched:',
      popularResponse.results?.length || 0
    );

    // DEBUG: Log the actual f2z_score values and titles from backend
    console.log('=== POPULAR ZPAGE DEBUG ===');
    const popularResults = popularResponse.results || [];
    popularResults.slice(0, 10).forEach((article, index) => {
      console.log(
        `${index + 1}. "${article.title}" - f2z_score: ${article.f2z_score} - vanity: ${article.vanity || article.free2zaddr}`
      );
    });
    console.log('=== END POPULAR DEBUG ===');

    // Filter out the hero story from trending to avoid duplication
    const trending = (trendingResponse.results || []).filter(
      (article) => !heroStory || article.free2zaddr !== heroStory.free2zaddr
    );

    // Use the top 5 f2z_score articles from the first page (slice first 5)
    const popular = (popularResponse.results || []).slice(0, 4);

    console.log('Hero story:', heroStory?.title || 'None');
    console.log('Trending count:', trending.length);
    console.log('Popular zPages count (top 5 by f2z_score):', popular.length);
    console.log(
      'Popular zPages titles being sent to frontend:',
      popular.map((p) => `"${p.title}" (f2z_score: ${p.f2z_score})`)
    );

    // Fetch creators
    const creatorsResponse = await creatorList(
      {
        page: 1,
        page_size: 8,
      } as any,
      {
        headers: cookie ? { cookie } : undefined,
        baseURL: apiBase,
      }
    );
    const creators = creatorsResponse.results || [];

    return {
      heroStory,
      trending,
      popular,
      creators,
    };
  } catch (error) {
    console.error('Failed to load homepage data', error);
    return {
      heroStory: null,
      trending: [],
      popular: [],
      creators: [],
    };
  }
}
