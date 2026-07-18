import { env } from '$env/dynamic/private';
import { error } from '@sveltejs/kit';
import { Resvg } from '@resvg/resvg-js';
import type { RequestHandler } from './$types';

type OgArticle = {
  title?: string;
  description?: string;
  content?: string;
  category?: string;
  creator?: { username?: string };
  featured_image?: { url?: string; thumbnail?: string };
};

const WIDTH = 1200;
const HEIGHT = 630;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plainText(value?: string, maxLength = 180) {
  const text = (value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[#*_>`~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function wrap(value: string, maxCharacters: number, maxLines: number) {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxCharacters || !line) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines - 1) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const consumed = lines.join(' ').length;
  if (consumed < value.length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.,;:!?]?$/, '')}…`;
  }
  return lines;
}

async function imageDataUri(fetch: typeof globalThis.fetch, source: string | undefined, base: URL) {
  if (!source) return null;
  try {
    const target = new URL(source, base);
    if (!['http:', 'https:'].includes(target.protocol)) return null;
    const response = await fetch(target);
    if (!response.ok) return null;
    const type = response.headers.get('content-type')?.split(';')[0] || '';
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (!SUPPORTED_IMAGE_TYPES.has(type) || declaredLength > MAX_IMAGE_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES) return null;
    return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
  } catch {
    return null;
  }
}

function buildSvg(article: OgArticle, cover: string | null) {
  const title = plainText(article.title, 125) || 'A story on Free2Z';
  const subtitle = plainText(article.description || article.content, 190) ||
    'Independent publishing and direct creator support.';
  const titleLines = wrap(title, cover ? 18 : 34, 3);
  const subtitleLines = wrap(subtitle, cover ? 34 : 68, 2);
  const titleSize = titleLines.length >= 3 ? 51 : titleLines.length === 2 ? 57 : 64;
  const titleStart = titleLines.length === 1 ? 270 : titleLines.length === 2 ? 245 : 225;
  const author = escapeXml(article.creator?.username ? `@${article.creator.username}` : 'Free2Z creator');
  const category = escapeXml(plainText(article.category, 30) || 'STORY');
  const titleSvg = titleLines
    .map((line, index) => `<text x="74" y="${titleStart + index * (titleSize + 9)}" class="title">${escapeXml(line)}</text>`)
    .join('');
  const subtitleStart = titleStart + titleLines.length * (titleSize + 9) + 30;
  const subtitleSvg = subtitleLines
    .map((line, index) => `<text x="77" y="${subtitleStart + index * 31}" class="subtitle">${escapeXml(line)}</text>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#09090b"/><stop offset="1" stop-color="#17171b"/></linearGradient>
      <linearGradient id="coverFade" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#0a0a0c"/><stop offset=".28" stop-color="#0a0a0c" stop-opacity=".88"/><stop offset=".72" stop-color="#0a0a0c" stop-opacity=".18"/><stop offset="1" stop-color="#0a0a0c" stop-opacity=".08"/></linearGradient>
      <linearGradient id="fallbackGlow" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#84cc16" stop-opacity=".24"/><stop offset="1" stop-color="#84cc16" stop-opacity="0"/></linearGradient>
      <pattern id="grid" width="54" height="54" patternUnits="userSpaceOnUse"><path d="M54 0H0V54" fill="none" stroke="#f4f4f5" stroke-opacity=".055"/></pattern>
      <clipPath id="frame"><rect width="1200" height="630" rx="30"/></clipPath>
      <style>.title{font-family:Arial,sans-serif;font-size:${titleSize}px;font-weight:700;fill:#f4f4f5;letter-spacing:-1.8px}.subtitle{font-family:Arial,sans-serif;font-size:23px;font-weight:400;fill:#d4d4d8}.meta{font-family:Arial,sans-serif;font-size:18px;font-weight:700;letter-spacing:1.8px}.small{font-family:Arial,sans-serif;font-size:18px;font-weight:600}</style>
    </defs>
    <g clip-path="url(#frame)">
      <rect width="1200" height="630" fill="url(#bg)"/>
      ${cover
        ? `<image href="${cover}" x="510" width="690" height="630" preserveAspectRatio="xMidYMid slice"/><rect width="1200" height="630" fill="url(#coverFade)"/>`
        : `<rect x="610" width="590" height="630" fill="url(#grid)"/><circle cx="1015" cy="180" r="230" fill="url(#fallbackGlow)"/><path d="M720 520C835 450 925 475 1095 265" fill="none" stroke="#a3e635" stroke-opacity=".45" stroke-width="3" stroke-dasharray="7 12"/>`}
      <rect x="0" width="8" height="630" fill="#a3e635"/>
      <text x="72" y="121" font-family="Arial,sans-serif" font-size="58" font-weight="700" fill="#A3E635" letter-spacing="-2">Free2Z</text>
      <text x="75" y="170" class="meta" fill="#a3e635">${category}</text>
      ${titleSvg}
      ${subtitleSvg}
      <line x1="76" y1="548" x2="520" y2="548" stroke="#a3e635" stroke-opacity=".48"/>
      <text x="76" y="586" class="small" fill="#f4f4f5">${author}</text>
      <text x="1124" y="586" class="small" fill="#a3e635" text-anchor="end">FREE2Z.CASH</text>
    </g>
    <rect x=".5" y=".5" width="1199" height="629" rx="29.5" fill="none" stroke="#f4f4f5" stroke-opacity=".12"/>
  </svg>`;
}

export const GET: RequestHandler = async ({ params, fetch, url, setHeaders }) => {
  const id = params.id?.trim();
  if (!id || id.length > 160) {
    throw error(400, { message: 'Invalid ZPage identifier', code: 400 });
  }

  const apiBase = env.PRIVATE_API_BASE_URL?.replace(/\/$/, '') || url.origin;
  const response = await fetch(`${apiBase}/api/zpage/${encodeURIComponent(id)}/`);
  if (!response.ok) {
    const status = response.status === 404 ? 404 : 502;
    throw error(status, { message: 'Unable to load ZPage', code: status });
  }
  const article = (await response.json()) as OgArticle;
  const mediaBase = new URL(`${apiBase}/`);
  const coverSource = article.featured_image?.url || article.featured_image?.thumbnail;
  const cover = await imageDataUri(fetch, coverSource, mediaBase);

  const png = new Resvg(buildSvg(article, cover), {
    fitTo: { mode: 'width', value: WIDTH },
  }).render().asPng();

  setHeaders({
    'cache-control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
    'content-type': 'image/png',
    'content-length': png.byteLength.toString(),
    'x-content-type-options': 'nosniff',
  });
  return new Response(Uint8Array.from(png).buffer);
};
