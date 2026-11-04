import type { Actions, PageServerLoad } from "./$types";
import { error, fail, redirect } from "@sveltejs/kit";
import { loginDestination } from "$lib/login-destination";
import { fetchPricing } from "$lib/pricing";
import { ACCOUNT_BALANCE_DEPENDENCY } from "$lib/account-balance";
import { isSubscriptionUsername } from "$lib/subscription-username";
import { usableClientId } from "$lib/sdk-flow";
import {
  authenticatedBackendMutation,
  BackendBridgeError,
  getApiBase,
  getCsrfCookie,
  getSessionCookie,
  logBackendFailure,
  readBackendFailure,
  requireAuthenticatedUser,
} from "$lib/server/backend";

const DEFAULT_PAGE_SIZE = 10;
const MAX_CHECKOUT_QUANTITY = 1_000_000;

function isStripeHostedCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "checkout.stripe.com" &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}
const MAX_SUBSCRIPTION_MAX_PRICE = 1_000_000;
const ACTION_COOLDOWN_MS = 1500;
const RENEWAL_SUMMARY_TIMEOUT_MS = 5_000;
const CHECKOUT_REF_PATTERN = /^[a-zA-Z0-9_-]{3,128}$/;
// Module-level and shared by every request that falls back, so it is frozen:
// a mutation here would poison the summary for every later visitor.
const EMPTY_RENEWAL_SUMMARY = Object.freeze({
  status: "unknown",
  balance: null,
  total_upcoming: null,
  shortfall: null,
  next_renewal: null,
});

function missingCsrfFailure(
  action: "checkout" | "updateSubscription" | "unsubscribe",
) {
  return fail(403, {
    action,
    ok: false,
    messageKey: "dashboard.billing.errors.missingSecurityToken",
    messageParams: {},
  });
}

// Django's username rule, not a narrower one: a stricter client pattern made
// Unsubscribe impossible for creators named like `jane-doe`.
function validateStarUsername(value: string) {
  return isSubscriptionUsername(value);
}

function getCheckoutRef(value: string | null) {
  if (!value) {
    return "";
  }

  return CHECKOUT_REF_PATTERN.test(value) ? value : "";
}

function getPostedCheckoutRef(value: FormDataEntryValue | null) {
  const checkoutRef = typeof value === "string" ? value.trim() : "";

  if (!checkoutRef) {
    return { checkoutRef: "", isValid: true };
  }

  return {
    checkoutRef: CHECKOUT_REF_PATTERN.test(checkoutRef) ? checkoutRef : "",
    isValid: CHECKOUT_REF_PATTERN.test(checkoutRef),
  };
}

function buildBillingPath(
  username: string,
  checkoutRef: string,
  app: string | null,
) {
  const query = new URLSearchParams();
  // A card checkout returns to the Card tab; the page otherwise opens on
  // Zcash.
  query.set("tab", "stripe");

  if (checkoutRef) {
    query.set("checkoutRef", checkoutRef);
  }

  // An app's visitor (`/buy-2z?client_id=`) comes back from Stripe still
  // told to go back to their app. A representation hint only: an unusable
  // value is dropped, never a reason to refuse the checkout.
  if (app) {
    query.set("app", app);
  }

  return `/${username}/dashboard/billing?${query.toString()}`;
}

function getCooldownRemainingMs(
  cookies: {
    get: (name: string) => string | undefined;
    set: (
      name: string,
      value: string,
      opts: {
        path: string;
        sameSite: "lax";
        maxAge: number;
        httpOnly: boolean;
      },
    ) => void;
  },
  key: string,
  cooldownMs: number,
) {
  const now = Date.now();
  const lastRaw = cookies.get(key);
  const last = Number.parseInt(lastRaw || "0", 10);

  if (Number.isFinite(last) && now - last < cooldownMs) {
    return cooldownMs - (now - last);
  }

  cookies.set(key, String(now), {
    path: "/",
    sameSite: "lax",
    maxAge: 60,
    httpOnly: true,
  });
  return 0;
}

async function requireDashboardOwner(
  fetchFn: typeof fetch,
  cookies: { get: (name: string) => string | undefined },
  username: string,
  returnTo: string,
) {
  // 401/403 -> /login; a backend 5xx, 429 or timeout -> 503.
  const currentUser = await requireAuthenticatedUser<any>(
    fetchFn,
    cookies,
    returnTo,
  );
  if (currentUser.username !== username) {
    throw error(403, "errors.dashboard.billingForbidden", { code: 403 });
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

async function safeRenewalSummaryJson(
  fetchFn: typeof fetch,
  url: string,
  sessionId: string,
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    RENEWAL_SUMMARY_TIMEOUT_MS,
  );

  try {
    const response = await fetchFn(url, {
      headers: {
        Cookie: `sessionid=${sessionId}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return EMPTY_RENEWAL_SUMMARY;
    }

    return await response.json();
  } catch {
    // This indicator is supplementary to the billing page. A transient
    // backend/network failure, including a hung request, must not turn the
    // whole dashboard into a 500; the UI will render its fail-closed
    // "unknown" state instead.
    return EMPTY_RENEWAL_SUMMARY;
  } finally {
    clearTimeout(timeoutId);
  }
}

export const load: PageServerLoad = async ({
  params,
  cookies,
  fetch,
  url,
  setHeaders,
  depends,
}) => {
  depends(ACCOUNT_BALANCE_DEPENDENCY);
  const apiBase = getApiBase();
  const sessionId = getSessionCookie(cookies);

  if (!sessionId) {
    throw redirect(302, loginDestination(url.pathname + url.search));
  }
  setHeaders({ "cache-control": "private, no-cache", vary: "Cookie" });

  const subscriptionsPage = Math.max(
    1,
    Number.parseInt(url.searchParams.get("subPage") || "1", 10) || 1,
  );
  const transactionsPage = Math.max(
    1,
    Number.parseInt(url.searchParams.get("txPage") || "1", 10) || 1,
  );
  const subscribersPage = Math.max(
    1,
    Number.parseInt(url.searchParams.get("fanPage") || "1", 10) || 1,
  );
  const subscriptionOrdering =
    url.searchParams.get("subOrder") === "expires" ? "expires" : "-max_price";
  const subscriberOrdering =
    url.searchParams.get("fanOrder") === "expires" ? "expires" : "-max_price";
  const checkoutRef = getCheckoutRef(url.searchParams.get("checkoutRef"));

  try {
    const creator = await requireDashboardOwner(
      fetch,
      cookies,
      params.username,
      url.pathname + url.search,
    );

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

    const [subscriptions, transactions, subscribers, renewalSummary, pricing] =
      await Promise.all([
        safeJson(
          fetch,
          `${apiBase}/api/tuzis/my-subscriptions?${subscriptionsQuery.toString()}`,
          sessionId,
        ),
        safeJson(
          fetch,
          `${apiBase}/api/stripe/transactions/?${transactionsQuery.toString()}`,
          sessionId,
        ),
        safeJson(
          fetch,
          `${apiBase}/api/tuzis/my-subscribers?${subscribersQuery.toString()}`,
          sessionId,
        ),
        safeRenewalSummaryJson(
          fetch,
          `${apiBase}/api/tuzis/my-subscriptions-summary`,
          sessionId,
        ),
        fetchPricing(fetch, apiBase),
      ]);

    return {
      creator,
      subscriptions,
      transactions,
      subscribers,
      renewalSummary,
      pricing,
      subscriptionOrdering,
      subscriberOrdering,
      subscriptionsPage,
      transactionsPage,
      subscribersPage,
      checkoutRef,
      pageSize: DEFAULT_PAGE_SIZE,
    };
  } catch (err: any) {
    console.error("Error loading billing dashboard:", {
      status: err?.status,
      name: err?.name,
      message: err?.message,
    });
    if (err?.status) {
      throw err;
    }
    throw error(500, "errors.dashboard.billingLoadFailed", { code: 500 });
  }
};

export const actions: Actions = {
  checkout: async ({ params, request, cookies, fetch, url }) => {
    const sessionId = getSessionCookie(cookies);
    const csrfToken = getCsrfCookie(cookies);

    if (!sessionId) {
      throw redirect(302, loginDestination(url.pathname));
    }

    if (!csrfToken) {
      return missingCsrfFailure("checkout");
    }

    const verifiedOwner = await requireDashboardOwner(
      fetch,
      cookies,
      params.username,
      url.pathname,
    );

    const checkoutCooldown = getCooldownRemainingMs(
      cookies,
      `billing_checkout_${params.username}`,
      ACTION_COOLDOWN_MS,
    );
    if (checkoutCooldown > 0) {
      return fail(429, {
        action: "checkout",
        ok: false,
        messageKey: "dashboard.billing.errors.checkoutCooldown",
        messageParams: {},
      });
    }

    const formData = await request.formData();
    const originalActorText = String(formData.get("expected_actor_id") || "");
    const originalActor = /^\d+$/.test(originalActorText)
      ? Number(originalActorText)
      : 0;
    if (
      !Number.isSafeInteger(originalActor) ||
      originalActor <= 0 ||
      originalActor !== verifiedOwner.id
    ) {
      return fail(409, {
        action: "checkout",
        ok: false,
        messageKey: "economy.signInAgain",
        messageParams: {},
      });
    }
    const quantityRaw = formData.get("quantity");
    const quantityText = String(quantityRaw || "").trim();
    const quantity = /^\d+$/.test(quantityText)
      ? Number(quantityText)
      : Number.NaN;
    const postedCheckoutRef = getPostedCheckoutRef(formData.get("checkoutRef"));
    const postedApp = formData.get("app");

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_CHECKOUT_QUANTITY
    ) {
      return fail(400, {
        action: "checkout",
        ok: false,
        messageKey: "dashboard.billing.errors.invalidCheckoutAmount",
        messageParams: { minimum: 1, maximum: MAX_CHECKOUT_QUANTITY },
      });
    }

    if (!postedCheckoutRef.isValid) {
      return fail(400, {
        action: "checkout",
        ok: false,
        messageKey: "dashboard.billing.errors.invalidCheckoutReference",
        messageParams: {},
      });
    }

    try {
      const checkoutPayload: {
        quantity: number;
        expected_actor_id: number;
        currentPath: string;
        checkoutRef?: string;
      } = {
        quantity,
        expected_actor_id: originalActor,
        currentPath: buildBillingPath(
          params.username,
          postedCheckoutRef.checkoutRef,
          usableClientId(typeof postedApp === "string" ? postedApp : null),
        ),
      };

      if (postedCheckoutRef.checkoutRef) {
        checkoutPayload.checkoutRef = postedCheckoutRef.checkoutRef;
      }

      const checkoutResponse = await authenticatedBackendMutation({
        fetchFn: fetch,
        cookies,
        requestDestinationOrigin: url.origin,
        initiatingOrigin: request.headers.get("origin") || "",
        path: "/api/stripe/create-checkout-session/",
        method: "POST",
        json: checkoutPayload,
      });

      if (!checkoutResponse.ok) {
        const failure = await readBackendFailure(checkoutResponse);
        logBackendFailure("billing.checkout", failure);
        return fail(failure.status >= 400 ? failure.status : 502, {
          action: "checkout",
          ok: false,
          messageKey:
            failure.kind === "csrf"
              ? "dashboard.billing.errors.securityTokenRejected"
              : "dashboard.billing.errors.stripeCheckoutUnavailable",
          messageParams: {},
        });
      }

      const payload = await checkoutResponse.json().catch(() => ({}));

      const quote = payload?.quote;
      if (
        typeof payload?.id !== "string" ||
        payload.id.length === 0 ||
        !isStripeHostedCheckoutUrl(payload?.url) ||
        !quote ||
        typeof quote.checkout_intent_id !== "string" ||
        !Number.isInteger(quote.tuzis) ||
        quote.tuzis !== quantity ||
        !Number.isInteger(quote.amount_cents) ||
        quote.amount_cents < 1 ||
        quote.currency !== "usd" ||
        typeof quote.pricing_version !== "string" ||
        quote.pricing_version.length === 0
      ) {
        return fail(502, {
          action: "checkout",
          ok: false,
          messageKey: "dashboard.billing.errors.stripeCheckoutUnavailable",
          messageParams: {},
        });
      }

      return {
        action: "checkout",
        ok: true,
        messageKey: "dashboard.billing.exactQuoteReady",
        messageParams: {},
        checkoutActorId: verifiedOwner.id,
        checkoutSessionId: payload.id,
        checkoutUrl: payload.url,
        checkoutQuote: {
          checkoutIntentId: quote.checkout_intent_id,
          tuzis: quote.tuzis,
          amountCents: quote.amount_cents,
          currency: quote.currency,
          pricingVersion: quote.pricing_version,
        },
      };
    } catch (err) {
      const bridgeCode =
        err instanceof BackendBridgeError ? err.code : "unexpected";
      console.error("Checkout action failed", { code: bridgeCode });
      return fail(bridgeCode === "untrusted-origin" ? 403 : 500, {
        action: "checkout",
        ok: false,
        messageKey:
          bridgeCode === "untrusted-origin"
            ? "dashboard.billing.errors.untrustedRequestOrigin"
            : "dashboard.billing.errors.checkoutStartFailed",
        messageParams: {},
      });
    }
  },

  updateSubscription: async ({ params, request, cookies, fetch, url }) => {
    const sessionId = getSessionCookie(cookies);
    const csrfToken = getCsrfCookie(cookies);

    if (!sessionId) {
      throw redirect(302, loginDestination(url.pathname));
    }

    if (!csrfToken) {
      return missingCsrfFailure("updateSubscription");
    }

    const currentUser = await requireDashboardOwner(
      fetch,
      cookies,
      params.username,
      url.pathname,
    );

    const updateCooldown = getCooldownRemainingMs(
      cookies,
      `billing_update_${params.username}`,
      ACTION_COOLDOWN_MS,
    );
    if (updateCooldown > 0) {
      return fail(429, {
        action: "updateSubscription",
        ok: false,
        messageKey: "dashboard.billing.errors.updateCooldown",
        messageParams: {},
      });
    }

    const formData = await request.formData();
    const starUsername = String(formData.get("starUsername") || "").trim();
    const maxPriceRaw = formData.get("maxPrice");
    const maxPrice = Number.parseInt(String(maxPriceRaw || ""), 10);
    const memberPriceRaw = Number.parseInt(
      String(formData.get("memberPrice") || "1"),
      10,
    );
    const memberPriceFloor =
      Number.isFinite(memberPriceRaw) && memberPriceRaw >= 1
        ? memberPriceRaw
        : 1;

    if (!starUsername || !validateStarUsername(starUsername)) {
      return fail(400, {
        action: "updateSubscription",
        ok: false,
        messageKey: "dashboard.billing.errors.invalidSubscriptionUsername",
        messageParams: {},
      });
    }

    if (
      !Number.isInteger(maxPrice) ||
      maxPrice < 1 ||
      maxPrice > MAX_SUBSCRIPTION_MAX_PRICE
    ) {
      return fail(400, {
        action: "updateSubscription",
        ok: false,
        messageKey: "dashboard.billing.errors.invalidMonthlyMaximum",
        messageParams: { minimum: 1, maximum: MAX_SUBSCRIPTION_MAX_PRICE },
      });
    }

    if (maxPrice < memberPriceFloor) {
      return fail(400, {
        action: "updateSubscription",
        ok: false,
        messageKey: "dashboard.billing.errors.monthlyMaximumBelowPrice",
        messageParams: { minimum: memberPriceFloor },
      });
    }

    if (maxPrice > currentUser.tuzis) {
      return fail(400, {
        action: "updateSubscription",
        ok: false,
        messageKey: "dashboard.billing.errors.monthlyMaximumExceedsBalance",
        messageParams: { balance: currentUser.tuzis as number },
      });
    }

    try {
      const updateResponse = await authenticatedBackendMutation({
        fetchFn: fetch,
        cookies,
        requestDestinationOrigin: url.origin,
        initiatingOrigin: request.headers.get("origin") || "",
        path: `/api/tuzis/subscribe/${encodeURIComponent(starUsername)}`,
        method: "PATCH",
        json: { max_price: String(maxPrice) },
      });

      if (!updateResponse.ok) {
        const failure = await readBackendFailure(updateResponse);
        logBackendFailure("billing.updateSubscription", failure);
        return fail(failure.status >= 400 ? failure.status : 502, {
          action: "updateSubscription",
          ok: false,
          messageKey:
            failure.kind === "csrf"
              ? "dashboard.billing.errors.securityTokenRejected"
              : "dashboard.billing.errors.updateSubscriptionFailedForUser",
          messageParams: { username: starUsername },
        });
      }

      const subscription = await updateResponse.json().catch(() => null);
      if (!subscription?.star?.username) {
        return fail(502, {
          action: "updateSubscription",
          ok: false,
          messageKey:
            "dashboard.billing.errors.updateSubscriptionFailedForUser",
          messageParams: { username: starUsername },
        });
      }

      return {
        action: "updateSubscription",
        ok: true,
        messageKey: "dashboard.billing.subscriptionUpdated",
        messageParams: { username: starUsername },
        subscription,
      };
    } catch (err) {
      const bridgeCode =
        err instanceof BackendBridgeError ? err.code : "unexpected";
      console.error("Update subscription action failed", { code: bridgeCode });
      return fail(bridgeCode === "untrusted-origin" ? 403 : 500, {
        action: "updateSubscription",
        ok: false,
        messageKey:
          bridgeCode === "untrusted-origin"
            ? "dashboard.billing.errors.untrustedRequestOrigin"
            : "dashboard.billing.errors.updateSubscriptionFailed",
        messageParams: {},
      });
    }
  },

  unsubscribe: async ({ params, request, cookies, fetch, url }) => {
    const sessionId = getSessionCookie(cookies);
    const csrfToken = getCsrfCookie(cookies);

    if (!sessionId) {
      throw redirect(302, loginDestination(url.pathname));
    }

    if (!csrfToken) {
      return missingCsrfFailure("unsubscribe");
    }

    await requireDashboardOwner(fetch, cookies, params.username, url.pathname);

    const unsubscribeCooldown = getCooldownRemainingMs(
      cookies,
      `billing_unsubscribe_${params.username}`,
      ACTION_COOLDOWN_MS,
    );
    if (unsubscribeCooldown > 0) {
      return fail(429, {
        action: "unsubscribe",
        ok: false,
        messageKey: "dashboard.billing.errors.unsubscribeCooldown",
        messageParams: {},
      });
    }

    const formData = await request.formData();
    const starUsername = String(formData.get("starUsername") || "").trim();

    if (!starUsername || !validateStarUsername(starUsername)) {
      return fail(400, {
        action: "unsubscribe",
        ok: false,
        messageKey: "dashboard.billing.errors.invalidSubscriptionUsername",
        messageParams: {},
      });
    }

    try {
      const unsubscribeResponse = await authenticatedBackendMutation({
        fetchFn: fetch,
        cookies,
        requestDestinationOrigin: url.origin,
        initiatingOrigin: request.headers.get("origin") || "",
        path: `/api/tuzis/subscribe/${encodeURIComponent(starUsername)}`,
        method: "DELETE",
      });

      if (!unsubscribeResponse.ok) {
        const failure = await readBackendFailure(unsubscribeResponse);
        logBackendFailure("billing.unsubscribe", failure);
        return fail(failure.status >= 400 ? failure.status : 502, {
          action: "unsubscribe",
          ok: false,
          messageKey:
            failure.kind === "csrf"
              ? "dashboard.billing.errors.securityTokenRejected"
              : "dashboard.billing.errors.unsubscribeFailedForUser",
          messageParams: { username: starUsername },
        });
      }

      return {
        action: "unsubscribe",
        ok: true,
        messageKey: "dashboard.billing.subscriptionWillNotRenew",
        messageParams: { username: starUsername },
      };
    } catch (err) {
      const bridgeCode =
        err instanceof BackendBridgeError ? err.code : "unexpected";
      console.error("Unsubscribe action failed", { code: bridgeCode });
      return fail(bridgeCode === "untrusted-origin" ? 403 : 500, {
        action: "unsubscribe",
        ok: false,
        messageKey:
          bridgeCode === "untrusted-origin"
            ? "dashboard.billing.errors.untrustedRequestOrigin"
            : "dashboard.billing.errors.unsubscribeFailed",
        messageParams: {},
      });
    }
  },
};
