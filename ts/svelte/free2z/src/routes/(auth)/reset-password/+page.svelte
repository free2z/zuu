<script lang="ts">
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { toast } from "svelte-sonner";
  import { apiFetch } from "$lib/api/config";
  import { authStore } from "$lib/stores/auth";
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
  let submitting = $state(false);
  let done = $state(false);
  let errorMessage = $state<string | null>(null);

  const MIN_LENGTH = 8;

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    errorMessage = null;

    if (!token) {
      errorMessage =
        "This reset link is missing its token. Request a new password reset email.";
      return;
    }
    if (password.length < MIN_LENGTH) {
      errorMessage = `Password must be at least ${MIN_LENGTH} characters.`;
      return;
    }
    if (password !== confirmPassword) {
      errorMessage = "The two passwords do not match.";
      return;
    }

    submitting = true;
    try {
      const response = await apiFetch("/api/emails/do-reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        errorMessage =
          result?.message ||
          result?.detail ||
          "We couldn't reset your password. The link may have expired — request a new one.";
        return;
      }

      // The backend logs the user in on success; hydrate the client session.
      done = true;
      toast.success("Password reset. You're now signed in.");
      await authStore.checkAuth({ force: true, silent: true });
      await goto("/");
    } catch {
      errorMessage =
        "Something went wrong resetting your password. Please try again.";
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:head>
  <title>Reset password · Free2Z</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<main class="flex flex-1 items-center justify-center bg-background px-4 py-12">
  <Card class="w-full max-w-md">
    <CardHeader>
      <CardTitle>Reset your password</CardTitle>
      <CardDescription>
        {#if token}
          Choose a new password for your account.
        {:else}
          This reset link is invalid or incomplete.
        {/if}
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if !token}
        <p class="text-sm text-muted-foreground">
          The link is missing its token. Password reset links expire, so it may
          simply be old — head to the login screen and choose “Forgot your
          password?” to get a fresh one.
        </p>
        <Button href="/login" variant="default" class="mt-4 w-full">
          Go to login
        </Button>
      {:else if done}
        <p class="text-sm text-muted-foreground">
          Your password has been reset and you're signed in. Redirecting…
        </p>
      {:else}
        <form class="space-y-4" onsubmit={handleSubmit}>
          <div class="space-y-2">
            <Label for="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autocomplete="new-password"
              bind:value={password}
              placeholder="At least {MIN_LENGTH} characters"
              required
            />
          </div>
          <div class="space-y-2">
            <Label for="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autocomplete="new-password"
              bind:value={confirmPassword}
              required
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
            {submitting ? "Resetting…" : "Reset password"}
          </Button>
        </form>
      {/if}
    </CardContent>
  </Card>
</main>
