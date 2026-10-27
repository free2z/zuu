<script lang="ts">
  import { isDeletionPending, keepPageHref } from "$lib/account-keep";
  import { onMount } from "svelte";
  import { page } from "$lib/kit-stores";
  import { goto } from "$app/navigation";
  import { toast } from "$lib/toast.js";
  import { apiFetch } from "$lib/api/config";
  import { authStore } from "$lib/stores/auth";
  import { tStore as t } from "$lib/i18n";
  import { describeResetPasswordFailure } from "$lib/password-reset-errors";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card";

  let token = $derived($page.url.searchParams.get("token") ?? "");

  let password = $state("");
  let confirmPassword = $state("");
  let otpToken = $state("");
  let submitting = $state(false);
  let done = $state(false);
  let errorMessage = $state<string | null>(null);

  const MIN_LENGTH = 8;

  // The form is server-rendered, so "visible" is not "interactive": a submit
  // before hydration reaches no handler. Exposed as `data-hydrated` so a
  // browser test can wait for the real state instead of a sleep.
  let hydrated = $state(false);
  onMount(() => {
    hydrated = true;
  });

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    errorMessage = null;

    if (!token) {
      errorMessage = $t(
        "auth.passwordReset.errors.missingToken",
        "This reset link is missing its token. Request a new password reset email.",
      );
      return;
    }
    if (password.length < MIN_LENGTH) {
      errorMessage = $t(
        "auth.passwordReset.errors.minimumLength",
        "Password must be at least {count} characters.",
        {
          count: MIN_LENGTH,
        },
      );
      return;
    }
    if (password !== confirmPassword) {
      errorMessage = $t(
        "auth.errors.passwordsNotMatch",
        "Passwords do not match",
      );
      return;
    }

    submitting = true;
    try {
      const body: { token: string; password: string; otp_token?: string } = {
        token,
        password,
      };
      if (otpToken.trim()) body.otp_token = otpToken.trim();

      const response = await apiFetch("/api/emails/do-reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          // Non-JSON (a proxy's 502 page): classified by status alone.
        }
        // The new password is set, but the account is in its deletion
        // grace period: the holder chooses "Keep my account" first.
        if (response.status === 409 && isDeletionPending(body)) {
          window.location.assign(keepPageHref(body));
          return;
        }
        // Each refusal gets its own catalog key. Choosing between
        // two fallbacks of ONE key only ever showed that key's translation,
        // so every failure used to read "the link may have expired".
        errorMessage = describeResetPasswordFailure(
          {
            status: response.status,
            body,
            retryAfter: response.headers.get("Retry-After"),
            minLength: MIN_LENGTH,
          },
          (key, fallback, params) => $t(key, fallback, params),
        ).message;
        return;
      }

      // The backend logs the user in on success; hydrate the client session.
      done = true;
      const authenticated = await authStore.checkAuth({
        force: true,
        silent: true,
      });
      // Announce after the intentional identity transition, under its new scope.
      toast.success(
        authenticated
          ? $t(
              "auth.passwordReset.success",
              "Password reset. You're now signed in.",
            )
          : $t(
              "auth.passwordReset.completed",
              "Password reset. Sign in to continue.",
            ),
      );
      await goto("/");
    } catch {
      errorMessage = $t(
        "auth.passwordReset.errors.generic",
        "Something went wrong resetting your password. Please try again.",
      );
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:head>
  <title>{$t("auth.passwordReset.metaTitle", "Reset password · Free2Z")}</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<main class="flex flex-1 items-center justify-center bg-background px-4 py-12">
  <Card class="w-full max-w-md">
    <CardHeader>
      <CardTitle>{$t("auth.resetPasswordTitle", "Reset Password")}</CardTitle>
      <CardDescription>
        {#if token}
          {$t(
            "auth.passwordReset.chooseNew",
            "Choose a new password for your account.",
          )}
        {:else}
          {$t(
            "auth.passwordReset.invalidLink",
            "This reset link is invalid or incomplete.",
          )}
        {/if}
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if !token}
        <p class="text-sm text-muted-foreground">
          {$t(
            "auth.passwordReset.invalidLinkBody",
            "The link is missing its token. Password reset links expire, so it may simply be old — head to the login screen and choose “Forgot your password?” to get a fresh one.",
          )}
        </p>
        <Button href="/login" variant="default" class="mt-4 w-full">
          {$t("auth.passwordReset.goToLogin", "Go to login")}
        </Button>
      {:else if done}
        <p class="text-sm text-muted-foreground">
          {$t(
            "auth.passwordReset.redirecting",
            "Your password has been reset and you're signed in. Redirecting…",
          )}
        </p>
      {:else}
        <form
          class="space-y-4"
          data-hydrated={hydrated}
          onsubmit={handleSubmit}
        >
          <div class="space-y-2">
            <Label for="new-password"
              >{$t("auth.passwordReset.newPassword", "New password")}</Label
            >
            <Input
              id="new-password"
              type="password"
              autocomplete="new-password"
              bind:value={password}
              placeholder={$t(
                "auth.passwordReset.minimumLengthPlaceholder",
                "At least {count} characters",
                {
                  count: MIN_LENGTH,
                },
              )}
              required
            />
          </div>
          <div class="space-y-2">
            <Label for="confirm-password"
              >{$t(
                "auth.passwordReset.confirmNewPassword",
                "Confirm new password",
              )}</Label
            >
            <Input
              id="confirm-password"
              type="password"
              autocomplete="new-password"
              bind:value={confirmPassword}
              required
            />
          </div>
          <div class="space-y-2">
            <Label for="reset-otp-token"
              >{$t(
                "auth.passwordReset.otpLabel",
                "Authenticator code (if MFA is enabled)",
              )}</Label
            >
            <Input
              id="reset-otp-token"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              bind:value={otpToken}
              maxlength={10}
              placeholder="000000"
            />
          </div>

          {#if errorMessage}
            <p class="text-sm text-destructive" role="alert">{errorMessage}</p>
          {/if}

          <Button
            type="submit"
            variant="default"
            class="w-full"
            disabled={submitting}
          >
            {submitting
              ? $t("auth.passwordReset.resetting", "Resetting…")
              : $t("auth.passwordReset.submit", "Reset password")}
          </Button>
        </form>
      {/if}
    </CardContent>
  </Card>
</main>
