<script lang="ts">
  import { formatDate } from "$lib/utils/date";
  /**
   * Delete your Free2Z account — `https://free2z.cash/account/delete`.
   *
   * This URL is a contract (Apple 5.1.1(v), Google Play account deletion):
   * SDK apps link here and it is the deletion URL listed on Google Play, so
   * it must work signed out too. Signed out, it says what deletion does and
   * opens the sign-in modal in place, keeping the URL. Signed in, it shows
   * what this account loses and deletes after two proofs: a sign-in within
   * the last five minutes (the backend's 401 `insufficient_user_authentication`
   * → the same re-authentication modal every step-up uses, any sign-in
   * method, never an email) and the account's username, typed. The typed
   * name is what the backend checks, so a persona switch inside the
   * re-authentication cannot delete an account the screen did not show.
   *
   * Backend: `dj.apps.g12f.account_deletion` (`/api/auth/account-deletion/`).
   */
  import { onMount } from "svelte";
  import { page } from "$lib/kit-stores";
  import { apiFetch } from "$lib/api/config";
  import { readApiError } from "$lib/api/api-errors.js";
  import { authStatus, authStore, currentUser } from "$lib/stores/auth";
  import { loginDestination } from "$lib/login-destination";
  import { tStore as t, getCurrentLocale } from "$lib/i18n";
  import { formatTuzis } from "$lib/utils/format-tuzis";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";

  const API = "/api/auth/account-deletion/";
  // Requesting deletion has its own path: before the grace period, a POST on
  // API deleted at once, and a backend that old must never receive one.
  const SCHEDULE_API = "/api/auth/account-deletion/schedule/";

  // A positive "the page is live" barrier for tests: absence assertions
  // (no auth modal, no reCAPTCHA) mean nothing until hydration has run.
  let hydrated = false;
  onMount(() => {
    hydrated = true;
  });
  const HELP_EMAIL = "help@free2z.com";

  type Preview = {
    username: string;
    balance_2z: string;
    connected_apps: number;
    pages: number;
    blockers: string[];
  };

  let preview: Preview | null = null;
  let loadState: "idle" | "loading" | "ready" | "error" = "idle";
  let confirmation = "";
  let deleting = false;
  let needsReauth = false;
  let errorText = "";
  let deleted = false;
  /** From the 202: when the purge runs, and when the username frees. */
  let purgeAfter = "";
  let usernameFreeAfter = "";
  let loadedFor: string | null = null;

  $: locale = getCurrentLocale();

  function formatDay(iso: string): string {
    if (!iso) return "";
    // $lib/utils/date: the viewer's zone, and the raw text back if unparseable.
    return formatDate(iso, locale, { dateStyle: "long" });
  }
  // The Navbar's rule: the store reads `unknown` during SSR and
  // until hydration; no `sessionid` cookie is the server's authoritative
  // "signed out", so the signed-out page renders on the first frame -- and
  // in the server HTML a store reviewer or crawler reads.
  $: resolvedStatus =
    $authStatus !== "unknown"
      ? $authStatus
      : $page.data.hasSession === false
        ? "anonymous"
        : "unknown";
  $: canDelete = Boolean(
    preview &&
    preview.blockers.length === 0 &&
    confirmation.trim() === preview.username &&
    !deleting,
  );
  $: hasBalance = preview ? Number(preview.balance_2z) > 0 : false;

  // Load (again) whenever the signed-in account changes: a re-authentication
  // that lands on a different persona must show THAT account, and the typed
  // confirmation is cleared so it has to be typed for it.
  $: if (!deleted && $authStatus === "authenticated" && $currentUser) {
    if (loadedFor !== $currentUser.username) {
      loadedFor = $currentUser.username;
      confirmation = "";
      needsReauth = false;
      errorText = "";
      void loadPreview();
    }
  }

  async function loadPreview() {
    loadState = "loading";
    try {
      const response = await apiFetch(API, { method: "GET" });
      if (!response.ok) {
        const failure = await readApiError(response);
        console.error(
          "account deletion preview failed",
          response.status,
          failure,
        );
        loadState = "error";
        return;
      }
      preview = (await response.json()) as Preview;
      loadState = "ready";
    } catch (error) {
      console.error("account deletion preview failed", error);
      loadState = "error";
    }
  }

  // Sign-in is ALWAYS a full navigation to /login, never the in-place auth
  // modal: only /login may load reCAPTCHA (owner ruling), and a plain link
  // works before hydration and from a store reviewer's bare browser.
  const SIGN_IN_HREF = loginDestination("/account/delete");
  let reauthBusy = false;

  /**
   * The fresh sign-in a deletion needs: sign out, then /login, then back
   * here. Continues only on a CONFIRMED sign-out (2xx, or the 401 of a
   * session already gone): a surviving session would bounce straight back
   * without the fresh sign-in the backend asked for (the consent page's and
   * /account/apps' rule).
   */
  async function reauthenticate() {
    reauthBusy = true;
    errorText = "";
    let signedOut = false;
    try {
      const response = await apiFetch("/api/auth/logout/", { method: "POST" });
      signedOut = response.ok || response.status === 401;
    } catch (error) {
      console.error("sign-out before re-authentication failed", error);
      signedOut = false;
    }
    if (!signedOut) {
      reauthBusy = false;
      errorText = $t(
        "oauth.consent.reauth.logoutFailed",
        "Free2Z could not sign you out to confirm it's you. Please try again.",
      );
      return;
    }
    authStore.clear();
    window.location.assign(
      loginDestination("/account/delete", "delete-account"),
    );
  }

  async function deleteAccount() {
    if (!preview || !canDelete) return;
    deleting = true;
    errorText = "";
    try {
      const response = await apiFetch(SCHEDULE_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm_username: confirmation.trim() }),
      });
      if (response.status === 202) {
        try {
          const body = (await response.json()) as {
            purge_after?: string;
            username_free_after?: string;
          };
          purgeAfter = body.purge_after ?? "";
          usernameFreeAfter = body.username_free_after ?? "";
        } catch (error) {
          console.error("account deletion: unreadable 202 body", error);
        }
        deleted = true;
        authStore.clear();
        return;
      }
      const failure = await readApiError(response);
      const code = (failure.data as { code?: string } | null)?.code;
      console.error("account deletion refused", response.status, code);
      if (code === "insufficient_user_authentication") {
        needsReauth = true;
      } else if (response.status === 409) {
        await loadPreview();
      } else if (code === "confirmation_mismatch") {
        errorText = $t(
          "account.delete.mismatch",
          "Type your username exactly as shown.",
        );
      } else if (response.status === 401 || response.status === 403) {
        loadedFor = null;
        await authStore.checkAuth({ force: true, silent: true });
      } else {
        errorText = $t(
          "account.delete.failed",
          "Your account was not deleted. Please try again.",
        );
      }
    } catch (error) {
      console.error("account deletion failed", error);
      errorText = $t(
        "account.delete.failed",
        "Your account was not deleted. Please try again.",
      );
    } finally {
      deleting = false;
    }
  }
</script>

<svelte:head>
  <title>{$t("account.delete.metaTitle", "Delete account · Free2Z")}</title>
</svelte:head>

<div
  class="mx-auto w-full max-w-2xl space-y-6 px-4 py-8"
  data-hydrated={hydrated ? "true" : undefined}
>
  <h1 class="text-2xl font-semibold">
    {$t("account.delete.title", "Delete your Free2Z account")}
  </h1>

  {#if deleted}
    <section class="space-y-3" role="status" data-testid="account-deleted">
      <p>
        {$t(
          "account.delete.requested",
          "Deletion requested. Your account is hidden now and will be deleted on {date}. To keep it, sign in before then.",
          { date: formatDay(purgeAfter) },
        )}
      </p>
      {#if usernameFreeAfter}
        <p class="text-sm text-muted-foreground">
          {$t(
            "account.delete.reservedUntil",
            "Your username stays reserved until {date}.",
            { date: formatDay(usernameFreeAfter) },
          )}
        </p>
      {/if}
      <a class="text-sm underline" href="/"
        >{$t("account.delete.home", "Go to Free2Z")}</a
      >
    </section>
  {:else}
    <section class="space-y-2 text-sm" data-testid="account-delete-terms">
      <h2 class="font-medium">
        {$t("account.delete.whatHappens", "What deleting does")}
      </h2>
      <ul class="list-disc space-y-1 pl-5">
        <li>
          {$t(
            "account.delete.removed",
            "Your profile, email and sign-in methods are removed, and you are signed out everywhere.",
          )}
        </li>
        <li>
          {$t(
            "account.delete.content",
            "Your pages, posts and uploads are deleted.",
          )}
        </li>
        <li>
          {$t(
            "account.delete.apps",
            "Apps you connected lose access to your account.",
          )}
        </li>
        <li>
          {$t(
            "account.delete.credits",
            "Remaining 2Z credits can no longer be used.",
          )}
        </li>
        <li>
          {$t(
            "account.delete.purchases",
            "Finish or cancel any purchase in progress first. Credits that arrive after deletion cannot be used.",
          )}
        </li>
        <li>
          {$t(
            "account.delete.kept",
            "Payment, 2Z ledger and tax records are kept without your profile, as law and accounting require.",
          )}
        </li>
        <li>
          {$t(
            "account.delete.grace",
            "Your account is hidden right away and deleted after 30 days. Signing in before then lets you keep it.",
          )}
        </li>
        <li>
          {$t(
            "account.delete.usernameReserved",
            "Your username stays reserved for 30 more days after that (about 60 days after you ask), then anyone can use it.",
          )}
        </li>
        <li>
          {$t(
            "account.delete.earningsWait",
            "If creator earnings are still owed after 30 days, deletion waits until support has paid them.",
          )}
        </li>
        <li>
          {$t(
            "account.delete.caches",
            "Copies of uploaded files can stay in caches for up to 24 hours after deletion.",
          )}
        </li>
        <li>
          {$t(
            "account.delete.held",
            "Content under review after a report is kept hidden until the review ends.",
          )}
        </li>
      </ul>
    </section>

    {#if resolvedStatus === "anonymous"}
      <section class="space-y-3" data-testid="account-delete-signed-out">
        <p>
          {$t(
            "account.delete.signInFirst",
            "Sign in to the account you want to delete. You will confirm before anything is deleted.",
          )}
        </p>
        <Button href={SIGN_IN_HREF} data-testid="account-delete-sign-in">
          {$t("account.delete.signIn", "Sign in")}
        </Button>
        <p class="text-sm text-muted-foreground">
          {$t("account.delete.cannotSignIn", "Can't sign in? Email {email}.", {
            email: HELP_EMAIL,
          })}
        </p>
      </section>
    {:else if resolvedStatus === "unknown" || loadState === "loading" || loadState === "idle"}
      <p class="text-muted-foreground" role="status">
        {$t("account.delete.loading", "Loading…")}
      </p>
    {:else if loadState === "error" || !preview}
      <div class="space-y-3" role="alert">
        <p class="text-muted-foreground">
          {$t("account.delete.loadFailed", "Your account could not be loaded.")}
        </p>
        <Button variant="outline" onclick={loadPreview}>
          {$t("oauth.consent.tryAgain", "Try again")}
        </Button>
      </div>
    {:else}
      <section
        class="space-y-4 rounded-lg border p-4"
        data-testid="account-delete-confirm"
      >
        <p>
          {$t("account.delete.signedInAs", "Signed in as @{username}", {
            username: preview.username,
          })}
        </p>
        {#if preview.connected_apps > 0 || hasBalance}
          <ul class="list-disc space-y-1 pl-5 text-sm">
            {#if preview.connected_apps > 0}
              <li data-testid="account-delete-apps">
                {$t(
                  "account.delete.appsCount",
                  "Connected apps losing access: {count}",
                  { count: preview.connected_apps },
                )}
              </li>
            {/if}
            {#if hasBalance}
              <li data-testid="account-delete-balance">
                {$t(
                  "account.delete.balance",
                  "2Z credits that can no longer be used: {balance}",
                  { balance: formatTuzis(preview.balance_2z, locale) },
                )}
              </li>
            {/if}
          </ul>
        {/if}

        {#if preview.blockers.includes("earnings_owed")}
          <p class="text-sm" role="alert" data-testid="account-delete-blocked">
            {$t(
              "account.delete.earningsOwed",
              "Creator earnings are still owed to you. Email {email} to receive them; then you can delete your account.",
              { email: HELP_EMAIL },
            )}
          </p>
        {:else if preview.blockers.includes("staff_account")}
          <p class="text-sm" role="alert" data-testid="account-delete-blocked">
            {$t(
              "account.delete.staffAccount",
              "This is a staff account. Another admin needs to remove its staff access before it can be deleted.",
            )}
          </p>
        {:else if preview.blockers.includes("app_has_users")}
          <p class="text-sm" role="alert" data-testid="account-delete-blocked">
            {$t(
              "account.delete.appHasUsers",
              "You own an app that people use. Email {email} to retire it; then you can delete your account.",
              { email: HELP_EMAIL },
            )}
          </p>
        {:else}
          <div class="space-y-2">
            <Label for="confirm-username">
              {$t("account.delete.typeUsername", "Type {username} to confirm", {
                username: preview.username,
              })}
            </Label>
            <Input
              id="confirm-username"
              bind:value={confirmation}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              data-testid="account-delete-username"
            />
          </div>

          {#if needsReauth}
            <div
              class="space-y-2 rounded-md border p-3 text-sm"
              role="alert"
              data-testid="account-delete-reauth"
            >
              <p>
                {$t(
                  "account.delete.reauth",
                  "For your security, sign in again, then delete.",
                )}
              </p>
              <Button
                variant="outline"
                onclick={reauthenticate}
                disabled={reauthBusy}
                data-testid="account-delete-reauth-button"
              >
                {$t("auth.signInAgain", "Sign in again")}
              </Button>
            </div>
          {/if}

          {#if errorText}
            <p class="text-sm text-destructive" role="alert">{errorText}</p>
          {/if}

          <Button
            variant="destructive"
            onclick={deleteAccount}
            disabled={!canDelete}
            data-testid="account-delete-submit"
          >
            {$t("account.delete.submit", "Delete account")}
          </Button>
        {/if}
      </section>
    {/if}
  {/if}
</div>
