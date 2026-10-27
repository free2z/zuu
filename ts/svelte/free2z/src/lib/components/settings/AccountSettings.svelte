<script lang="ts">
  import { onMount } from "svelte";
  import { toast, captureAccountToast } from "$lib/toast.js";
  import { mode, resetMode, setMode, userPrefersMode } from "mode-watcher";
  import { requestLogin } from "$lib/stores/auth-modal";
  import { readApiError } from "$lib/api/api-errors.js";
  import { apiFetch } from "$lib/api/config";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Badge } from "$lib/components/ui/badge";
  import { Switch } from "$lib/components/ui/switch";
  import * as Card from "$lib/components/ui/card";
  import { Sun, Moon, Laptop } from "@lucide/svelte";
  import ModeToggle from "../layout/ModeToggle.svelte";
  import { tStore as t, getCurrentLocale } from "$lib/i18n";
  import { formatDate } from "$lib/utils/date";
  import { authStore } from "$lib/stores/auth";
  import { loginDestination, type LoginReason } from "$lib/login-destination";

  export let username: string;
  export let initialEmail: string | null = null;

  type EmailStatus = {
    email: string | null;
    confirmed: boolean;
    pending: boolean;
    is_public: boolean;
    get_notifications: boolean;
  };

  let email = initialEmail || "";
  let emailStatus: EmailStatus | null = null;
  let emailStatusLoading = false;
  let emailStatusError = "";
  let emailActionLoading = false;
  let emailPublic = false;
  let emailNotifications = false;
  let emailDirty = false;
  let emailNeedsReauth = false;
  let mentionNotifications = false;
  let mentionPreferenceLoading = false;

  let themePreference: "light" | "dark" | "system" = "system";
  let derivedMode: "light" | "dark" | undefined = undefined;
  let themeDescription = "";

  $: themeOptions = [
    {
      value: "light",
      label: $t("theme.light", "Light"),
      description: $t(
        "settings.account.themeAlwaysLight",
        "Always use light mode.",
      ),
      icon: Sun,
      action: () => setMode("light"),
    },
    {
      value: "dark",
      label: $t("theme.dark", "Dark"),
      description: $t(
        "settings.account.themeAlwaysDark",
        "Always use dark mode.",
      ),
      icon: Moon,
      action: () => setMode("dark"),
    },
    {
      value: "system",
      label: $t("theme.system", "System"),
      description: $t(
        "settings.account.themeFollowDevice",
        "Follow your device settings.",
      ),
      icon: Laptop,
      action: () => resetMode(),
    },
  ];

  $: themePreference = (userPrefersMode.current || "system") as
    "light" | "dark" | "system";
  $: derivedMode = mode.current;
  $: themeDescription =
    themeOptions.find((option) => option.value === themePreference)
      ?.description || "";

  async function fetchEmailStatus() {
    emailStatusLoading = true;
    emailStatusError = "";
    try {
      const response = await apiFetch("/api/emails/status", { method: "GET" });
      if (!response.ok) {
        emailStatusError = $t(
          "settings.account.errors.fetchEmailStatus",
          "Failed to fetch email status.",
        );
        return;
      }
      const data = await response.json();
      if (
        typeof data?.confirmed !== "boolean" ||
        !(data.email === null || typeof data.email === "string")
      ) {
        throw new Error("Invalid email status");
      }
      emailStatus = data;
      emailPublic = Boolean(data?.is_public);
      emailNotifications = Boolean(data?.get_notifications);
      if (!emailDirty) {
        email = data?.email || "";
      }
    } catch {
      emailStatusError = $t(
        "settings.account.errors.fetchEmailStatus",
        "Failed to fetch email status.",
      );
    } finally {
      emailStatusLoading = false;
    }
  }

  async function handleEmailUpdate() {
    const operationNotice = captureAccountToast();
    if (emailActionLoading || !canMutateEmail) return;
    const trimmed = email.trim();
    if (!trimmed) {
      operationNotice.error(
        $t("settings.account.errors.emailRequired", "Enter an email address."),
      );
      return;
    }
    if (emailStatus?.confirmed && emailStatus.email === trimmed) {
      operationNotice.info(
        $t(
          "settings.account.emailAlreadyConfirmed",
          "Email already confirmed.",
        ),
      );
      return;
    }
    if (!emailStatus?.confirmed && emailStatus?.email === trimmed) {
      await handleEmailResend();
      return;
    }
    // Decided from the status we showed the warning for, before the write.
    const signsOutEverywhere =
      hasConfirmedEmail && emailStatus?.email !== trimmed;
    emailActionLoading = true;
    try {
      const response = await apiFetch("/api/emails/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      if (!response.ok) {
        const failure = await readApiError(response);
        const data = failure.data as { code?: string } | null;
        emailNeedsReauth = data?.code === "insufficient_user_authentication";
        operationNotice.error(
          failure.message ||
            $t(
              "settings.account.errors.updateEmail",
              "Failed to update email.",
            ),
        );
        return;
      }
      emailNeedsReauth = false;
      if (signsOutEverywhere) {
        leaveForLogin("email-changed");
        return;
      }
      operationNotice.acknowledge(
        $t("settings.account.emailUpdateRequested", "Email update requested."),
      );
      emailDirty = false;
      await fetchEmailStatus();
    } catch {
      operationNotice.error(
        $t("settings.account.errors.updateEmail", "Failed to update email."),
      );
    } finally {
      emailActionLoading = false;
    }
  }

  function reauthenticateEmail() {
    requestLogin({
      reauthentication: true,
      notice: $t(
        "settings.account.reauthenticate",
        "Sign in again to update your recovery email. Your pending email stays here; save it after signing in.",
      ),
      onSuccess: (creator) => {
        emailNeedsReauth = false;
        if (creator?.username !== username) {
          // Never carry this account's pending recovery address to another account.
          email = "";
          window.location.assign(
            `/${encodeURIComponent(creator?.username || "")}/dashboard/settings`,
          );
        }
      },
    });
  }

  async function handleEmailResend() {
    const operationNotice = captureAccountToast();
    if (emailActionLoading || !emailStatus?.email) return;
    emailActionLoading = true;
    try {
      const response = await apiFetch("/api/emails/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailStatus.email }),
      });
      if (!response.ok) {
        operationNotice.error(
          $t("settings.account.errors.resendEmail", "Failed to resend email."),
        );
        return;
      }
      operationNotice.success(
        $t("settings.account.confirmationResent", "Confirmation email resent."),
      );
      await fetchEmailStatus();
    } catch {
      operationNotice.error(
        $t("settings.account.errors.resendEmail", "Failed to resend email."),
      );
    } finally {
      emailActionLoading = false;
    }
  }

  async function handleEmailDelete() {
    const operationNotice = captureAccountToast();
    if (emailActionLoading || !canMutateEmail) return;
    const signsOutEverywhere = hasConfirmedEmail;
    emailActionLoading = true;
    try {
      const response = await apiFetch("/api/emails/delete", {
        method: "DELETE",
      });
      if (!response.ok) {
        operationNotice.error(
          $t("settings.account.errors.deleteEmail", "Failed to delete email."),
        );
        return;
      }
      if (signsOutEverywhere) {
        leaveForLogin("email-removed");
        return;
      }
      operationNotice.success(
        $t("settings.account.emailDeleted", "Email deleted."),
      );
      email = "";
      emailDirty = false;
      await fetchEmailStatus();
    } catch {
      operationNotice.error(
        $t("settings.account.errors.deleteEmail", "Failed to delete email."),
      );
    } finally {
      emailActionLoading = false;
    }
  }

  async function handleEmailPublicToggle(nextValue: boolean) {
    const operationNotice = captureAccountToast();
    if (!emailStatus) return;
    emailPublic = nextValue;
    try {
      const response = await apiFetch("/api/emails/public", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: nextValue }),
      });
      if (!response.ok) {
        operationNotice.error(
          $t(
            "settings.account.errors.updatePublicEmail",
            "Failed to update public email.",
          ),
        );
        emailPublic = !nextValue;
        return;
      }
      emailStatus = { ...emailStatus, is_public: nextValue };
      operationNotice.success(
        $t("settings.account.publicEmailUpdated", "Public email updated."),
      );
    } catch {
      emailPublic = !nextValue;
      operationNotice.error(
        $t(
          "settings.account.errors.updatePublicEmail",
          "Failed to update public email.",
        ),
      );
    }
  }

  async function handleEmailNotificationsToggle(nextValue: boolean) {
    const operationNotice = captureAccountToast();
    if (!emailStatus) return;
    emailNotifications = nextValue;
    try {
      const response = await apiFetch("/api/emails/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: nextValue }),
      });
      if (!response.ok) {
        operationNotice.error(
          $t(
            "settings.account.errors.updateNotifications",
            "Failed to update notifications.",
          ),
        );
        emailNotifications = !nextValue;
        return;
      }
      emailStatus = { ...emailStatus, get_notifications: nextValue };
      operationNotice.success(
        $t(
          "settings.account.notificationsUpdated",
          "Email notifications updated.",
        ),
      );
    } catch {
      emailNotifications = !nextValue;
      operationNotice.error(
        $t(
          "settings.account.errors.updateNotifications",
          "Failed to update notifications.",
        ),
      );
    }
  }

  async function fetchMentionPreference() {
    try {
      const response = await apiFetch("/api/events/mention-preference", {
        method: "GET",
      });
      if (response.ok) {
        mentionNotifications = Boolean((await response.json())?.enabled);
      }
    } catch {
      // Keep opt-in disabled when the preference endpoint is unavailable.
    }
  }

  async function handleMentionNotificationsToggle(nextValue: boolean) {
    const operationNotice = captureAccountToast();
    if (mentionPreferenceLoading) return;
    const previous = mentionNotifications;
    mentionNotifications = nextValue;
    mentionPreferenceLoading = true;
    try {
      const response = await apiFetch("/api/events/mention-preference", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextValue }),
      });
      if (!response.ok) {
        mentionNotifications = previous;
        operationNotice.error(
          $t(
            "settings.account.errors.updateMentionNotifications",
            "Failed to update mention notifications.",
          ),
        );
      }
    } catch {
      mentionNotifications = previous;
      operationNotice.error(
        $t(
          "settings.account.errors.updateMentionNotifications",
          "Failed to update mention notifications.",
        ),
      );
    } finally {
      mentionPreferenceLoading = false;
    }
  }

  // Replacing or removing a CONFIRMED address is an account-ownership event:
  // the backend revokes every session and token the account has,
  // including the one this tab is using, so the next request 401s.
  // The server does not announce it; this component knows it is coming and
  // says so — before (the warning below the field) and after (the login page
  // explains why). Adding a first address, or re-sending for a pending one,
  // signs nobody out.
  $: canMutateEmail =
    !emailStatusLoading && !emailStatusError && emailStatus !== null;
  $: hasConfirmedEmail = Boolean(emailStatus?.confirmed && emailStatus.email);

  function leaveForLogin(reason: LoginReason) {
    // The credentials are already gone server-side. Drop the cached store
    // (so the next document does not render as signed in for a beat) and
    // load the login page as a NEW document, like a logout does — nothing
    // fetched under the old session survives into it.
    authStore.clear();
    window.location.assign(
      loginDestination(`/${username}/dashboard/settings`, reason),
    );
  }

  // When a sign-in last kept this account during a deletion grace period:
  // shown so an unwanted "Keep my account" is visible and can be undone by
  // requesting deletion again.
  let deletionCancelledAt: string | null = null;
  async function fetchDeletionState() {
    try {
      const response = await apiFetch("/api/auth/account-deletion/", {
        method: "GET",
      });
      if (!response.ok) return;
      const body = (await response.json()) as {
        deletion_cancelled_at?: string | null;
      };
      deletionCancelledAt = body.deletion_cancelled_at ?? null;
    } catch (error) {
      console.error("settings: could not read deletion state", error);
    }
  }

  onMount(() => {
    fetchEmailStatus();
    fetchMentionPreference();
    void fetchDeletionState();
  });
</script>

<div class="space-y-8">
  <div class="space-y-6">
    <div>
      <h3 class="text-lg font-medium">
        {$t("settings.account.identityHub", "Identity Hub")}
      </h3>
      <p class="text-sm text-muted-foreground">
        {$t(
          "settings.account.identityDescription",
          "Manage your system identifiers and contact points.",
        )}
      </p>
    </div>

    <div class="grid gap-8 md:grid-cols-2">
      <div class="space-y-2">
        <Label
          >{$t("settings.account.uniqueIdentifier", "Unique Identifier")}</Label
        >
        <div
          class="flex items-center gap-1 rounded-md border bg-muted/50 px-3 py-2 font-mono text-sm text-foreground"
        >
          <span class="text-muted-foreground">@</span>
          <span>{username}</span>
        </div>
      </div>

      <div class="space-y-2">
        <Label for="primaryEmail"
          >{$t("settings.account.emailAddress", "Email Address")}</Label
        >
        <div class="flex flex-col gap-2 md:flex-row">
          <Input
            id="primaryEmail"
            type="email"
            bind:value={email}
            oninput={() => (emailDirty = true)}
            placeholder={$t(
              "settings.account.emailPlaceholder",
              "you@domain.com",
            )}
            class="flex-1"
          />
          <Button
            onclick={handleEmailUpdate}
            disabled={emailActionLoading || !canMutateEmail}
          >
            {#if emailActionLoading}
              <span class="flex items-center gap-2">
                <span
                  class="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
                ></span>
                {$t("settings.account.updating", "Updating...")}
              </span>
            {:else}
              {$t("settings.account.update", "Update")}
            {/if}
          </Button>
        </div>

        {#if emailNeedsReauth}
          <div
            role="alert"
            class="space-y-2"
            data-testid="email-reauthentication"
          >
            <p class="text-sm">
              {$t(
                "settings.account.reauthenticate",
                "Sign in again to update your recovery email. Your pending email stays here; save it after signing in.",
              )}
            </p>
            <Button variant="outline" onclick={reauthenticateEmail}
              >{$t("auth.signInAgain", "Sign in again")}</Button
            >
          </div>
        {/if}

        {#if hasConfirmedEmail}
          <!-- Pre-confirm copy: shown while a confirmed address is on
               file, i.e. exactly when Update-to-a-new-address or Remove would
               revoke every session the account has. -->
          <p
            class="text-xs text-amber-700 dark:text-amber-400"
            role="note"
            data-testid="email-signout-warning"
          >
            {$t(
              "settings.account.signOutEverywhereWarning",
              "For security, changing or removing your confirmed email signs you out on all your devices, including this one.",
            )}
          </p>
        {/if}

        <div class="space-y-2">
          {#if emailStatusLoading}
            <p class="text-xs text-muted-foreground">
              {$t(
                "settings.account.checkingEmailStatus",
                "Checking email status...",
              )}
            </p>
          {:else if emailStatusError}
            <p class="text-xs text-destructive">{emailStatusError}</p>
            <Button variant="outline" size="sm" onclick={fetchEmailStatus}>
              {$t("settings.account.retryEmailStatus", "Retry email status")}
            </Button>
          {:else if emailStatus}
            <div class="flex flex-col gap-3 pt-2">
              <div class="flex items-center gap-2">
                {#if emailStatus.confirmed}
                  <Badge
                    variant="secondary"
                    class="bg-green-500/10 text-green-600 hover:bg-green-500/20"
                    >{$t("settings.account.confirmed", "Confirmed")}</Badge
                  >
                {:else if emailStatus.pending}
                  <Badge
                    variant="secondary"
                    class="bg-yellow-500/10 text-yellow-600 hover:bg-yellow-500/20"
                    >{$t("settings.account.pending", "Pending")}</Badge
                  >
                {:else}
                  <Badge variant="secondary"
                    >{$t("settings.account.unverified", "Unverified")}</Badge
                  >
                {/if}
              </div>

              {#if emailStatus.confirmed}
                <div class="flex flex-wrap items-center gap-6">
                  <div class="flex items-center gap-2">
                    <Switch
                      checked={emailPublic}
                      onCheckedChange={handleEmailPublicToggle}
                      id="public-email"
                    />
                    <Label for="public-email" class="cursor-pointer font-normal"
                      >{$t(
                        "settings.account.publicVisibility",
                        "Public visibility",
                      )}</Label
                    >
                  </div>
                  <div class="flex items-center gap-2">
                    <Switch
                      checked={emailNotifications}
                      onCheckedChange={handleEmailNotificationsToggle}
                      id="notify-email"
                    />
                    <Label for="notify-email" class="cursor-pointer font-normal"
                      >{$t(
                        "settings.account.receiveNotifications",
                        "Receive notifications",
                      )}</Label
                    >
                  </div>
                </div>
                <div>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="pl-0 text-destructive hover:text-destructive"
                    onclick={handleEmailDelete}
                    disabled={emailActionLoading}
                    >{$t(
                      "settings.account.removeEmail",
                      "Remove Email",
                    )}</Button
                  >
                </div>
              {:else if emailStatus.email}
                <div class="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onclick={handleEmailResend}
                    disabled={emailActionLoading}
                    >{$t(
                      "settings.account.resendConfirmation",
                      "Resend Confirmation",
                    )}</Button
                  >
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={handleEmailDelete}
                    disabled={emailActionLoading}
                    >{$t("common.cancel", "Cancel")}</Button
                  >
                </div>
              {/if}
            </div>
          {:else}
            <p class="text-xs text-muted-foreground">
              {$t("settings.account.noEmail", "No email on file yet.")}
            </p>
          {/if}
        </div>
      </div>
    </div>
  </div>

  <div class="space-y-6 border-t pt-8">
    <div class="space-y-1">
      <h3 class="text-lg font-medium">
        {$t("settings.account.appearance", "Appearance")}
      </h3>
      <p class="text-sm text-muted-foreground">
        {$t(
          "settings.account.appearanceDescription",
          "Customize your interface theme.",
        )}
      </p>
    </div>

    <div class="max-w-xs">
      <ModeToggle />
    </div>

    <div class="flex items-center gap-2 border-t pt-4">
      <Switch
        checked={mentionNotifications}
        onCheckedChange={handleMentionNotificationsToggle}
        disabled={mentionPreferenceLoading}
        id="mention-notifications"
      />
      <div>
        <Label for="mention-notifications" class="cursor-pointer font-normal">
          {$t(
            "settings.account.receiveMentionNotifications",
            "Receive in-app notifications when creators mention you",
          )}
        </Label>
        <p class="text-xs text-muted-foreground">
          {$t(
            "settings.account.mentionNotificationsDescription",
            "Opt in to in-app notifications when creators mention you. This does not affect email or push notifications.",
          )}
        </p>
      </div>
    </div>
  </div>

  <!-- Self-service deletion (Apple 5.1.1(v) / Google Play). The page owns the
       confirmation and the re-authentication; this is only the way there. -->
  <div class="space-y-2 border-t pt-8" data-testid="delete-account-section">
    <h3 class="text-lg font-medium">
      {$t("settings.account.deleteAccount", "Delete account")}
    </h3>
    <p class="text-sm text-muted-foreground">
      {$t(
        "settings.account.deleteAccountDescription",
        "Permanently delete this account and sign out everywhere.",
      )}
    </p>
    {#if deletionCancelledAt}
      <p class="text-sm" data-testid="deletion-cancelled-at">
        {$t(
          "settings.account.deletionCancelledOn",
          "Deletion cancelled on {date}.",
          {
            date: formatDate(deletionCancelledAt, getCurrentLocale(), {
              dateStyle: "long",
            }),
          },
        )}
      </p>
    {/if}
    <a
      class="inline-block text-sm text-destructive underline"
      href="/account/delete"
      data-testid="delete-account-link"
      >{$t("settings.account.deleteAccountLink", "Delete account…")}</a
    >
  </div>
</div>
