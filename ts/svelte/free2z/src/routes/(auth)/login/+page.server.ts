import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';

function getSafeNextPath(next: string | null): string | null {
    if (!next) return null;

    // Prevent open redirects; only allow same-site absolute paths.
    if (!next.startsWith('/') || next.startsWith('//')) {
        return null;
    }

    return next;
}

export const load: PageServerLoad = async ({ fetch, request, url }) => {
    const nextPath = getSafeNextPath(url.searchParams.get('next'));
    const apiBase = env.PRIVATE_API_BASE_URL || '';

    try {
        const cookieHeader = request.headers.get('cookie') || '';
        const userResponse = await fetch(`${apiBase}/api/auth/user/`, {
            headers: {
                cookie: cookieHeader,
            },
        });

        if (userResponse.ok) {
            throw redirect(302, nextPath || '/');
        }
    } catch (err: any) {
        if (err?.status === 302) {
            throw err;
        }

        // If auth check fails, allow the page to render so user can log in.
    }

    return {};
};
