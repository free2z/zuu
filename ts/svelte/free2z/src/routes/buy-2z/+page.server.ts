import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

const DEFAULT_API_BASE = 'http://localhost:8000';
const CHECKOUT_REF_PATTERN = /^[a-zA-Z0-9_-]{3,128}$/;

export const load: PageServerLoad = async ({ cookies, fetch, url }) => {
    const apiBase = env.PRIVATE_API_BASE_URL || DEFAULT_API_BASE;
    const sessionId = cookies.get('sessionid');

    if (!sessionId) {
        throw redirect(302, '/?login=true');
    }

    const userResponse = await fetch(`${apiBase}/api/auth/user/`, {
        headers: {
            Cookie: `sessionid=${sessionId}`,
        },
    });

    if (!userResponse.ok) {
        throw redirect(302, '/?login=true');
    }

    const currentUser = await userResponse.json();
    const username = currentUser?.username;

    if (!username) {
        throw redirect(302, '/?login=true');
    }

    const destinationParams = new URLSearchParams();
    const method = url.searchParams.get('method');
    const checkoutRef = url.searchParams.get('ref');

    if (method === 'stripe' || method === 'zcash') {
        destinationParams.set('tab', method);
    }

    if (checkoutRef && CHECKOUT_REF_PATTERN.test(checkoutRef)) {
        destinationParams.set('checkoutRef', checkoutRef);
    }

    const query = destinationParams.toString();
    const destination = query
        ? `/${username}/dashboard/billing?${query}`
        : `/${username}/dashboard/billing`;

    throw redirect(302, destination);
};
