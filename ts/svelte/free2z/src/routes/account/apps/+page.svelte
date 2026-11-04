<script lang="ts">
  import { formatDateTime } from "$lib/utils/date";
  /**
   * Connected apps (; zuu docs/free2z/sdk/spec/oidc.md §5): every app this
   * account has authorized, what it may do, its spending limit and the
   * markup it was consented at — and revoking it. Revoking moves the grant's
   * generation (`agen`), so every token the app holds stops working.
   *
   * The spending limit is editable here (spec §5). Lowering it applies
   * at once; raising it (a higher amount, a different period, or no limit)
   * needs a sign-in within the last five minutes, so the backend answers 401
   * `insufficient_user_authentication` and the page offers a fresh sign-in
   * that returns here with the editor open. If the backend STILL refuses
   * after that sign-in, the page says so instead of offering another one
   * (the loop guard, `stepUpPhase`).
   *
   * `?client_id=<id>` is the "Manage Free2Z account" landing page an SDK app
   * opens in the system browser (zuu docs/free2z/sdk/INTEGRATION.md): the
   * page focuses on that one app — the signed-in account, the balance, this
   * app's budget, removing its access, deleting the account. It is account
   * management, never a sales pitch: the focused view carries no purchase
   * link or price, and the root layout renders it without the site
   * navigation and footer (`$lib/sdk-flow`), which reach Credits.
   */
  import { onMount } from "svelte";
  import { currentUser } from "$lib/stores/auth";
  import { page } from "$lib/kit-stores";
  import { replaceState } from "$app/navigation";
  import { tStore as t, getCurrentLocale } from "$lib/i18n";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import {
    oidcGrantCapUpdate,
    oidcGrantRevoke,
    oidcGrantsList,
  } from "$lib/api/oauth/oauth";
  import type { Grant, GrantCapUpdate } from "$lib/api/f2z.schemas";
  import { ApiError } from "$lib/api/mutator";
  import { apiFetch } from "$lib/api/config";
  import { loginDestination } from "$lib/login-destination";
  import {
    CAP_PERIODS,
    REAUTH_MARKER,
    capEditFrom,
    capUpdateBody,
    isCapPeriod,
    isCapRaise,
    markupPercent,
    resolveCapEdit,
    sameCap,
    stepUpPhase,
    type CapEdit,
    type SpendCap,
  } from "$lib/oidc/consent";
  import { capPeriodLabel, capSummary, scopeLabel } from "$lib/oidc/labels";
  import { manageAppFocus } from "$lib/sdk-flow";
  import { formatTuzis } from "$lib/utils/format-tuzis";

  /** Where the account deletion page lives (built separately). */
  const DELETE_ACCOUNT_PATH = "/account/delete";
  /**
   * Never link to a 404: the deletion page lands in its own change, so the
   * link appears only in a build that contains it. Resolved at build time,
   * and lazy, so nothing of that page is loaded here.
   */
  const hasDeletePage =
    Object.keys(import.meta.glob("/src/routes/account/delete/+page.svelte"))
      .length > 0;

  /** Query parameter that reopens the limit editor after a fresh sign-in. */
  const EDIT_LIMIT_PARAM = "edit_limit";

  let grants: Grant[] = [];
  let status: "loading" | "ready" | "error" = "loading";
  let revokeTarget: Grant | null = null;
  let revokeOpen = false;
  let revoking = false;
  let revokeError = "";
  let notice = "";

  $: locale = getCurrentLocale();
  // The SDK landing page: one app, and nothing to buy.
  $: focus = manageAppFocus($page.url);
  $: focused = focus !== null;
  $: focusClientId = focus?.clientId ?? null;
  $: visibleGrants = focused
    ? grants.filter(
        (g) => focusClientId !== null && g.client_id === focusClientId,
      )
    : grants;

  function formatDate(value: string): string {
    return formatDateTime(value, locale, { dateStyle: "medium" });
  }

  /** This page, keeping the focused app (and nothing else) in the URL. */
  function thisPage(extra?: URLSearchParams): string {
    const params = new URLSearchParams(extra);
    // An unusable id stays focused (empty), never falls back to the list.
    if (focused) params.set("client_id", focusClientId ?? "");
    const query = params.toString();
    return query ? `/account/apps?${query}` : "/account/apps";
  }

  function signInAgain() {
    window.location.assign(loginDestination(thisPage()));
  }

  function grantCap(grant: Grant): SpendCap {
    return {
      spend_cap_2z: grant.spend_cap_2z,
      cap_period: isCapPeriod(grant.cap_period) ? grant.cap_period : "month",
    };
  }

  // ------------------------------------------------------ limit editor
  let limitTarget: Grant | null = null;
  let limitOpen = false;
  let limitEdit: CapEdit = capEditFrom({
    spend_cap_2z: null,
    cap_period: "month",
  });
  let limitPhase: "edit" | "saving" | "stepUp" | "stepUpLoop" = "edit";
  let limitError = "";
  let reauthBusy = false;

  $: limitCurrent = limitTarget ? grantCap(limitTarget) : null;
  $: limitResolution = limitCurrent
    ? resolveCapEdit(limitEdit, limitCurrent)
    : null;
  $: limitIsRaise = Boolean(
    limitCurrent &&
    limitResolution?.ok &&
    isCapRaise(limitCurrent, limitResolution.cap),
  );
  $: limitUnchanged = Boolean(
    limitCurrent &&
    limitResolution?.ok &&
    sameCap(limitCurrent, limitResolution.cap),
  );

  function askLimit(grant: Grant) {
    limitTarget = grant;
    limitEdit = capEditFrom(grantCap(grant));
    limitPhase = "edit";
    limitError = "";
    limitOpen = true;
  }

  /**
   * The loop-guard marker covers ONE attempt: the one the fresh sign-in was
   * for. Once the editor closes, drop it (and the reopen parameter) so a
   * later raise on this same page gets its sign-in offer again.
   */
  function forgetFreshSignIn() {
    const url = new URL(window.location.href);
    if (
      !url.searchParams.has(REAUTH_MARKER) &&
      !url.searchParams.has(EDIT_LIMIT_PARAM)
    ) {
      return;
    }
    url.searchParams.delete(REAUTH_MARKER);
    url.searchParams.delete(EDIT_LIMIT_PARAM);
    try {
      replaceState(url, {});
    } catch {
      // Router not ready: the marker simply stays for this page load.
    }
  }

  function keepCurrentLimit() {
    limitOpen = false;
    limitTarget = null;
    limitPhase = "edit";
    forgetFreshSignIn();
  }

  async function saveLimit() {
    if (!limitTarget || !limitResolution?.ok) return;
    const target = limitTarget;
    let body: GrantCapUpdate;
    try {
      body = capUpdateBody(limitResolution.cap) as GrantCapUpdate;
    } catch {
      return;
    }
    limitPhase = "saving";
    limitError = "";
    try {
      const updated = await oidcGrantCapUpdate(target.application_id, body);
      grants = grants.map((g) =>
        g.application_id === updated.application_id ? updated : g,
      );
      notice = $t(
        "oauth.connectedApps.limitSaved",
        "The spending limit for {app} was updated.",
        { app: updated.name },
      );
      limitOpen = false;
      limitTarget = null;
      limitPhase = "edit";
      forgetFreshSignIn();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        const code =
          error.data && typeof error.data === "object"
            ? (error.data as Record<string, unknown>).code
            : undefined;
        if (code === "insufficient_user_authentication") {
          // The live URL, not `$page.url`: `forgetFreshSignIn` rewrites it
          // with a shallow `replaceState`, which the store does not reflect.
          limitPhase = stepUpPhase(new URLSearchParams(window.location.search));
          return;
        }
        signInAgain();
        return;
      }
      if (error instanceof ApiError && error.status === 403) {
        signInAgain();
        return;
      }
      limitPhase = "edit";
      if (error instanceof ApiError && error.status === 404) {
        // Revoked elsewhere: the list is simply stale.
        grants = grants.filter(
          (g) => g.application_id !== target.application_id,
        );
        limitOpen = false;
        limitTarget = null;
        return;
      }
      const code =
        error instanceof ApiError &&
        error.data &&
        typeof error.data === "object"
          ? (error.data as Record<string, unknown>).code
          : undefined;
      limitError =
        code === "cap_period_unsupported"
          ? $t(
              "oauth.connectedApps.limitPeriodUnsupported",
              "A limit “in total” cannot be enforced yet. Choose a daily, weekly or monthly limit.",
            )
          : $t(
              "oauth.connectedApps.limitFailed",
              "The spending limit could not be changed. Please try again.",
            );
    }
  }

  /**
   * The fresh sign-in a raise needs: sign out, then sign in and come back
   * here with the editor reopened and the loop-guard marker set. Continues
   * only on a CONFIRMED sign-out (2xx, or the 401 of a session already gone):
   * a surviving session would bounce straight back without the fresh
   * sign-in the backend asked for (the consent page's rule, ).
   */
  async function reauthenticateForLimit() {
    if (!limitTarget) return;
    reauthBusy = true;
    limitError = "";
    let signedOut = false;
    try {
      const response = await apiFetch("/api/auth/logout/", { method: "POST" });
      signedOut = response.ok || response.status === 401;
    } catch {
      signedOut = false;
    }
    if (!signedOut) {
      reauthBusy = false;
      limitError = $t(
        "oauth.consent.reauth.logoutFailed",
        "Free2Z could not sign you out to confirm it's you. Please try again.",
      );
      return;
    }
    const params = new URLSearchParams();
    params.set(EDIT_LIMIT_PARAM, limitTarget.application_id);
    params.set(REAUTH_MARKER, "1");
    window.location.assign(loginDestination(thisPage(params), "confirm-limit"));
  }

  async function load() {
    status = "loading";
    try {
      grants = await oidcGrantsList();
      status = "ready";
      const reopen = $page.url.searchParams.get(EDIT_LIMIT_PARAM);
      const target = reopen
        ? grants.find(
            (g) => g.application_id === reopen && g.scope.includes("ai:invoke"),
          )
        : undefined;
      if (target) askLimit(target);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        signInAgain();
        return;
      }
      status = "error";
    }
  }

  function askRevoke(grant: Grant) {
    revokeTarget = grant;
    revokeError = "";
    revokeOpen = true;
  }

  async function confirmRevoke() {
    if (!revokeTarget) return;
    const target = revokeTarget;
    revoking = true;
    revokeError = "";
    try {
      await oidcGrantRevoke(target.application_id);
      grants = grants.filter((g) => g.application_id !== target.application_id);
      notice = $t(
        "oauth.connectedApps.revoked",
        "{app} no longer has access.",
        {
          app: target.name,
        },
      );
      revokeOpen = false;
      revokeTarget = null;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // Already gone (revoked elsewhere): the list is simply stale.
        grants = grants.filter(
          (g) => g.application_id !== target.application_id,
        );
        revokeOpen = false;
        revokeTarget = null;
        return;
      }
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        signInAgain();
        return;
      }
      revokeError = $t(
        "oauth.connectedApps.revokeFailed",
        "Access could not be removed. Please try again.",
      );
    } finally {
      revoking = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<svelte:head>
  <title>{$t("oauth.connectedApps.metaTitle", "Connected apps · Free2Z")}</title
  >
</svelte:head>

<main class="mx-auto w-full max-w-3xl px-4 py-8">
  <header class="mb-6 space-y-1">
    <h1 class="text-2xl font-semibold">
      {focused
        ? $t("oauth.manage.title", "Your Free2Z account")
        : $t("oauth.connectedApps.title", "Connected apps")}
    </h1>
    {#if !focused}
      <p class="text-muted-foreground">
        {$t(
          "oauth.connectedApps.intro",
          "Apps you have allowed to use your Free2Z account. Removing access signs the app out everywhere.",
        )}
      </p>
    {/if}
  </header>

  {#if focused && $currentUser}
    <dl
      class="mb-6 grid gap-3 rounded-lg border bg-card p-4 text-sm sm:grid-cols-2"
      data-testid="manage-account"
    >
      <div>
        <dt class="text-muted-foreground">
          {$t("oauth.manage.account", "Signed in as")}
        </dt>
        <dd class="font-medium break-words" data-testid="manage-username">
          @{$currentUser.username}
        </dd>
      </div>
      <div>
        <dt class="text-muted-foreground">
          {$t("oauth.manage.balance", "2Z balance")}
        </dt>
        <dd class="font-medium" data-testid="manage-balance">
          {formatTuzis($currentUser.tuzis ?? "0", locale)} 2Z
        </dd>
      </div>
    </dl>
  {/if}

  {#if !focused && $currentUser}
    <div class="mb-6 space-y-2">
      <a
        class="text-sm underline"
        href={`/${encodeURIComponent($currentUser.username)}/dashboard/billing`}
        >{$t(
          "oauth.connectedApps.manageBalance",
          "Manage balance and purchases",
        )}</a
      >
      <p class="text-sm text-muted-foreground">
        {$t(
          "oauth.connectedApps.budgetHelp",
          "Budgets apply separately to each app’s spending from your account. They are not shared quotas or extra credits.",
        )}
      </p>
    </div>
  {/if}

  {#if notice}
    <p
      class="mb-4 rounded-md border bg-muted/40 p-3 text-sm"
      role="status"
      data-testid="connected-apps-notice"
    >
      {notice}
    </p>
  {/if}

  {#if status === "loading"}
    <p class="text-muted-foreground" role="status">
      {$t("oauth.connectedApps.loading", "Loading your connected apps…")}
    </p>
  {:else if status === "error"}
    <div class="space-y-3" role="alert">
      <p class="text-muted-foreground">
        {$t(
          "oauth.connectedApps.loadFailed",
          "Your connected apps could not be loaded.",
        )}
      </p>
      <Button onclick={load}>{$t("oauth.consent.tryAgain", "Try again")}</Button
      >
    </div>
  {:else if visibleGrants.length === 0}
    <p class="text-muted-foreground" data-testid="connected-apps-empty">
      {focused
        ? $t(
            "oauth.manage.notConnected",
            "This app is not connected to your Free2Z account.",
          )
        : $t(
            "oauth.connectedApps.empty",
            "You have not connected any apps to your Free2Z account.",
          )}
    </p>
  {:else}
    <ul class="space-y-4" data-testid="connected-apps-list">
      {#each visibleGrants as grant (grant.application_id)}
        <li
          class="space-y-3 rounded-lg border bg-card p-4"
          data-testid="connected-app"
          data-client-id={grant.client_id}
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="font-semibold break-words">{grant.name}</h2>
              <p class="text-sm text-muted-foreground">
                {#if grant.developer}
                  {$t("oauth.consent.developer", "Made by @{developer}", {
                    developer: grant.developer,
                  })}
                  ·
                {/if}
                {$t("oauth.connectedApps.since", "Connected {date}", {
                  date: formatDate(grant.consented_at),
                })}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onclick={() => askRevoke(grant)}
              data-testid="connected-app-revoke"
            >
              {$t("oauth.connectedApps.revoke", "Remove access")}
            </Button>
          </div>

          <ul class="space-y-1 text-sm">
            {#each grant.scope as scope (scope)}
              <li>{scopeLabel($t, scope)}</li>
            {/each}
          </ul>

          <dl class="grid gap-2 text-sm sm:grid-cols-2">
            {#if grant.scope.includes("ai:invoke")}
              <div>
                <dt class="text-muted-foreground">
                  {$t("oauth.connectedApps.limit", "Your app budget")}
                </dt>
                <dd
                  class="flex flex-wrap items-center gap-2"
                  data-testid="connected-app-limit"
                >
                  <span data-testid="connected-app-limit-value">
                    {capSummary($t, grantCap(grant), locale)}
                  </span>
                  <Button
                    variant="link"
                    size="sm"
                    class="h-auto p-0"
                    onclick={() => askLimit(grant)}
                    data-testid="connected-app-limit-edit"
                  >
                    {$t("oauth.connectedApps.changeLimit", "Change")}
                  </Button>
                </dd>
              </div>
            {/if}
            {#if grant.markup_bps > 0}
              <div>
                <dt class="text-muted-foreground">
                  {$t("oauth.connectedApps.markup", "App markup")}
                </dt>
                <dd>
                  {$t(
                    "oauth.consent.markup",
                    "This app adds {percent}% on top of the AI cost.",
                    { percent: markupPercent(grant.markup_bps, locale) },
                  )}
                </dd>
              </div>
            {/if}
          </dl>
        </li>
      {/each}
    </ul>
  {/if}

  {#if focused && hasDeletePage}
    <nav
      class="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm"
      data-testid="manage-links"
    >
      <a
        class="text-destructive underline underline-offset-2"
        href={DELETE_ACCOUNT_PATH}
        data-testid="manage-delete-account"
      >
        {$t("oauth.manage.deleteAccount", "Delete Free2Z account")}
      </a>
    </nav>
  {/if}
  {#if !focused}
    <!-- The unfocused list's way to account deletion; the focused
         `?client_id=` view has its own (manage-delete-account above). -->
    <p class="mt-10 text-sm">
      <a
        class="text-muted-foreground underline"
        href={DELETE_ACCOUNT_PATH}
        data-testid="connected-apps-delete-account"
        >{$t(
          "oauth.connectedApps.deleteAccount",
          "Delete your Free2Z account",
        )}</a
      >
    </p>
  {/if}
</main>

<Dialog.Root bind:open={revokeOpen}>
  <Dialog.Content data-testid="connected-app-revoke-dialog">
    <Dialog.Header>
      <Dialog.Title>
        {$t("oauth.connectedApps.confirmTitle", "Remove {app}'s access?", {
          app: revokeTarget?.name ?? "",
        })}
      </Dialog.Title>
      <Dialog.Description>
        {$t(
          "oauth.connectedApps.confirmBody",
          "The app is signed out right away and can no longer use your account or spend your 2Z credits. To use it again, you will need to allow it again.",
        )}
      </Dialog.Description>
    </Dialog.Header>
    {#if revokeError}
      <p class="text-sm text-destructive" role="alert">{revokeError}</p>
    {/if}
    <Dialog.Footer class="gap-2">
      <Button
        variant="outline"
        onclick={() => (revokeOpen = false)}
        disabled={revoking}
      >
        {$t("oauth.common.keep", "Keep access")}
      </Button>
      <Button
        variant="destructive"
        onclick={confirmRevoke}
        disabled={revoking}
        data-testid="connected-app-revoke-confirm"
      >
        {$t("oauth.connectedApps.revoke", "Remove access")}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root
  bind:open={limitOpen}
  onOpenChange={(open) => {
    if (!open) keepCurrentLimit();
  }}
>
  <Dialog.Content data-testid="connected-app-limit-dialog">
    <Dialog.Header>
      <Dialog.Title>
        {$t("oauth.connectedApps.limitTitle", "Spending limit for {app}", {
          app: limitTarget?.name ?? "",
        })}
      </Dialog.Title>
      <Dialog.Description>
        {$t(
          "oauth.connectedApps.limitBody",
          "The most 2Z credits this app may spend on AI for you. Lowering it applies right away; raising it asks you to sign in again first.",
        )}
      </Dialog.Description>
    </Dialog.Header>

    {#if limitCurrent}
      <p class="text-sm text-muted-foreground">
        {$t("oauth.connectedApps.limitNow", "Now: {limit}", {
          limit: capSummary($t, limitCurrent, locale),
        })}
      </p>
    {/if}

    {#if limitPhase === "stepUp"}
      <div
        class="space-y-3 rounded-md border p-3 text-sm"
        role="alert"
        data-testid="connected-app-limit-step-up"
      >
        <p>
          {$t(
            "oauth.consent.stepUp.body",
            "Raising the spending limit needs a recent sign-in. Keep your current limit, or sign in again to raise it.",
          )}
        </p>
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" onclick={keepCurrentLimit}>
            {$t("oauth.consent.stepUp.keep", "Keep my current limit")}
          </Button>
          <Button
            onclick={reauthenticateForLimit}
            disabled={reauthBusy}
            data-testid="connected-app-limit-reauth"
          >
            {$t("oauth.consent.reauth.button", "Sign in again")}
          </Button>
        </div>
      </div>
    {:else if limitPhase === "stepUpLoop"}
      <div
        class="space-y-3 rounded-md border p-3 text-sm"
        role="alert"
        data-testid="connected-app-limit-step-up-loop"
      >
        <p>
          {$t(
            "oauth.consent.stepUp.loop",
            "Free2Z could not confirm a recent sign-in, so the limit cannot be raised right now. Keep your current limit, or try again later.",
          )}
        </p>
        <Button variant="outline" onclick={keepCurrentLimit}>
          {$t("oauth.consent.stepUp.keep", "Keep my current limit")}
        </Button>
      </div>
    {:else}
      <fieldset class="space-y-3" data-testid="connected-app-limit-form">
        <legend class="sr-only">
          {$t("oauth.consent.cap.legend", "Optional app budget")}
        </legend>
        <label
          class="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary"
        >
          <input
            type="radio"
            name="limit-kind"
            value="limit"
            bind:group={limitEdit.kind}
            class="mt-1"
            data-testid="connected-app-limit-kind-limit"
          />
          <span class="flex-1 space-y-2 text-sm">
            <span class="font-medium">
              {$t("oauth.connectedApps.limitSet", "A limit")}
            </span>
            {#if limitEdit.kind === "limit"}
              <span class="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  inputmode="numeric"
                  pattern="[0-9]*"
                  bind:value={limitEdit.amount}
                  class="h-9 w-32 rounded-md border bg-background px-3 text-sm"
                  aria-label={$t(
                    "oauth.consent.cap.amountLabel",
                    "Limit in 2Z credits",
                  )}
                  aria-invalid={limitResolution !== null &&
                    !limitResolution.ok &&
                    limitResolution.reason === "amount"}
                  data-testid="connected-app-limit-amount"
                />
                <span>2Z</span>
                <select
                  bind:value={limitEdit.period}
                  class="h-9 rounded-md border bg-background px-2 text-sm"
                  aria-label={$t("oauth.consent.cap.periodLabel", "Period")}
                  data-testid="connected-app-limit-period"
                >
                  {#each CAP_PERIODS as period (period)}
                    <option value={period}>{capPeriodLabel($t, period)}</option>
                  {/each}
                </select>
              </span>
              {#if limitResolution && !limitResolution.ok && limitResolution.reason === "amount"}
                <span class="block text-destructive" role="alert">
                  {$t(
                    "oauth.consent.cap.amountInvalid",
                    "Enter a whole number of 2Z credits, 1 or more.",
                  )}
                </span>
              {/if}
            {/if}
          </span>
        </label>
        <label
          class="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-destructive"
        >
          <input
            type="radio"
            name="limit-kind"
            value="none"
            bind:group={limitEdit.kind}
            class="mt-1"
            data-testid="connected-app-limit-kind-none"
          />
          <span class="flex-1 space-y-2 text-sm">
            <span class="font-medium"
              >{$t(
                "oauth.cap.noLimit",
                "Available balance (no extra budget)",
              )}</span
            >
            {#if limitEdit.kind === "none" && limitCurrent?.spend_cap_2z !== null}
              <span class="flex items-start gap-2 text-destructive">
                <input
                  type="checkbox"
                  bind:checked={limitEdit.noCapConfirmed}
                  class="mt-0.5"
                  data-testid="connected-app-limit-none-confirm"
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
        {#if limitIsRaise}
          <p
            class="text-sm text-muted-foreground"
            data-testid="connected-app-limit-raise-note"
          >
            {$t(
              "oauth.consent.cap.raiseNote",
              "Raising your limit asks you to sign in again first.",
            )}
          </p>
        {/if}
      </fieldset>
    {/if}

    {#if limitError}
      <p
        class="text-sm text-destructive"
        role="alert"
        data-testid="connected-app-limit-error"
      >
        {limitError}
      </p>
    {/if}

    {#if limitPhase === "edit" || limitPhase === "saving"}
      <Dialog.Footer class="gap-2">
        <Button
          variant="outline"
          onclick={keepCurrentLimit}
          disabled={limitPhase === "saving"}
        >
          {$t("oauth.common.cancel", "Cancel")}
        </Button>
        <Button
          onclick={saveLimit}
          disabled={limitPhase === "saving" ||
            !limitResolution?.ok ||
            limitUnchanged}
          data-testid="connected-app-limit-save"
        >
          {$t("oauth.connectedApps.limitSave", "Save limit")}
        </Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
