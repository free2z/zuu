<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$lib/kit-stores";
  import { tStore as t } from "$lib/i18n";
  import { authModal, requestLogin } from "$lib/stores/auth-modal";
  import { getSafeNextPath } from "$lib/safe-next";
  import { parseLoginReason, type LoginReason } from "$lib/login-destination";
  import type { AuthModalView } from "$lib/stores/auth-modal";

  // Through the SAME guard the server load uses. This is the branch that
  // actually runs for an interactive login — the server only handles the
  // already-signed-in case — so reading the raw parameter here would have
  // left the open redirect the guard exists to close ( codex review).
  $: nextPath = getSafeNextPath($page.url.searchParams.get("next"));
  let initialView: AuthModalView = "login";
  $: initialView =
    $page.url.searchParams.get("view") === "signup" ? "signup" : "login";
  // Why the visitor is here, when a guard knows. Allow-listed — the
  // value comes straight off the URL and is rendered on a free2z origin.
  $: reason = parseLoginReason($page.url.searchParams.get("reason"));

  function reasonCopy(value: LoginReason | null): string {
    switch (value) {
      case "email-changed":
        return $t(
          "auth.signedOut.emailChanged",
          "Your email address was changed, so for security you were signed out on every device. Sign in again to continue.",
        );
      case "email-removed":
        return $t(
          "auth.signedOut.emailRemoved",
          "Your email address was removed, so for security you were signed out on every device. Sign in again to continue.",
        );
      case "session-expired":
        return $t(
          "auth.signedOut.sessionExpired",
          "Your session has ended. Sign in again to continue.",
        );
      case "reauthenticate":
        return $t(
          "auth.signedOut.reauthenticate",
          "The app you are connecting asked you to confirm it's you. Sign in again to continue.",
        );
      case "confirm-limit":
        return $t(
          "auth.signedOut.confirmLimit",
          "Raising an app's spending limit needs a recent sign-in. Sign in again to continue.",
        );
      case "delete-account":
        return $t(
          "auth.signedOut.deleteAccount",
          "Deleting your account needs a recent sign-in. Sign in again to continue.",
        );
      default:
        return "";
    }
  }

  // The page is a thin caller of the shared modal: the password → OTP
  // contract lives in AuthModalHost, and this page only adds the return trip.
  let requestId: number | undefined;
  function openLogin(trigger?: HTMLElement | null) {
    requestId = requestLogin({
      view: initialView,
      notice: reasonCopy(reason),
      trigger: trigger ?? null,
      onSuccess: () => {
        goto(nextPath || "/");
      },
    });
  }

  onMount(() => {
    // Show modal immediately when page loads
    openLogin();
    return () => authModal.close(requestId);
  });
</script>

<svelte:head>
  <title>{$t("auth.loginMetaTitle", "Log in · Free2Z")}</title>
  <meta
    name="description"
    content={$t(
      "auth.loginMetaDescription",
      "Log in to Free2Z or create an account.",
    )}
  />
</svelte:head>

<main class="flex flex-1 items-center justify-center bg-background">
  <!-- Background content when modal is closed -->
  {#if !$authModal.open}
    <div class="space-y-4 text-center">
      <h1 class="text-4xl font-bold text-foreground">
        {$t("auth.welcome", "Welcome to Free2Z")}
      </h1>
      {#if reason}
        <p
          class="mx-auto max-w-md text-muted-foreground"
          data-testid="login-reason"
        >
          {reasonCopy(reason)}
        </p>
      {:else}
        <p class="text-muted-foreground">
          {$t("auth.signInToContinue", "Please sign in to continue.")}
        </p>
      {/if}
      <button
        class="text-primary hover:underline"
        on:click={(e) => openLogin(e.currentTarget)}
      >
        {$t("auth.openLogin", "Open login")}
      </button>
    </div>
  {/if}
</main>
