<script lang="ts">
  import "../styles/globals.css";
  import "katex/dist/katex.min.css";
  import "highlight.js/styles/github-dark-dimmed.css";
  import "$lib/i18n"; // Initialize i18n
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import Navbar from "$lib/components/layout/Navbar.svelte";
  import AuthModalHost from "$lib/components/auth/AuthModalHost.svelte";
  import { translationJobsInUse } from "$lib/stores/translationJobsInUse";
  import { createRetryingLoader } from "$lib/retrying-loader";
  import Footer from "$lib/components/layout/Footer.svelte";
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import {
    createAppQueryClient,
    registerSsrQueryClientRelease,
  } from "$lib/query-client";
  import { browser } from "$app/env";
  import { afterNavigate, beforeNavigate, onNavigate } from "$app/navigation";
  import * as publicEnv from "$app/env/public";
  import {
    createFirstPartyCardResolver,
    firstPartyCardIdentity,
    provideFirstPartyCards,
  } from "$lib/first-party-card-resolver";
  import { firstPartyCardHost } from "$lib/utils/first-party-embed-cards";
  import { onDestroy, onMount } from "svelte";
  import { page } from "$app/state";
  import { updated } from "$app/state";
  import {
    page as pageStore,
    navigating as navigationStore,
  } from "$lib/kit-stores";
  import {
    toast,
    setToastAccount,
    paymentCreditedToast,
    toastPresentation,
  } from "$lib/toast.js";
  import { ModeWatcher } from "mode-watcher";
  import { liveStreamStore } from "$lib/stores/liveStreamStore";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { eventNotifications } from "$lib/stores/eventNotifications";
  import { embedConsentScope, privacyStore } from "$lib/stores/privacy";
  import { notificationSocketStatus } from "$lib/stores/notificationSocket";
  import { createProfileSocket } from "$lib/ws/profileSocket";
  import { createAccountRouteRefresh } from "$lib/ws/accountRouteRefresh";
  import { createAccountEventDelivery } from "$lib/ws/accountEvents";
  import type { Event } from "$lib/api/f2z.schemas";
  import { getCurrentLocale, locale, setLocale, tStore as t } from "$lib/i18n";
  import { goto, invalidate, invalidateAll } from "$app/navigation";
  import { ACCOUNT_BALANCE_DEPENDENCY } from "$lib/account-balance";
  import { isSdkFlow } from "$lib/sdk-flow";

  export let data: {
    locale?: string;
    localePersisted?: boolean;
    hasSession?: boolean;
  };

  // On the server the active locale comes from the per-request async context
  // bound in `hooks.server.ts`, so this call is a no-op there rather
  // than a write to a store shared by every concurrent request. It still runs
  // for any server context without that scope, and on hydration it prefers the
  // persisted cookie so the first client render matches the server's HTML.
  if (data.locale && (!browser || data.localePersisted)) {
    setLocale(data.locale);
  }

  // Hand the server's session fact to the store before anything renders
  //. No `sessionid` on the request means Django could not have
  // authenticated it, so the store can settle as anonymous with no round-trip
  // which is also what keeps an auth outage from turning every anonymous
  // page view into three retried `/api/auth/user/` requests. Browser-only:
  // the store is module-scoped and shared by every concurrent SSR request
  //, so nothing may write per-request state into it on the server.
  if (browser) {
    authStore.applyServerSessionHint(data.hasSession);
  }

  // Create a query client instance. One per render, so on the server it is
  // per-request — which is what keeps two concurrent visitors out of each
  // other's cache.
  const queryClient = createAppQueryClient();

  // …and one per request is only true if it actually DIES with the request.
  // Every `createQuery()` under this provider arms a `setTimeout(gcTime)`, and
  // a pending timer is a GC root: without this call each server render stays
  // reachable through Node's timer list, dragging its whole component graph
  // (~290KB for `/`) along with it. That is the leak behind the "JavaScript
  // heap out of memory" fatals  raised the ceiling for and did not stop.
  // See `$lib/query-client` for the heap-snapshot retaining path.
  registerSsrQueryClientRelease(queryClient);

  // First-party content cards for markdown the browser renders — comments,
  // converse replies, later feed pages. ONE resolver per page view:
  // every body on the page shares its deduped calls and its budget
  // (`MAX_PAGE_FIRST_PARTY_CARD_CALLS`, server seed included). Created per
  // render, so on the server it is per-request, and it never fetches there
  // (`enabled: browser`); it only carries the seed a page loader resolved.
  const firstPartyCards = provideFirstPartyCards(
    createFirstPartyCardResolver({
      enabled: browser,
      host: firstPartyCardHost(page.url.hostname),
      locale: () => getCurrentLocale(),
      localeStore: locale,
      apiBase: publicEnv.PUBLIC_API_BASE_URL,
      identity: firstPartyCardIdentity,
    }),
  );
  // A new page (not a new fragment) is a new page view: its own budget, and
  // nothing resolved for the last page renders on this one. `onNavigate` runs
  // after the new page's loads and BEFORE its components update: forget
  // everything and ignore requests — the page being left is still mounted
  // and would otherwise re-request its own bodies on the next page's budget.
  // The new page's seed (applied as its data arrives) is kept, and once it
  // is mounted `afterNavigate` lets every body on it request.
  onNavigate(({ from, to }) => {
    if (
      from?.url.pathname !== to?.url.pathname ||
      from?.url.search !== to?.url.search
    ) {
      firstPartyCards.suspend();
    }
  });
  afterNavigate(() => firstPartyCards.resume());
  onDestroy(() => firstPartyCards.destroy());

  let lastConnectedUsername = "";
  let removeAuthListeners = () => {};

  beforeNavigate(({ from, to, willUnload }) => {
    // SvelteKit has detected a newer build while this tab was open. A full
    // navigation fetches HTML and assets from the same current rollout while
    // preserving the user's intended URL.
    if (updated.current && !willUnload && to?.url) {
      window.location.href = to.url.href;
      return;
    }

    // `from`/`to` can be present with a null `url` — a redirect thrown by a
    // client-side load during the initial navigation reports one that way —
    // and `embedConsentScope` reads `url.pathname`.
    const fromScope = from?.url ? embedConsentScope(from.url) : "";
    const toScope = to?.url ? embedConsentScope(to.url) : "";

    if (fromScope !== toScope) {
      // A different destination — including the same path with a different
      // query — cannot use the current page's grant. If it matches an older
      // grant, this is a revisit and must prompt again.
      privacyStore.clearTransientConsentForScope(toScope);
    }
  });

  afterNavigate(({ from, to }) => {
    // Same null-`url` shape as above: the login redirect out of the editor's
    // client-side load  surfaced it as an uncaught TypeError that
    // rendered the 500 page over the top of a navigation that had succeeded.
    const fromScope = from?.url ? embedConsentScope(from.url) : "";
    const toScope = to?.url ? embedConsentScope(to.url) : "";

    // The page was actually left, so its one-time grant is spent. beforeNavigate
    // can only pre-clear the destination it was told about, and a server
    // redirect changes that destination underneath it: /alice/zpage/slug
    // redirects to /alice/slug, so a grant made on /alice/slug would still be
    // sitting there when the redirect lands back on it. Only completed
    // navigations reach here, so a canceled one still revokes nothing.
    if (from && fromScope !== toScope) {
      privacyStore.clearTransientConsent();
    }
  });

  function getProfileWebSocketUrl() {
    if (!browser) return "";
    const wsProtocol = page.url.protocol === "https:" ? "wss" : "ws";
    return `${wsProtocol}://${page.url.host}/ws/profile`;
  }

  const accountRoutes = createAccountRouteRefresh({
    username: () => $currentUser?.username || "",
    navigation: () => $navigationStore?.complete || null,
    refresh: async (username) => {
      // Invalidation takes over SvelteKit's navigation token. Let the user's
      // current navigation finish; only billing history needs this reload.
      if (
        $currentUser?.username !== username ||
        $pageStore.route.id !== "/[username]/dashboard/billing" ||
        $pageStore.params.username !== username
      )
        return;
      await invalidate(ACCOUNT_BALANCE_DEPENDENCY);
    },
  });

  const accountEvents = createAccountEventDelivery<Event>({
    username: () => $currentUser?.username || "",
    add: (event, countUnread) =>
      eventNotifications.addIncomingEvent(event, countUnread),
    paymentSettled: (intentId) => toast.dismiss(`zec-pending-${intentId}`),
    notify: (event) => {
      // Pages an SDK app opens stay commerce-free (the store line,
      // $lib/sdk-flow): no purchase toast, and no toast action that navigates
      // into the site. The event is still recorded in the visitor's history.
      if (isSdkFlow($pageStore.url)) return;
      if (event.type === "BOUGHT_TUZI") {
        paymentCreditedToast(
          typeof event.amount === "number" && Number.isFinite(event.amount)
            ? $t(
                "notifications.purchaseCredited",
                "Payment received — {amount} 2Z credited.",
                {
                  amount: event.amount.toLocaleString($locale, {
                    maximumFractionDigits: 3,
                  }),
                },
              )
            : $t(
                "notifications.purchaseCreditedUnknown",
                "Your 2Z purchase was credited.",
              ),
          {
            description: $t(
              "notifications.latestCredit",
              "Latest purchase credited. Individual receipts remain in your notifications.",
            ),
            action: {
              label: $t("common.navigation.notifications", "Notifications"),
              onClick: () => {
                goto(
                  `/${encodeURIComponent($currentUser?.username || "")}/dashboard/notifications`,
                );
              },
            },
          },
        );
      } else if (event.type === "ZEC_PENDING") {
        toast.info(
          $t("notifications.zcashPending", "Your Zcash payment was detected."),
          {
            id: event.payment_reference
              ? `zec-pending-${event.payment_reference.payment_id || event.payment_reference.intent_id}`
              : event.id,
            duration: Infinity,
            description: $t(
              "notifications.events.zecPending",
              "Your Zcash payment was detected. We’re processing it. Check your credit balance in Credits & Earnings.",
            ),
          },
        );
      } else {
        toast.info(
          $t(
            "dashboard.notifications.newActivity",
            "New activity on your account.",
          ),
          { id: event.id },
        );
      }
    },
    history: async (username, signal) =>
      eventNotifications.reconcilePayments(username, signal),
    refresh: async (username, routes) => {
      // A check that started before crediting can return the old balance.
      const refreshed = await authStore.checkAuth({
        force: true,
        silent: true,
        fresh: true,
      });
      if ($currentUser?.username !== username) return;
      if (!refreshed) throw new Error("Account balance refresh failed");
      // Only the billing history declares this dependency. Reloading the editor
      // can overwrite unsaved text; other balances react to the auth-store read.
      if (routes && $currentUser?.username === username)
        accountRoutes.request();
    },
  });

  // The reconnect policy (backoff, stability window, circuit breaker) lives in
  // $lib/ws/profileSocket so short-lived connections cannot bypass retry limits.
  const profileSocket = createProfileSocket({
    url: getProfileWebSocketUrl,
    // The navbar renders the "notifications offline" affordance off this, so
    // the UI reflects the controller's real breaker state rather than a second
    // copy of it that can drift. Guarded on `browser` because the
    // store is module-scoped and shared by every concurrent SSR request
    //this controller never opens a socket on the server, and the
    // guard is what keeps that a property of the callsite rather than a fact
    // about the controller's internals that a later change could break.
    onStatusChange: (status) => {
      if (browser) {
        notificationSocketStatus.report(status);
        if (status.phase === "connected") accountEvents.reconcile(true);
      }
    },
    onMessage: (data) => {
      try {
        const payload = JSON.parse(data);
        const event = payload?.content as Event | undefined;
        if (!event?.id) {
          return;
        }

        accountEvents.receive(event);
      } catch {
        // ignore malformed websocket payloads
      }
    },
  });

  function closeSocket() {
    profileSocket.close();
  }

  function connectSocket(username: string) {
    if (!browser || !username) {
      return;
    }
    profileSocket.connect(username);
  }

  // The translation jobs notifier  is loaded on demand: only for a
  // signed-in creator, and only once this tab has used the jobs store (the
  // editor did). A reader never downloads it, the store, or its API client.
  type NotifierComponent =
    typeof import("$lib/components/zpageLanguage/TranslationJobsNotifier.svelte").default;
  let JobsNotifier: NotifierComponent | null = null;
  // A failed import (a missing deployment chunk, no network) retries with
  // backoff and then gives up; it used to retry in a tight loop for the life
  // of the tab (codex adversarial review). Signing in again tries afresh.
  const notifierLoader = createRetryingLoader(
    () =>
      import("$lib/components/zpageLanguage/TranslationJobsNotifier.svelte"),
    (module) => (JobsNotifier = module.default),
  );
  let notifierUser: string | null = null;
  $: if (browser && ($currentUser?.username ?? null) !== notifierUser) {
    notifierUser = $currentUser?.username ?? null;
    notifierLoader.reset();
  }
  $: if (browser && !JobsNotifier && $currentUser && $translationJobsInUse)
    notifierLoader.start();

  const unsubscribeCurrentUser = currentUser.subscribe(async (creator) => {
    if (!browser) {
      return;
    }

    const username = creator?.username || "";
    setToastAccount(
      creator
        ? creator.id != null
          ? `id:${creator.id}`
          : `username:${username}`
        : "",
      username,
    );

    if (!username) {
      lastConnectedUsername = "";
      accountEvents.reset();
      accountRoutes.reset();
      // close() also clears the attempt counter and every pending timer, so a
      // logout can never leave a stability timer armed against a dead socket.
      closeSocket();
      eventNotifications.clearForLogout();
      return;
    }

    if (lastConnectedUsername !== username) {
      accountEvents.reset();
      accountRoutes.reset();
      eventNotifications.clearForLogout();
      lastConnectedUsername = username;
      await eventNotifications.refreshMeta(username);
      // A logout (or another user) can land while that await is in flight; the
      // socket controller has no way to know this callback is stale, and an
      // anonymous connection would just get rejected and then retried.
      if (lastConnectedUsername !== username) {
        return;
      }
      connectSocket(username);
      return;
    }

    await eventNotifications.refreshMeta(username);
  });

  onDestroy(() => {
    notifierLoader.stop();
    toast.dismiss();
    accountEvents.reset();
    accountRoutes.reset();
    unsubscribeCurrentUser();
    removeAuthListeners();
    closeSocket();
  });

  onMount(() => {
    const stopPrivacyStorageSync = privacyStore.startStorageSync();
    // Registered here rather than at component init: the store is module-scoped
    // and shared by every concurrent SSR request, so a handler bound to
    // one request's component instance must never be published from the server.
    const unregisterRetry = notificationSocketStatus.registerRetry(() =>
      profileSocket.resume(),
    );
    const browserLocale = getCurrentLocale();
    if (data.localePersisted && data.locale) {
      setLocale(data.locale);
    } else {
      setLocale(browserLocale);
      if (browserLocale !== data.locale) void invalidateAll();
    }
    const syncAuthState = () => {
      authStore
        .checkAuth({ force: true, silent: true })
        .then(() => {
          // A tab the user has come back to should not wait out the slow lane
          // before notifications work again. Deliberately *after* checkAuth
          // resolves and only if the session is still the one this socket was
          // opened for: another tab may have signed in as someone else, and a
          // probe sent before revalidation would carry that cookie while this
          // UI still shows the old account.
          if (
            lastConnectedUsername &&
            $currentUser?.username === lastConnectedUsername
          ) {
            profileSocket.resume();
          }
        })
        .catch(console.error);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        syncAuthState();
      }
    };
    const handlePageHide = () => privacyStore.clearTransientConsent();

    const handleBalanceReconcile = (event: globalThis.Event) => {
      if ((event as CustomEvent<string>).detail === $currentUser?.username)
        accountEvents.reconcile(false, false);
    };
    window.addEventListener(
      "account-balance-reconcile",
      handleBalanceReconcile,
    );
    window.addEventListener("focus", syncAuthState);
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    removeAuthListeners = () => {
      window.removeEventListener(
        "account-balance-reconcile",
        handleBalanceReconcile,
      );
      window.removeEventListener("focus", syncAuthState);
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stopPrivacyStorageSync();
      unregisterRetry();
    };

    syncAuthState();
  });

  $: if (browser && $pageStore.url.pathname) {
    authStore.checkAuth({ silent: true }).catch(console.error);
  }

  $: privateSurface =
    /\/(dashboard|private)(\/|$)/.test($pageStore.url.pathname) ||
    ["/edit", "/buy-2z", "/login"].includes($pageStore.url.pathname) ||
    $pageStore.url.pathname.startsWith("/checkout/") ||
    // The OIDC consent screen, connected apps and the developer console
    //account surfaces, never search results.
    /^\/(oauth|account|developers)\//.test($pageStore.url.pathname);

  // An app's sign-in flow (consent, and the /login before it) has no site
  // chrome: the navigation reaches Credits, and the flow must not lead to a
  // purchase (the store line, $lib/sdk-flow).
  $: sdkFlow = isSdkFlow($pageStore.url);
  // Arriving on one by in-tab navigation, a toast raised on the page before
  // (a purchase credited, with a button into the dashboard) must not ride
  // along: clear them all on the way in.
  $: if (browser && sdkFlow) toast.dismiss();
  $: hideChrome =
    sdkFlow ||
    $pageStore.route.id === "/edit" ||
    Boolean(
      $pageStore.route.id?.includes("dashboard/stream") &&
      $liveStreamStore.meeting,
    );
</script>

<svelte:head>
  {#if privateSurface}
    <meta name="robots" content="noindex, nofollow, noarchive" />
  {/if}
</svelte:head>

<QueryClientProvider client={queryClient}>
  <Tooltip.Provider>
    {#key $toastPresentation.generation}
      <div
        aria-hidden={!$toastPresentation.ready}
        inert={!$toastPresentation.ready}
        style:visibility={$toastPresentation.ready ? "visible" : "hidden"}
      >
        <Toaster
          expand
          position="bottom-center"
          containerAriaLabel={$t(
            "common.navigation.notifications",
            "Notifications",
          )}
          closeButtonAriaLabel={$t(
            "common.navigation.closeToast",
            "Close notification",
          )}
        />
      </div>
    {/key}
    <ModeWatcher />
    <!-- The one sign-in modal, opened in place by every "Log in" control
         . Mounted here rather than in the navbar so it exists on the
         editor too, where the navbar is not rendered. -->
    <AuthModalHost />
    <!-- Translation jobs outlive the editor: their outcomes are
         announced, and their progress shown, from here. -->
    {#if JobsNotifier && $currentUser && !sdkFlow}<svelte:component
        this={JobsNotifier}
      />{/if}
    <div
      class="flex min-h-screen flex-col"
      style="background: var(--f2z-bg-primary);"
    >
      {#if !hideChrome}
        <Navbar />
      {/if}
      <main
        data-testid="layout-main"
        class:px-2={$pageStore.url.pathname !== "/"}
        class="flex flex-1 flex-col md:p-0"
      >
        <slot />
      </main>
      {#if !hideChrome}
        <Footer
          flush={$pageStore.url.pathname === "/"}
          hideOnMobile={$pageStore.url.pathname === "/"}
        />
      {/if}
    </div>
  </Tooltip.Provider>
</QueryClientProvider>
