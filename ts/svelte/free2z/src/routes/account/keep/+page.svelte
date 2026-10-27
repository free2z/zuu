<script lang="ts">
  import { formatDate } from "$lib/utils/date";
  /**
   * "Keep my account?" -- account deletion's 30-day grace period
   * (`dj.apps.g12f.account_deletion`).
   *
   * Every sign-in to an account whose deletion is pending lands here instead
   * of signing in, with a short-lived keep token in the URL fragment (never
   * sent to a server). "Keep my account" spends it: the deletion is
   * cancelled, the holder is signed in, and apps they had connected will ask
   * to connect again (grants are not restored). "Cancel" leaves the
   * deletion as it is. The fragment is stripped from the address bar as
   * soon as it is read.
   */
  import { onMount } from "svelte";
  import { apiFetch } from "$lib/api/config";
  import { readApiError } from "$lib/api/api-errors.js";
  import { readKeepFragment } from "$lib/account-keep";
  import { isSdkFlow } from "$lib/sdk-flow";
  import { authStore } from "$lib/stores/auth";
  import { tStore as t, getCurrentLocale } from "$lib/i18n";
  import { Button } from "$lib/components/ui/button";

  let token: string | null = null;
  let purgeAfter: string | null = null;
  // Where the sign-in was headed (an SDK app's authorize step): kept, the
  // holder continues there.
  let next: string | null = null;
  // Reached from an SDK app's sign-in: every exit stays inside the SDK's
  // commerce-free pages (sdk-flow.ts), so no link to the site's home.
  $: fromApp = (() => {
    if (!next) return false;
    try {
      return isSdkFlow(new URL(next, "https://next.invalid"));
    } catch (error) {
      console.error("keep page: unparseable next", error);
      return false;
    }
  })();
  let state: "loading" | "ask" | "keeping" | "kept" | "invalid" | "left" =
    "loading";
  let errorText = "";

  $: locale = getCurrentLocale();

  function formatDay(iso: string | null): string {
    if (!iso) return "";
    // $lib/utils/date: the viewer's zone, and the raw text back if unparseable.
    return formatDate(iso, locale, { dateStyle: "long" });
  }

  onMount(() => {
    const read = readKeepFragment(window.location.hash);
    // Strip the token from the address bar and history right away.
    try {
      history.replaceState(
        history.state,
        "",
        window.location.pathname + window.location.search,
      );
    } catch (error) {
      console.error("keep page: could not strip the fragment", error);
    }
    if (!read) {
      state = "invalid";
      return;
    }
    token = read.token;
    purgeAfter = read.purgeAfter;
    next = read.next;
    state = "ask";
  });

  async function keep() {
    if (!token) return;
    state = "keeping";
    errorText = "";
    try {
      const response = await apiFetch("/api/auth/account-deletion/keep/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keep_token: token }),
      });
      if (response.ok) {
        token = null;
        if (next) {
          window.location.assign(next);
          return;
        }
        state = "kept";
        await authStore.checkAuth({ force: true, silent: true });
        return;
      }
      const failure = await readApiError(response);
      console.error("keep account refused", response.status, failure);
      state = response.status === 400 ? "invalid" : "ask";
      if (state === "ask") {
        errorText = $t(
          "account.keep.failed",
          "Your account could not be kept. Please try again.",
        );
      }
    } catch (error) {
      console.error("keep account failed", error);
      state = "ask";
      errorText = $t(
        "account.keep.failed",
        "Your account could not be kept. Please try again.",
      );
    }
  }

  function leave() {
    token = null;
    state = "left";
  }
</script>

<svelte:head>
  <title>{$t("account.keep.metaTitle", "Keep your account · Free2Z")}</title>
</svelte:head>

<div class="mx-auto w-full max-w-xl space-y-6 px-4 py-8">
  <h1 class="text-2xl font-semibold">
    {$t("account.keep.title", "Your account is scheduled for deletion")}
  </h1>

  {#if state === "loading"}
    <p class="text-muted-foreground" role="status">
      {$t("account.delete.loading", "Loading…")}
    </p>
  {:else if state === "ask" || state === "keeping"}
    <section class="space-y-4" data-testid="account-keep-ask">
      <p>
        {#if purgeAfter}
          {$t(
            "account.keep.scheduledOn",
            "It will be deleted on {date}. Keep it to sign in.",
            { date: formatDay(purgeAfter) },
          )}
        {:else}
          {$t("account.keep.scheduled", "Keep it to sign in.")}
        {/if}
      </p>
      {#if errorText}
        <p class="text-sm text-destructive" role="alert">{errorText}</p>
      {/if}
      <div class="flex flex-wrap gap-2">
        <Button
          onclick={keep}
          disabled={state === "keeping"}
          data-testid="account-keep-confirm"
        >
          {$t("account.keep.keep", "Keep my account")}
        </Button>
        <Button
          variant="outline"
          onclick={leave}
          disabled={state === "keeping"}
          data-testid="account-keep-cancel"
        >
          {$t("account.keep.cancel", "Cancel")}
        </Button>
      </div>
    </section>
  {:else if state === "kept"}
    <section class="space-y-3" role="status" data-testid="account-kept">
      <p>
        {$t(
          "account.keep.kept",
          "Your account is back. Apps you'd connected will ask you to connect again.",
        )}
      </p>
      <a class="text-sm underline" href="/"
        >{$t("account.delete.home", "Go to Free2Z")}</a
      >
    </section>
  {:else if state === "left"}
    <section class="space-y-3" role="status" data-testid="account-keep-left">
      <p>
        {$t(
          "account.keep.left",
          "Nothing changed. Your account will still be deleted.",
        )}
      </p>
      {#if !fromApp}
        <a class="text-sm underline" href="/"
          >{$t("account.delete.home", "Go to Free2Z")}</a
        >
      {/if}
    </section>
  {:else}
    <section class="space-y-3" role="alert" data-testid="account-keep-invalid">
      <p>
        {$t(
          "account.keep.invalid",
          "This link has expired. Sign in again to keep your account.",
        )}
      </p>
      <a
        class="text-sm underline"
        href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
        >{$t("account.delete.signIn", "Sign in")}</a
      >
    </section>
  {/if}
</div>
