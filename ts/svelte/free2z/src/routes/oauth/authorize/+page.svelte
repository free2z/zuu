<script lang="ts">
  import EconomyPolicyNote from "$lib/components/EconomyPolicyNote.svelte";
  /**
   * The OIDC consent screen (; zuu docs/free2z/sdk/spec/oidc.md §5, §9.2, §10).
   *
   * The backend decides everything: `GET /api/oauth/authorize` evaluates the
   * request and answers `login`, `consent`, `approve` or `redirect`; the page
   * only renders that answer and posts the user's decision back with the
   * signed `request_id`. Client-side only (no server load): the request is
   * evaluated with the visitor's own session, and nothing here is indexable.
   *
   * The spend cap never fails open: an approval that grants `ai:invoke`
   * always carries an explicit cap, built by `buildConsentDecision`, which
   * throws rather than send a body without one.
   *
   * Commerce-free (the store line, `$lib/sdk-flow`): the root layout renders
   * this page without the site navigation, and nothing here links to a
   * purchase, a price or the rest of the site.
   */
  import { onMount } from "svelte";
  import { page } from "$lib/kit-stores";
  import { tStore as t, getCurrentLocale } from "$lib/i18n";
  import { Button } from "$lib/components/ui/button";
  import {
    oidcAuthorizeDecide,
    oidcAuthorizeEvaluate,
  } from "$lib/api/oauth/oauth";
  import type {
    AuthorizeResponse,
    ConsentDecision,
    ConsentPrompt,
    OidcAuthorizeEvaluateParams,
  } from "$lib/api/f2z.schemas";
  import { ApiError } from "$lib/api/mutator";
  import { apiFetch } from "$lib/api/config";
  import { loginDestination } from "$lib/login-destination";
  import {
    CAP_PERIODS,
    REAUTH_MARKER,
    authorizationParams,
    buildConsentDecision,
    isCapPeriod,
    isCapRaise,
    isNavigableRedirect,
    markupPercent,
    raiseBaseline,
    reauthReturnPath,
    withLoginTicket,
    resolveCap,
    sameCap,
    stepUpPhase,
    type CapChoice,
    type CapPeriod,
    type SpendCap,
  } from "$lib/oidc/consent";
  import { capPeriodLabel, capSummary, scopeLabel } from "$lib/oidc/labels";

  type Phase =
    | "loading"
    | "consent"
    | "submitting"
    | "redirecting"
    | "reauth"
    | "reauthLoop"
    | "stepUp"
    | "stepUpLoop"
    | "error";

  let phase: Phase = "loading";
  let errorMessage = "";
  let errorDetail = "";
  let canRetry = false;

  let requestId = "";
  let authorizationRequest: Record<string, unknown> = {};
  let prompt: ConsentPrompt | null = null;

  let preselected: SpendCap = { spend_cap_2z: null, cap_period: "month" };
  let capChoice: CapChoice["kind"] = "preselected";
  let customAmount = "";
  let customPeriod: CapPeriod = "month";
  let noCapConfirmed = false;
  let submitError = "";

  $: locale = getCurrentLocale();
  $: app = prompt?.application;
  $: capRequired = Boolean(prompt?.cap_required);
  $: markupBps = app?.markup_bps ?? 0;
  $: alreadyGranted = new Set(prompt?.already_granted ?? []);
  $: choice = ((): CapChoice => {
    if (capChoice === "custom") {
      return { kind: "custom", amount: customAmount, period: customPeriod };
    }
    if (capChoice === "current") {
      return currentCap
        ? { kind: "current", cap: currentCap }
        : { kind: "preselected" };
    }
    return { kind: capChoice };
  })();
  $: resolution = resolveCap(choice, preselected, noCapConfirmed);
  // The existing grant's cap, when the backend reports one: shown
  // beside an app's suggestion so one Allow never changes it unseen.
  $: currentCap = ((): SpendCap | null => {
    const current = prompt?.current_spend_cap as SpendCap | null | undefined;
    if (!current || !isCapPeriod(current.cap_period)) return null;
    return raiseBaseline(current, preselected);
  })();
  // An app's suggestion replaced the grant's cap in the pre-selection: the
  // grant itself is offered as its own choice.
  $: offerCurrent = Boolean(
    prompt?.spend_cap_source === "request" &&
    currentCap &&
    !sameCap(currentCap, preselected),
  );
  $: raiseNeedsSignIn = Boolean(
    prompt?.is_raise_step_up_required &&
    resolution.ok &&
    isCapRaise(
      raiseBaseline(
        (prompt?.current_spend_cap as SpendCap | null | undefined) ?? null,
        preselected,
      ),
      resolution.cap,
    ),
  );
  $: canApprove = phase === "consent" && (!capRequired || resolution.ok);

  function hasReauthMarker(): boolean {
    return $page.url.searchParams.get(REAUTH_MARKER) === "1";
  }

  function fail(message: string, detail = "", retry = false) {
    phase = "error";
    errorMessage = message;
    errorDetail = detail;
    canRetry = retry;
  }

  function navigateTo(target: string | undefined) {
    if (!isNavigableRedirect(target)) {
      fail(
        $t(
          "oauth.consent.errors.badRedirect",
          "This app's sign-in request could not be completed.",
        ),
      );
      return;
    }
    phase = "redirecting";
    window.location.assign(target);
  }

  function goToLogin(ticket?: string) {
    const here = withLoginTicket($page.url.pathname, $page.url.search, ticket);
    window.location.assign(loginDestination(here));
  }

  /** The ticket of the last `login` answer, carried across the sign-in. */
  let loginTicket = "";

  /** The OAuth error body's own sentence, if the backend gave one. */
  function oauthErrorText(error: unknown): string {
    if (
      error instanceof ApiError &&
      error.data &&
      typeof error.data === "object"
    ) {
      const data = error.data as Record<string, unknown>;
      const description = data.error_description ?? data.detail;
      if (typeof description === "string") return description;
    }
    return "";
  }

  function handleAnswer(answer: AuthorizeResponse) {
    switch (answer.action) {
      case "redirect":
        navigateTo(answer.redirect_to);
        return;
      case "login":
        loginTicket = answer.login_ticket ?? "";
        if (answer.reason === "login_required") {
          goToLogin(loginTicket);
        } else if (hasReauthMarker()) {
          // We already sent the user through a fresh sign-in and the
          // backend still cannot confirm one: stop, do not loop.
          phase = "reauthLoop";
        } else {
          phase = "reauth";
        }
        return;
      case "approve":
        requestId = answer.request_id ?? "";
        authorizationRequest = (answer.authorization_request ?? {}) as Record<
          string,
          unknown
        >;
        void submit(true, { silent: true });
        return;
      case "consent":
        requestId = answer.request_id ?? "";
        authorizationRequest = (answer.authorization_request ?? {}) as Record<
          string,
          unknown
        >;
        prompt = answer.consent ?? null;
        if (!prompt) {
          fail(
            $t(
              "oauth.consent.errors.generic",
              "Something went wrong. Please try again.",
            ),
            "",
            true,
          );
          return;
        }
        preselected = {
          spend_cap_2z: prompt.spend_cap?.spend_cap_2z ?? null,
          cap_period: isCapPeriod(prompt.spend_cap?.cap_period)
            ? prompt.spend_cap.cap_period
            : "month",
        };
        capChoice = "preselected";
        customAmount =
          preselected.spend_cap_2z === null
            ? ""
            : String(preselected.spend_cap_2z);
        customPeriod = preselected.cap_period;
        noCapConfirmed = false;
        phase = "consent";
        return;
      default:
        fail(
          $t(
            "oauth.consent.errors.generic",
            "Something went wrong. Please try again.",
          ),
          "",
          true,
        );
    }
  }

  async function evaluate() {
    phase = "loading";
    submitError = "";
    const params = authorizationParams($page.url.searchParams);
    if (!params.client_id || !params.redirect_uri) {
      fail(
        $t(
          "oauth.consent.errors.invalidRequest",
          "This sign-in link is incomplete or has expired. Go back to the app and try again.",
        ),
      );
      return;
    }
    try {
      const answer = await oidcAuthorizeEvaluate(
        params as unknown as OidcAuthorizeEvaluateParams,
      );
      handleAnswer(answer);
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        fail(
          $t(
            "oauth.consent.errors.invalidRequest",
            "This sign-in link is incomplete or has expired. Go back to the app and try again.",
          ),
          oauthErrorText(error),
        );
        return;
      }
      fail(
        $t(
          "oauth.consent.errors.unavailable",
          "Free2Z could not check this request right now. Please try again.",
        ),
        "",
        true,
      );
    }
  }

  async function submit(allow: boolean, options: { silent?: boolean } = {}) {
    submitError = "";
    let body: ConsentDecision;
    try {
      const cap =
        allow && capRequired && resolution.ok ? resolution.cap : undefined;
      body = buildConsentDecision({
        requestId,
        authorizationRequest,
        allow,
        capRequired: allow && !options.silent ? capRequired : false,
        cap,
      }) as unknown as ConsentDecision;
    } catch {
      submitError = $t(
        "oauth.consent.cap.chooseFirst",
        "Choose a spending limit before you allow access.",
      );
      return;
    }
    phase = "submitting";
    try {
      const answer = await oidcAuthorizeDecide(body);
      if (answer.action === "consent" || answer.action === "approve") {
        // The backend never answers a POST this way; start over rather than
        // guess.
        await evaluate();
        return;
      }
      handleAnswer(answer);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        const code =
          error.data && typeof error.data === "object"
            ? (error.data as Record<string, unknown>).code
            : undefined;
        if (code === "insufficient_user_authentication") {
          // Loop guard: after the fresh sign-in this page already
          // sent the user through, a second refusal must not offer a third.
          phase = stepUpPhase($page.url.searchParams);
          return;
        }
        goToLogin();
        return;
      }
      if (
        error instanceof ApiError &&
        error.status === 403 &&
        forbiddenRetries < 1
      ) {
        forbiddenRetries += 1;
        // Not signed in any more (DRF answers 403 when session auth comes
        // first) or a CSRF refusal: ask the backend again what to do. An
        // expired session then answers `login`; a live one re-shows the
        // screen with a fresh request_id (codex review, ).
        await evaluate();
        return;
      }
      if (error instanceof ApiError && error.status === 403) {
        fail(
          $t(
            "oauth.consent.errors.forbidden",
            "Free2Z refused this request. Reload the page, or sign out and back in, then try again.",
          ),
        );
        return;
      }
      if (error instanceof ApiError && error.status === 400) {
        fail(
          $t(
            "oauth.consent.errors.expired",
            "This request changed or expired while it was open. Start again to review it.",
          ),
          oauthErrorText(error),
          true,
        );
        return;
      }
      phase = options.silent ? "loading" : "consent";
      if (options.silent) {
        fail(
          $t(
            "oauth.consent.errors.unavailable",
            "Free2Z could not check this request right now. Please try again.",
          ),
          "",
          true,
        );
        return;
      }
      submitError = $t(
        "oauth.consent.errors.submitFailed",
        "Your answer could not be sent. Please try again.",
      );
    }
  }

  /**
   * A fresh sign-in (prompt=login, max_age, acr_values, or a cap raise):
   * sign out, then sign in and come back to the same request without
   * prompt=login. The session only ends after the user asks for it.
   */
  let reauthBusy = false;
  /**
   * A 403 on the decision re-evaluates ONCE. An already-authorized app is
   * approved without a screen, so an unbounded retry of a persistent CSRF
   * refusal would loop GET/POST with no user in it (codex review, ).
   */
  let forbiddenRetries = 0;
  let reauthError = "";
  async function reauthenticate() {
    reauthBusy = true;
    reauthError = "";
    // The return trip drops prompt=login, so it is only safe once the OLD
    // session is confirmed gone: a surviving session would bounce straight
    // back through /login and be judged without the fresh sign-in the app
    // asked for (codex review, ). Only a 2xx, or the 401 of a session
    // that is already gone, is proof; a 403 is a CSRF refusal that leaves the
    // session alive (the same rule as authStore.logout).
    let signedOut = false;
    try {
      const response = await apiFetch("/api/auth/logout/", { method: "POST" });
      signedOut = response.ok || response.status === 401;
    } catch {
      signedOut = false;
    }
    if (!signedOut) {
      reauthBusy = false;
      reauthError = $t(
        "oauth.consent.reauth.logoutFailed",
        "Free2Z could not sign you out to confirm it's you. Please try again.",
      );
      return;
    }
    const next = reauthReturnPath(
      $page.url.pathname,
      $page.url.search,
      loginTicket,
    );
    window.location.assign(loginDestination(next, "reauthenticate"));
  }

  function keepCurrentCap() {
    // "Current" is the grant's own cap, which an app's suggestion may have
    // replaced in the pre-selection: keeping it must not quietly
    // accept the suggestion instead.
    capChoice = offerCurrent ? "current" : "preselected";
    noCapConfirmed = false;
    phase = "consent";
  }

  onMount(() => {
    void evaluate();
  });
</script>

<svelte:head>
  <title>{$t("oauth.consent.metaTitle", "Connect an app · Free2Z")}</title>
  <meta name="referrer" content="no-referrer" />
</svelte:head>

<main class="mx-auto w-full max-w-lg px-4 py-8 sm:py-12">
  {#if phase === "loading" || phase === "redirecting" || (phase === "submitting" && !prompt)}
    <div
      class="flex flex-col items-center gap-3 py-16 text-center"
      role="status"
      aria-live="polite"
      data-testid="oauth-consent-loading"
    >
      <div
        class="size-8 animate-spin rounded-full border-2 border-muted border-t-primary"
        aria-hidden="true"
      ></div>
      <p class="text-muted-foreground">
        {phase === "redirecting"
          ? $t("oauth.consent.returning", "Returning you to the app…")
          : $t("oauth.consent.checking", "Checking the request…")}
      </p>
    </div>
  {:else if phase === "error"}
    <section
      class="space-y-4 rounded-lg border bg-card p-6"
      role="alert"
      data-testid="oauth-consent-error"
    >
      <h1 class="text-xl font-semibold">
        {$t("oauth.consent.errors.title", "This request can't continue")}
      </h1>
      <p class="text-muted-foreground">{errorMessage}</p>
      {#if errorDetail}
        <p
          class="rounded-md bg-muted/50 p-3 font-mono text-xs break-words text-muted-foreground"
          data-testid="oauth-consent-error-detail"
        >
          {errorDetail}
        </p>
      {/if}
      {#if canRetry}
        <Button onclick={() => evaluate()}>
          {$t("oauth.consent.tryAgain", "Try again")}
        </Button>
      {/if}
    </section>
  {:else if phase === "reauth" || phase === "reauthLoop"}
    <section
      class="space-y-4 rounded-lg border bg-card p-6"
      data-testid="oauth-consent-reauth"
    >
      <h1 class="text-xl font-semibold">
        {$t("oauth.consent.reauth.title", "Confirm it's you")}
      </h1>
      {#if phase === "reauth"}
        <p class="text-muted-foreground">
          {$t(
            "oauth.consent.reauth.body",
            "The app you are connecting asks you to sign in again before it continues. You will be signed out of Free2Z and brought back here after you sign in.",
          )}
        </p>
        <Button
          onclick={reauthenticate}
          disabled={reauthBusy}
          data-testid="oauth-consent-reauth-button"
        >
          {$t("oauth.consent.reauth.button", "Sign in again")}
        </Button>
        {#if reauthError}
          <p
            class="text-sm text-destructive"
            role="alert"
            data-testid="oauth-consent-reauth-error"
          >
            {reauthError}
          </p>
        {/if}
      {:else}
        <p
          class="text-muted-foreground"
          data-testid="oauth-consent-reauth-loop"
        >
          {$t(
            "oauth.consent.reauth.loop",
            "Free2Z could not confirm a recent sign-in for this request. Go back to the app and try again later.",
          )}
        </p>
      {/if}
    </section>
  {:else if prompt && app}
    <section
      class="space-y-6 rounded-lg border bg-card p-5 sm:p-6"
      aria-labelledby="oauth-consent-title"
      data-testid="oauth-consent"
    >
      <header class="flex items-start gap-4">
        {#if app.logo_url && /^https:\/\//i.test(app.logo_url)}
          <img
            src={app.logo_url}
            alt=""
            class="size-12 shrink-0 rounded-md border object-cover"
            referrerpolicy="no-referrer"
          />
        {/if}
        <div class="min-w-0 space-y-1">
          <h1
            id="oauth-consent-title"
            class="text-xl font-semibold break-words"
            data-testid="oauth-consent-app-name"
          >
            {$t(
              "oauth.consent.title",
              "{app} wants to use your Free2Z account",
              {
                app: app.name,
              },
            )}
          </h1>
          {#if app.first_party}
            <p
              class="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
              data-testid="oauth-consent-first-party"
            >
              <svg
                viewBox="0 0 16 16"
                class="size-3.5"
                aria-hidden="true"
                fill="currentColor"
              >
                <path d="M6.5 11.3 3.2 8l1.1-1.1 2.2 2.2 5.2-5.2 1.1 1.1z" />
              </svg>
              {$t("oauth.consent.firstParty", "Verified: made by Free2Z")}
            </p>
          {/if}
          <p
            class="text-base font-medium text-foreground"
            data-testid="oauth-consent-developer"
          >
            {#if app.developer}
              {$t("oauth.consent.developer", "Made by @{developer}", {
                developer: app.developer,
              })}
            {:else}
              {$t("oauth.consent.developerUnknown", "Developer not listed")}
            {/if}
          </p>
          {#if !app.first_party}
            <p
              class="text-sm text-muted-foreground"
              data-testid="oauth-consent-third-party"
            >
              {$t(
                "oauth.consent.thirdParty",
                "This app is not made by Free2Z. Only continue if you trust its developer.",
              )}
            </p>
          {/if}
          {#if app.child_directed}
            <p
              class="text-sm text-muted-foreground"
              data-testid="oauth-consent-child-directed"
            >
              {$t(
                "oauth.consent.childDirected",
                "Children may use this app. You are connecting your own account as the adult account holder.",
              )}
            </p>
          {/if}
        </div>
      </header>

      <div class="space-y-2">
        <h2 class="text-sm font-medium">
          {$t("oauth.consent.scopesHeading", "This app will be able to:")}
        </h2>
        <ul class="space-y-2" data-testid="oauth-consent-scopes">
          {#each prompt.scopes as scope (scope)}
            <li class="flex items-start gap-2 text-sm" data-scope={scope}>
              <span
                class="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                aria-hidden="true"
              ></span>
              <span>
                {scopeLabel($t, scope, prompt.scope_descriptions?.[scope])}
                {#if alreadyGranted.size > 0 && !alreadyGranted.has(scope)}
                  <span
                    class="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary"
                  >
                    {$t("oauth.consent.newScope", "New")}
                  </span>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      </div>

      {#if markupBps > 0}
        <div
          class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          data-testid="oauth-consent-markup"
        >
          <p class="font-medium">
            {$t(
              "oauth.consent.markup",
              "This app adds {percent}% on top of the AI cost.",
              { percent: markupPercent(markupBps, locale) },
            )}
          </p>
          <p class="mt-1 text-muted-foreground">
            {$t(
              "oauth.consent.markupExplain",
              "Each AI request costs its usual 2Z usage credits plus {percent}% more.",
              { percent: markupPercent(markupBps, locale) },
            )}
          </p>
          <EconomyPolicyNote />
        </div>
      {/if}

      {#if capRequired}
        <fieldset class="space-y-3" data-testid="oauth-consent-cap">
          <legend class="text-sm font-medium">
            {$t("oauth.consent.cap.legend", "Optional app budget")}
          </legend>
          <p class="text-sm text-muted-foreground">
            {$t(
              "oauth.consent.cap.help",
              "AI calls use your available prepaid 2Z balance. An optional budget limits what this app may spend for you; it does not add credits. Change it or remove access in Connected apps.",
            )}
          </p>

          <label
            class="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary"
          >
            <input
              type="radio"
              name="cap"
              value="preselected"
              bind:group={capChoice}
              class="mt-1"
              data-testid="oauth-cap-preselected"
            />
            <span class="text-sm">
              <span class="font-medium"
                >{capSummary($t, preselected, locale)}</span
              >
              {#if preselected.spend_cap_2z !== null}
                <span class="block text-muted-foreground">
                  {prompt.already_granted.length &&
                  prompt.spend_cap_source !== "request"
                    ? $t("oauth.consent.cap.current", "Your current budget")
                    : $t(
                        "oauth.consent.cap.suggested",
                        "Suggested by this app; you can change it",
                      )}
                </span>
              {/if}
              {#if offerCurrent && currentCap}
                <span
                  class="block font-medium"
                  data-testid="oauth-cap-current-budget"
                >
                  {$t(
                    "oauth.consent.cap.replacesCurrent",
                    "Replaces your current budget: {cap}",
                    { cap: capSummary($t, currentCap, locale) },
                  )}
                </span>
              {/if}
            </span>
          </label>

          {#if offerCurrent && currentCap}
            <label
              class="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary"
            >
              <input
                type="radio"
                name="cap"
                value="current"
                bind:group={capChoice}
                class="mt-1"
                data-testid="oauth-cap-current"
              />
              <span class="text-sm">
                <span class="font-medium"
                  >{capSummary($t, currentCap, locale)}</span
                >
                <span class="block text-muted-foreground">
                  {$t(
                    "oauth.consent.cap.keepCurrent",
                    "Keep your current budget",
                  )}
                </span>
              </span>
            </label>
          {/if}

          <label
            class="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary"
          >
            <input
              type="radio"
              name="cap"
              value="custom"
              bind:group={capChoice}
              class="mt-1"
              data-testid="oauth-cap-custom"
            />
            <span class="flex-1 space-y-2 text-sm">
              <span class="font-medium">
                {$t("oauth.consent.cap.custom", "Set a different budget")}
              </span>
              {#if capChoice === "custom"}
                <span class="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    inputmode="numeric"
                    pattern="[0-9]*"
                    bind:value={customAmount}
                    class="h-9 w-32 rounded-md border bg-background px-3 text-sm"
                    aria-label={$t(
                      "oauth.consent.cap.amountLabel",
                      "Limit in 2Z credits",
                    )}
                    aria-invalid={!resolution.ok &&
                      resolution.reason === "amount"}
                    data-testid="oauth-cap-amount"
                  />
                  <span>2Z</span>
                  <select
                    bind:value={customPeriod}
                    class="h-9 rounded-md border bg-background px-2 text-sm"
                    aria-label={$t("oauth.consent.cap.periodLabel", "Period")}
                    data-testid="oauth-cap-period"
                  >
                    {#each CAP_PERIODS as period (period)}
                      <option value={period}
                        >{capPeriodLabel($t, period)}</option
                      >
                    {/each}
                  </select>
                </span>
                {#if !resolution.ok && resolution.reason === "amount"}
                  <span class="block text-destructive" role="alert">
                    {$t(
                      "oauth.consent.cap.amountInvalid",
                      "Enter a whole number of 2Z credits, 1 or more.",
                    )}
                  </span>
                {/if}
                <span class="block text-xs text-muted-foreground">
                  {$t(
                    "oauth.consent.cap.periodHelp",
                    "Periods follow the calendar in UTC: a day starts at 00:00 UTC, a week on Monday, a month on the 1st. “In total” never resets.",
                  )}
                </span>
              {/if}
            </span>
          </label>

          {#if preselected.spend_cap_2z !== null}
            <label
              class="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-destructive"
            >
              <input
                type="radio"
                name="cap"
                value="none"
                bind:group={capChoice}
                class="mt-1"
                data-testid="oauth-cap-none"
              />
              <span class="flex-1 space-y-2 text-sm">
                <span class="font-medium"
                  >{$t(
                    "oauth.cap.noLimit",
                    "Available balance (no extra budget)",
                  )}</span
                >
                {#if capChoice === "none" && preselected.spend_cap_2z !== null}
                  <span class="flex items-start gap-2 text-destructive">
                    <input
                      id="oauth-cap-none-confirm"
                      type="checkbox"
                      bind:checked={noCapConfirmed}
                      class="mt-0.5"
                      data-testid="oauth-cap-none-confirm"
                    />
                    <span>
                      {$t(
                        "oauth.consent.cap.noLimitConfirm",
                        "I understand this app could spend all of my 2Z credits on AI.",
                      )}
                    </span>
                  </span>
                {/if}
              </span>
            </label>
          {/if}

          {#if raiseNeedsSignIn}
            <p
              class="text-sm text-muted-foreground"
              data-testid="oauth-cap-raise-note"
            >
              {$t(
                "oauth.consent.cap.raiseNote",
                "Raising your limit asks you to sign in again first.",
              )}
            </p>
          {/if}
        </fieldset>
      {/if}

      {#if app.privacy_url || app.terms_url}
        <p class="text-xs text-muted-foreground">
          {#if app.privacy_url && /^https:\/\//i.test(app.privacy_url)}
            <a
              href={app.privacy_url}
              target="_blank"
              rel="noopener noreferrer"
              class="underline underline-offset-2"
            >
              {$t("oauth.consent.privacy", "Privacy policy")}
            </a>
          {/if}
          {#if app.terms_url && /^https:\/\//i.test(app.terms_url)}
            <a
              href={app.terms_url}
              target="_blank"
              rel="noopener noreferrer"
              class="ml-3 underline underline-offset-2"
            >
              {$t("oauth.consent.terms", "Terms")}
            </a>
          {/if}
        </p>
      {/if}

      {#if phase === "stepUpLoop"}
        <div
          class="space-y-3 rounded-md border p-3 text-sm"
          role="alert"
          data-testid="oauth-consent-step-up-loop"
        >
          <p>
            {$t(
              "oauth.consent.stepUp.loop",
              "Free2Z could not confirm a recent sign-in, so the limit cannot be raised right now. Keep your current limit, or try again later.",
            )}
          </p>
          <Button variant="outline" onclick={keepCurrentCap}>
            {$t("oauth.consent.stepUp.keep", "Keep my current limit")}
          </Button>
        </div>
      {/if}

      {#if phase === "stepUp"}
        <div
          class="space-y-3 rounded-md border p-3 text-sm"
          role="alert"
          data-testid="oauth-consent-step-up"
        >
          <p>
            {$t(
              "oauth.consent.stepUp.body",
              "Raising the spending limit needs a recent sign-in. Keep your current limit, or sign in again to raise it.",
            )}
          </p>
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" onclick={keepCurrentCap}>
              {$t("oauth.consent.stepUp.keep", "Keep my current limit")}
            </Button>
            <Button onclick={reauthenticate} disabled={reauthBusy}>
              {$t("oauth.consent.reauth.button", "Sign in again")}
            </Button>
          </div>
          {#if reauthError}
            <p class="text-destructive">{reauthError}</p>
          {/if}
        </div>
      {/if}

      {#if submitError}
        <p
          class="text-sm text-destructive"
          role="alert"
          data-testid="oauth-consent-submit-error"
        >
          {submitError}
        </p>
      {/if}

      {#if phase !== "stepUp" && phase !== "stepUpLoop"}
        <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onclick={() => submit(false)}
            disabled={phase !== "consent"}
            data-testid="oauth-consent-deny"
          >
            {$t("oauth.consent.deny", "Cancel")}
          </Button>
          <Button
            onclick={() => submit(true)}
            disabled={!canApprove}
            data-testid="oauth-consent-allow"
          >
            {$t("oauth.consent.allow", "Allow")}
          </Button>
        </div>
      {/if}

      <!-- No link out: an app's sign-in flow never leaves for the rest of
           the site, whose navigation reaches Credits ($lib/sdk-flow). -->
      <p class="text-xs text-muted-foreground">
        {$t(
          "oauth.consent.revokeHint",
          "You can remove this app's access at any time in Connected apps.",
        )}
      </p>
    </section>
  {/if}
</main>
