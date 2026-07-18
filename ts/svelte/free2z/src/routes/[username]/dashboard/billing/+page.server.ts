import type { Actions, PageServerLoad } from './$types';
import { error, fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

const DEFAULT_API_BASE = 'http://localhost:8000';
const DEFAULT_PAGE_SIZE = 10;
const MAX_CHECKOUT_QUANTITY = 1_000_000;
const MAX_SUBSCRIPTION_MAX_PRICE = 1_000_000;
const ACTION_COOLDOWN_MS = 1500;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{1,64}$/;
const CHECKOUT_REF_PATTERN = /^[a-zA-Z0-9_-]{3,128}$/;

function getSessionCookie(cookies: { get: (name: string) => string | undefined }) {
    return cookies.get('sessionid');
}

function getCsrfCookie(cookies: { get: (name: string) => string | undefined }) {
    return cookies.get('csrftoken');
}

function buildBackendHeaders(
    sessionId: string,
    opts?: {
        csrfToken?: string;
        contentType?: string;
    }
) {
    const csrfToken = opts?.csrfToken;
    const cookieHeader = csrfToken
        ? `sessionid=${sessionId}; csrftoken=${csrfToken}`
        : `sessionid=${sessionId}`;

    const headers: Record<string, string> = {
        Cookie: cookieHeader,
    };

    if (opts?.contentType) {
        headers['Content-Type'] = opts.contentType;
    }

    if (csrfToken) {
        headers['X-CSRFToken'] = csrfToken;
    }

    return headers;
}

function missingCsrfFailure(action: 'checkout' | 'updateSubscription' | 'unsubscribe') {
    return fail(403, {
        action,
        error: 'Your session security token is missing. Please refresh the page and try again. If the issue continues, sign in again.',
    });
}

function validateStarUsername(value: string) {
    return USERNAME_PATTERN.test(value);
}

function getCheckoutRef(value: string | null) {
    if (!value) {
        return '';
    }

    return CHECKOUT_REF_PATTERN.test(value) ? value : '';
}

function getPostedCheckoutRef(value: FormDataEntryValue | null) {
    const checkoutRef = typeof value === 'string' ? value.trim() : '';

    if (!checkoutRef) {
        return { checkoutRef: '', isValid: true };
    }

    return {
        checkoutRef: CHECKOUT_REF_PATTERN.test(checkoutRef) ? checkoutRef : '',
        isValid: CHECKOUT_REF_PATTERN.test(checkoutRef),
    };
}

function buildBillingPath(username: string, checkoutRef: string) {
    const query = new URLSearchParams();

    if (checkoutRef) {
        query.set('checkoutRef', checkoutRef);
    }

    const queryString = query.toString();
    return queryString
        ? `/${username}/dashboard/billing?${queryString}`
        : `/${username}/dashboard/billing`;
}

function getCooldownRemainingMs(
    cookies: { get: (name: string) => string | undefined; set: (name: string, value: string, opts: { path: string; sameSite: 'lax'; maxAge: number; httpOnly: boolean }) => void },
    key: string,
    cooldownMs: number
) {
    const now = Date.now();
    const lastRaw = cookies.get(key);
    const last = Number.parseInt(lastRaw || '0', 10);

    if (Number.isFinite(last) && now - last < cooldownMs) {
        return cooldownMs - (now - last);
    }

    cookies.set(key, String(now), {
        path: '/',
        sameSite: 'lax',
        maxAge: 60,
        httpOnly: true,
    });
    return 0;
}

async function requireDashboardOwner(
    fetchFn: typeof fetch,
    apiBase: string,
    sessionId: string,
    username: string
) {
    const userResponse = await fetchFn(`${apiBase}/api/auth/user/`, {
        headers: {
            Cookie: `sessionid=${sessionId}`,
        },
    });

    if (!userResponse.ok) {
        throw redirect(302, '/?login=true');
    }

    const currentUser = await userResponse.json();
    if (currentUser.username !== username) {
        throw error(403, {
            message: 'You can only access your own billing dashboard',
            code: 403,
        });
    }

    return currentUser;
}

async function safeJson(fetchFn: typeof fetch, url: string, sessionId: string) {
    const response = await fetchFn(url, {
        headers: {
            Cookie: `sessionid=${sessionId}`,
        },
    });

    if (!response.ok) {
        return { count: 0, next: null, previous: null, results: [] };
    }

    return response.json();
}

export const load: PageServerLoad = async ({ params, cookies, fetch, url }) => {
    const apiBase = env.PRIVATE_API_BASE_URL || DEFAULT_API_BASE;
    const sessionId = getSessionCookie(cookies);

    if (!sessionId) {
        throw redirect(302, '/?login=true');
    }

    const subscriptionsPage = Math.max(1, Number.parseInt(url.searchParams.get('subPage') || '1', 10) || 1);
    const transactionsPage = Math.max(1, Number.parseInt(url.searchParams.get('txPage') || '1', 10) || 1);
    const subscribersPage = Math.max(1, Number.parseInt(url.searchParams.get('fanPage') || '1', 10) || 1);
    const subscriptionOrdering = url.searchParams.get('subOrder') === 'expires' ? 'expires' : '-max_price';
    const subscriberOrdering = url.searchParams.get('fanOrder') === 'expires' ? 'expires' : '-max_price';
    const checkoutRef = getCheckoutRef(url.searchParams.get('checkoutRef'));

    try {
        const creator = await requireDashboardOwner(fetch, apiBase, sessionId, params.username);

        const subscriptionsQuery = new URLSearchParams({
            page: String(subscriptionsPage),
            ordering: subscriptionOrdering,
        });
        const subscribersQuery = new URLSearchParams({
            page: String(subscribersPage),
            ordering: subscriberOrdering,
        });
        const transactionsQuery = new URLSearchParams({
            page: String(transactionsPage),
        });

        const [subscriptions, transactions, subscribers] = await Promise.all([
            safeJson(fetch, `${apiBase}/api/tuzis/my-subscriptions?${subscriptionsQuery.toString()}`, sessionId),
            safeJson(fetch, `${apiBase}/api/stripe/transactions/?${transactionsQuery.toString()}`, sessionId),
            safeJson(fetch, `${apiBase}/api/tuzis/my-subscribers?${subscribersQuery.toString()}`, sessionId),
        ]);

        return {
            creator,
            subscriptions,
            transactions,
            subscribers,
            subscriptionOrdering,
            subscriberOrdering,
            subscriptionsPage,
            transactionsPage,
            subscribersPage,
            checkoutRef,
            pageSize: DEFAULT_PAGE_SIZE,
        };
    } catch (err: any) {
        console.error('Error loading billing dashboard:', {
            status: err?.status,
            name: err?.name,
            message: err?.message,
        });
        if (err?.status) {
            throw err;
        }
        throw error(500, { message: 'Failed to load billing dashboard', code: 500 });
    }
};

export const actions: Actions = {
    checkout: async ({ params, request, cookies, fetch }) => {
        const apiBase = env.PRIVATE_API_BASE_URL || DEFAULT_API_BASE;
        const sessionId = getSessionCookie(cookies);
        const csrfToken = getCsrfCookie(cookies);

        if (!sessionId) {
            throw redirect(302, '/?login=true');
        }

        if (!csrfToken) {
            return missingCsrfFailure('checkout');
        }

        await requireDashboardOwner(fetch, apiBase, sessionId, params.username);

        const checkoutCooldown = getCooldownRemainingMs(
            cookies,
            `billing_checkout_${params.username}`,
            ACTION_COOLDOWN_MS
        );
        if (checkoutCooldown > 0) {
            return fail(429, {
                action: 'checkout',
                error: 'Please wait a moment before starting another checkout.',
            });
        }

        const formData = await request.formData();
        const quantityRaw = formData.get('quantity');
        const quantity = Number.parseInt(String(quantityRaw || ''), 10);
        const postedCheckoutRef = getPostedCheckoutRef(formData.get('checkoutRef'));

        if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_CHECKOUT_QUANTITY) {
            return fail(400, {
                action: 'checkout',
                error: `Enter a valid 2Z amount between 1 and ${MAX_CHECKOUT_QUANTITY.toLocaleString()}.`,
            });
        }

        if (!postedCheckoutRef.isValid) {
            return fail(400, {
                action: 'checkout',
                error: 'Invalid checkout reference.',
            });
        }

        try {
            const checkoutPayload: {
                quantity: number;
                currentPath: string;
                checkoutRef?: string;
            } = {
                quantity,
                currentPath: buildBillingPath(params.username, postedCheckoutRef.checkoutRef),
            };

            if (postedCheckoutRef.checkoutRef) {
                checkoutPayload.checkoutRef = postedCheckoutRef.checkoutRef;
            }

            const checkoutResponse = await fetch(`${apiBase}/api/stripe/create-checkout-session/`, {
                method: 'POST',
                headers: buildBackendHeaders(sessionId, {
                    csrfToken,
                    contentType: 'application/json',
                }),
                body: JSON.stringify(checkoutPayload),
            });

            const payload = await checkoutResponse.json().catch(() => ({}));

            if (!checkoutResponse.ok || !payload?.id) {
                return fail(checkoutResponse.status || 400, {
                    action: 'checkout',
                    error: payload?.error || 'Unable to start Stripe checkout.',
                });
            }

            return {
                action: 'checkout',
                success: 'Redirecting to Stripe checkout…',
                checkoutSessionId: payload.id,
            };
        } catch (err) {
            console.error('Checkout action failed:', err);
            return fail(500, {
                action: 'checkout',
                error: 'Failed to start checkout session.',
            });
        }
    },

    updateSubscription: async ({ params, request, cookies, fetch }) => {
        const apiBase = env.PRIVATE_API_BASE_URL || DEFAULT_API_BASE;
        const sessionId = getSessionCookie(cookies);
        const csrfToken = getCsrfCookie(cookies);

        if (!sessionId) {
            throw redirect(302, '/?login=true');
        }

        if (!csrfToken) {
            return missingCsrfFailure('updateSubscription');
        }

        const currentUser = await requireDashboardOwner(fetch, apiBase, sessionId, params.username);

        const updateCooldown = getCooldownRemainingMs(
            cookies,
            `billing_update_${params.username}`,
            ACTION_COOLDOWN_MS
        );
        if (updateCooldown > 0) {
            return fail(429, {
                action: 'updateSubscription',
                error: 'Please wait a moment before updating again.',
            });
        }

        const formData = await request.formData();
        const starUsername = String(formData.get('starUsername') || '').trim();
        const maxPriceRaw = formData.get('maxPrice');
        const maxPrice = Number.parseInt(String(maxPriceRaw || ''), 10);
        const memberPriceRaw = Number.parseInt(String(formData.get('memberPrice') || '1'), 10);
        const memberPriceFloor = Number.isFinite(memberPriceRaw) && memberPriceRaw >= 1 ? memberPriceRaw : 1;

        if (!starUsername || !validateStarUsername(starUsername)) {
            return fail(400, {
                action: 'updateSubscription',
                error: 'Invalid subscription username.',
            });
        }

        if (!Number.isInteger(maxPrice) || maxPrice < 1 || maxPrice > MAX_SUBSCRIPTION_MAX_PRICE) {
            return fail(400, {
                action: 'updateSubscription',
                error: `Enter a valid max monthly amount between 1 and ${MAX_SUBSCRIPTION_MAX_PRICE.toLocaleString()}.`,
            });
        }

        if (maxPrice < memberPriceFloor) {
            return fail(400, {
                action: 'updateSubscription',
                error: `Max monthly amount must be at least ${memberPriceFloor.toLocaleString()} 2Z (the creator's member price).`,
            });
        }

        if (maxPrice > currentUser.tuzis) {
            return fail(400, {
                action: 'updateSubscription',
                error: `Max monthly amount cannot exceed your current balance of ${(currentUser.tuzis as number).toLocaleString()} 2Z.`,
            });
        }

        try {
            const updateResponse = await fetch(`${apiBase}/api/tuzis/subscribe/${starUsername}`, {
                method: 'PATCH',
                headers: buildBackendHeaders(sessionId, {
                    csrfToken,
                    contentType: 'application/json',
                }),
                body: JSON.stringify({ max_price: String(maxPrice) }),
            });

            const payload = await updateResponse.json().catch(() => ({}));

            if (!updateResponse.ok) {
                return fail(updateResponse.status || 400, {
                    action: 'updateSubscription',
                    error: payload?.error || `Unable to update @${starUsername}.`,
                });
            }

            return {
                action: 'updateSubscription',
                success: `Updated max monthly amount for @${starUsername}.`,
            };
        } catch (err) {
            console.error('Update subscription action failed:', err);
            return fail(500, {
                action: 'updateSubscription',
                error: 'Failed to update subscription.',
            });
        }
    },

    unsubscribe: async ({ params, request, cookies, fetch }) => {
        const apiBase = env.PRIVATE_API_BASE_URL || DEFAULT_API_BASE;
        const sessionId = getSessionCookie(cookies);
        const csrfToken = getCsrfCookie(cookies);

        if (!sessionId) {
            throw redirect(302, '/?login=true');
        }

        if (!csrfToken) {
            return missingCsrfFailure('unsubscribe');
        }

        await requireDashboardOwner(fetch, apiBase, sessionId, params.username);

        const unsubscribeCooldown = getCooldownRemainingMs(
            cookies,
            `billing_unsubscribe_${params.username}`,
            ACTION_COOLDOWN_MS
        );
        if (unsubscribeCooldown > 0) {
            return fail(429, {
                action: 'unsubscribe',
                error: 'Please wait a moment before retrying unsubscribe.',
            });
        }

        const formData = await request.formData();
        const starUsername = String(formData.get('starUsername') || '').trim();

        if (!starUsername || !validateStarUsername(starUsername)) {
            return fail(400, {
                action: 'unsubscribe',
                error: 'Invalid subscription username.',
            });
        }

        try {
            const unsubscribeResponse = await fetch(`${apiBase}/api/tuzis/subscribe/${starUsername}`, {
                method: 'DELETE',
                headers: buildBackendHeaders(sessionId, { csrfToken }),
            });

            if (!unsubscribeResponse.ok) {
                const payload = await unsubscribeResponse.json().catch(() => ({}));
                return fail(unsubscribeResponse.status || 400, {
                    action: 'unsubscribe',
                    error: payload?.error || `Unable to unsubscribe from @${starUsername}.`,
                });
            }

            return {
                action: 'unsubscribe',
                success: `Subscription for @${starUsername} will not renew.`,
            };
        } catch (err) {
            console.error('Unsubscribe action failed:', err);
            return fail(500, {
                action: 'unsubscribe',
                error: 'Failed to unsubscribe.',
            });
        }
    },
};
