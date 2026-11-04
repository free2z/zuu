<script lang="ts">
  import { requestLogin } from "$lib/stores/auth-modal";
  import { currentUser } from "$lib/stores/auth";
  import { onMount } from "svelte";
  import { toast, captureAccountToast } from "$lib/toast.js";
  import QRCode from "qrcode";
  import { apiFetch } from "$lib/api/config";
  import { readApiError } from "$lib/api/api-errors.js";
  import { isApiTimeoutError } from "$lib/api/request-timeout.js";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Card from "$lib/components/ui/card";
  import * as Dialog from "$lib/components/ui/dialog";
  import { ShieldCheck, Lock, Loader2, Copy } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";

  export let initialMfaEnabled = false;

  type MfaStatus = {
    enabled: boolean;
    otp_uri?: string;
    secret?: string;
  };

  let mfaEnabled = initialMfaEnabled;
  let mfaStatus: MfaStatus | null = null;
  let mfaLoading = false;
  let mfaError = "";
  let mfaDialogOpen = false;
  let mfaDialogMode: "setup" | "manage" = "setup";
  let mfaToken = "";
  let mfaSetupLoading = false;
  let mfaVerifyLoading = false;
  let mfaDisableLoading = false;
  let mfaQrDataUrl = "";
  let mfaQrError = false;

  let passwordIsSet: boolean | null = null;
  let passwordStatusLoading = false;
  let passwordActionLoading = false;
  let currentPassword = "";
  let newPassword = "";
  let confirmPassword = "";
  let otpToken = "";
  /** The last change-password failure, kept on screen until the next try. */
  let passwordError = "";
  let passwordNeedsReauth = false;

  async function fetchPasswordIsSet() {
    passwordStatusLoading = true;
    try {
      const response = await apiFetch("/api/emails/password-is-set", {
        method: "GET",
      });
      if (!response.ok) {
        passwordIsSet = null;
        return;
      }
      const data = await response.json();
      passwordIsSet = Boolean(data?.password_set);
    } catch {
      passwordIsSet = null;
    } finally {
      passwordStatusLoading = false;
    }
  }

  async function handlePasswordChange() {
    const operationNotice = captureAccountToast();
    if (passwordActionLoading) return;
    const trimmedNew = newPassword.trim();
    const trimmedConfirm = confirmPassword.trim();
    if (!trimmedNew) {
      operationNotice.error(
        $t(
          "settings.security.errors.newPasswordRequired",
          "Enter a new password.",
        ),
      );
      return;
    }
    if (trimmedNew !== trimmedConfirm) {
      operationNotice.error(
        $t("auth.errors.passwordsNotMatch", "Passwords do not match"),
      );
      return;
    }
    if (passwordIsSet && !currentPassword.trim()) {
      operationNotice.error(
        $t(
          "settings.security.errors.currentPasswordRequired",
          "Current password is required.",
        ),
      );
      return;
    }

    passwordActionLoading = true;
    passwordError = "";
    try {
      const payload = passwordIsSet
        ? {
            old_password: currentPassword.trim(),
            new_password: trimmedNew,
            ...(otpToken.trim() ? { otp_token: otpToken.trim() } : {}),
          }
        : {
            new_password: trimmedNew,
            ...(otpToken.trim() ? { otp_token: otpToken.trim() } : {}),
          };
      const response = await apiFetch("/api/emails/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        // The server says exactly what is wrong — `{"old_password":
        // ["Incorrect password."]}`, an `otp_token` refusal, a password-policy
        // list under `new_password`. Show it; the generic sentence is
        // only for a body with no reason in it.
        const failure = await readApiError(response);
        const data = failure.data as { code?: string } | null;
        passwordNeedsReauth = data?.code === "insufficient_user_authentication";
        passwordError =
          failure.message ||
          $t(
            "settings.security.errors.updatePassword",
            "Failed to update password.",
          );
        operationNotice.error(passwordError);
        return;
      }

      passwordNeedsReauth = false;
      currentPassword = "";
      newPassword = "";
      confirmPassword = "";
      otpToken = "";
      passwordIsSet = true;
      operationNotice.success(
        $t(
          "settings.security.passwordUpdated",
          "Password updated successfully.",
        ),
      );
    } catch (error) {
      // A timeout  carries its own sentence; anything else did not
      // reach the server's answer at all.
      passwordError = isApiTimeoutError(error)
        ? (error as Error).message
        : $t(
            "settings.security.errors.updatePassword",
            "Failed to update password.",
          );
      operationNotice.error(passwordError);
    } finally {
      passwordActionLoading = false;
    }
  }

  function reauthenticatePassword() {
    const originalUsername = $currentUser?.username;
    requestLogin({
      reauthentication: true,
      notice: $t(
        "settings.security.reauthenticate",
        "Sign in with an existing method before adding a password. Then return to this form and save.",
      ),
      onSuccess: (creator) => {
        passwordNeedsReauth = false;
        passwordError = "";
        if (creator?.username !== originalUsername) {
          currentPassword = newPassword = confirmPassword = otpToken = "";
          window.location.assign(
            `/${encodeURIComponent(creator?.username || "")}/dashboard/settings`,
          );
        }
      },
    });
  }

  async function fetchMfaStatus() {
    mfaLoading = true;
    mfaError = "";
    try {
      const response = await apiFetch("/api/otp/status/", { method: "GET" });
      if (!response.ok) {
        mfaError = $t(
          "settings.security.errors.fetchMfaStatus",
          "Failed to fetch MFA status.",
        );
        return;
      }
      const data = await response.json();
      mfaStatus = data;
      if (typeof data?.enabled === "boolean") {
        mfaEnabled = data.enabled;
      }
    } catch {
      mfaError = $t(
        "settings.security.errors.fetchMfaStatus",
        "Failed to fetch MFA status.",
      );
    } finally {
      mfaLoading = false;
    }
  }

  async function generateMfaQr(otpUri?: string) {
    mfaQrDataUrl = "";
    mfaQrError = false;
    if (!otpUri) return;
    try {
      mfaQrDataUrl = await QRCode.toDataURL(otpUri, { margin: 1, width: 240 });
    } catch {
      mfaQrError = true;
    }
  }

  async function handleMfaAction() {
    const operationNotice = captureAccountToast();
    if (passwordIsSet === false) {
      operationNotice.error(
        $t(
          "settings.security.setPasswordBeforeMfa",
          "Set a password before enabling MFA.",
        ),
      );
      return;
    }
    if (mfaEnabled) {
      mfaDialogMode = "manage";
      mfaDialogOpen = true;
      return;
    }
    await setupMfa();
  }

  async function setupMfa() {
    const operationNotice = captureAccountToast();
    if (mfaSetupLoading) return;
    mfaSetupLoading = true;
    try {
      const response = await apiFetch("/api/otp/setup/", { method: "POST" });
      // 409 means the server already has an ACTIVE secret for this account and
      // refuses to disclose it  -- so this button was drawn from stale
      // status, e.g. MFA was enabled in another tab. Resync rather than
      // reporting a generic failure that leaves the UI still showing "enable".
      if (response.status === 409) {
        await fetchMfaStatus();
        operationNotice.error(
          $t(
            "settings.security.mfaAlreadyEnabled",
            "MFA is already enabled. Disable it before enrolling a new authenticator.",
          ),
        );
        return;
      }
      if (!response.ok) {
        operationNotice.error(
          $t(
            "settings.security.errors.startMfaSetup",
            "Failed to start MFA setup.",
          ),
        );
        return;
      }
      const data = await response.json();
      mfaStatus = {
        enabled: false,
        otp_uri: data?.otp_uri,
        secret: data?.secret,
      };
      mfaDialogMode = "setup";
      mfaDialogOpen = true;
      mfaToken = "";
      await generateMfaQr(data?.otp_uri);
    } catch {
      operationNotice.error(
        $t(
          "settings.security.errors.startMfaSetup",
          "Failed to start MFA setup.",
        ),
      );
    } finally {
      mfaSetupLoading = false;
    }
  }

  async function handleMfaVerify() {
    const operationNotice = captureAccountToast();
    if (mfaVerifyLoading) return;
    const token = mfaToken.trim();
    if (token.length < 6) {
      operationNotice.error(
        $t(
          "settings.security.errors.verificationCodeRequired",
          "Enter the 6-digit verification code.",
        ),
      );
      return;
    }
    mfaVerifyLoading = true;
    try {
      const response = await apiFetch("/api/otp/enable/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        const failure = await readApiError(response);
        operationNotice.error(
          failure.message ||
            $t("settings.security.errors.verifyMfa", "Failed to verify MFA."),
        );
        return;
      }
      mfaEnabled = true;
      mfaStatus = { enabled: true };
      mfaDialogOpen = false;
      mfaToken = "";
      operationNotice.success(
        $t("settings.security.mfaEnabled", "MFA enabled."),
      );
    } catch {
      operationNotice.error(
        $t("settings.security.errors.verifyMfa", "Failed to verify MFA."),
      );
    } finally {
      mfaVerifyLoading = false;
    }
  }

  async function handleMfaDisable() {
    const operationNotice = captureAccountToast();
    if (mfaDisableLoading) return;
    mfaDisableLoading = true;
    try {
      const response = await apiFetch("/api/otp/disable/", {
        method: "DELETE",
      });
      if (!response.ok) {
        const failure = await readApiError(response);
        operationNotice.error(
          failure.message ||
            $t("settings.security.errors.disableMfa", "Failed to disable MFA."),
        );
        return;
      }
      mfaEnabled = false;
      mfaStatus = { enabled: false };
      mfaDialogOpen = false;
      operationNotice.success(
        $t("settings.security.mfaDisabled", "MFA disabled."),
      );
    } catch {
      operationNotice.error(
        $t("settings.security.errors.disableMfa", "Failed to disable MFA."),
      );
    } finally {
      mfaDisableLoading = false;
    }
  }

  async function handleMfaCopySecret() {
    const operationNotice = captureAccountToast();
    if (!mfaStatus?.secret) return;
    try {
      await navigator.clipboard.writeText(mfaStatus.secret);
      operationNotice.success(
        $t("settings.security.secretCopied", "Secret copied to clipboard."),
      );
    } catch {
      operationNotice.error($t("pageActions.share.copyFailed", "Copy failed"));
    }
  }

  function handleMfaTokenInput(
    event: Event & { currentTarget: EventTarget & HTMLInputElement },
  ) {
    const value = event.currentTarget.value.replace(/\s/g, "");
    mfaToken = value;
    if (value.length === 6 && !mfaVerifyLoading) {
      handleMfaVerify();
    }
  }

  function handleMfaDialogChange(open: boolean) {
    mfaDialogOpen = open;
    if (!open) {
      mfaToken = "";
      mfaQrDataUrl = "";
      mfaQrError = false;
      if (mfaEnabled) {
        mfaStatus = { enabled: true };
      }
    }
  }

  onMount(() => {
    fetchMfaStatus();
    fetchPasswordIsSet();
  });
</script>

<div class="space-y-8">
  <div class="space-y-6">
    <div>
      <h3 class="text-lg font-medium">
        {$t("settings.security.vaultAccess", "Vault Access")}
      </h3>
      <p class="text-sm text-muted-foreground">
        {$t(
          "settings.security.vaultDescription",
          "Update and manage your account credentials.",
        )}
      </p>
    </div>

    <div
      class="flex flex-col justify-between gap-6 rounded-lg border p-6 md:flex-row md:items-center"
    >
      <div class="flex items-center gap-4">
        <div
          class={`rounded-full p-2 ${mfaEnabled ? "bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400" : "bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400"}`}
        >
          <ShieldCheck class="size-6" />
        </div>
        <div>
          <p class="font-medium">
            {mfaEnabled
              ? $t("settings.security.mfaEnabledLabel", "MFA Enabled")
              : $t("settings.security.mfaDisabledLabel", "MFA Disabled")}
          </p>
          <p class="text-sm text-muted-foreground">
            {mfaEnabled
              ? $t(
                  "settings.security.mfaProtected",
                  "Your account is securely protected.",
                )
              : $t(
                  "settings.security.mfaActivationDescription",
                  "Activate Multi-Factor Authentication for maximum security.",
                )}
          </p>
        </div>
      </div>
      <Button
        variant="secondary"
        onclick={handleMfaAction}
        disabled={mfaLoading ||
          mfaSetupLoading ||
          mfaVerifyLoading ||
          mfaDisableLoading ||
          passwordIsSet === false}
      >
        {#if mfaLoading || mfaSetupLoading}
          <Loader2 class="mr-2 size-4 animate-spin" />
          {$t("settings.security.loading", "Loading")}
        {:else}
          {mfaEnabled
            ? $t("settings.security.manageSettings", "Manage Settings")
            : $t("settings.security.activateMfa", "Activate MFA")}
        {/if}
      </Button>
    </div>

    {#if passwordIsSet === false}
      <div class="text-sm font-medium text-orange-600 dark:text-orange-400">
        {$t(
          "settings.security.setPasswordBeforeMfaLong",
          "Please set a password before enabling MFA.",
        )}
      </div>
    {/if}
    {#if mfaError}
      <div class="text-sm font-medium text-destructive">
        {mfaError}
      </div>
    {/if}
  </div>

  <div class="space-y-6 border-t pt-8">
    <div class="space-y-1">
      <h4 class="flex items-center gap-2 text-lg font-medium">
        {$t("settings.security.changePassword", "Change Password")}
      </h4>
      <p class="text-sm text-muted-foreground">
        {$t(
          "settings.security.passwordAdvice",
          "Ensure your account uses a long, random password to stay secure.",
        )}
      </p>
    </div>

    <div class="max-w-md space-y-4">
      {#if passwordIsSet !== false}
        <div class="space-y-2">
          <Label for="currentPassword"
            >{$t(
              "settings.security.currentPassword",
              "Current Password",
            )}</Label
          >
          <Input
            id="currentPassword"
            type="password"
            bind:value={currentPassword}
            placeholder="••••••••"
          />
        </div>
      {/if}
      <div class="space-y-2">
        <Label for="newPassword"
          >{$t("settings.security.newPassword", "New Password")}</Label
        >
        <Input
          id="newPassword"
          type="password"
          bind:value={newPassword}
          placeholder="••••••••"
        />
      </div>
      <div class="space-y-2">
        <Label for="confirmPassword"
          >{$t("auth.confirmPassword", "Confirm Password")}</Label
        >
        <Input
          id="confirmPassword"
          type="password"
          bind:value={confirmPassword}
          placeholder="••••••••"
        />
      </div>
      <div class="space-y-2">
        <Label for="passwordOtpToken"
          >Authenticator code (if MFA is enabled)</Label
        >
        <Input
          id="passwordOtpToken"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength={10}
          bind:value={otpToken}
          placeholder="000000"
        />
      </div>

      {#if passwordNeedsReauth}
        <Button variant="outline" onclick={reauthenticatePassword}
          >{$t("auth.signInAgain", "Sign in again")}</Button
        >
      {/if}
      {#if passwordError}
        <p
          class="text-sm text-destructive"
          role="alert"
          data-testid="password-change-error"
        >
          {passwordError}
        </p>
      {/if}

      <div class="pt-2">
        <Button
          onclick={handlePasswordChange}
          disabled={passwordActionLoading || passwordStatusLoading}
        >
          {#if passwordActionLoading}
            <Loader2 class="mr-2 size-4 animate-spin" />
            {$t("settings.security.updating", "Updating...")}
          {:else}
            {$t("settings.security.updatePassword", "Update Password")}
          {/if}
        </Button>
      </div>
    </div>
  </div>

  <Dialog.Root bind:open={mfaDialogOpen} onOpenChange={handleMfaDialogChange}>
    <Dialog.Content class="sm:max-w-[520px]">
      <Dialog.Header>
        <Dialog.Title
          >{mfaDialogMode === "manage"
            ? $t("settings.security.manageMfa", "Manage MFA")
            : $t("settings.security.setupMfa", "Set up MFA")}</Dialog.Title
        >
        <Dialog.Description>
          {#if mfaDialogMode === "manage"}
            {$t(
              "settings.security.manageMfaDescription",
              "Multi-Factor Authentication adds an extra step during login. You can disable it below.",
            )}
          {:else}
            {$t(
              "settings.security.setupMfaDescription",
              "Scan the QR code with your authenticator app, then enter the 6-digit code to verify.",
            )}
          {/if}
        </Dialog.Description>
      </Dialog.Header>
      {#if mfaDialogMode === "setup"}
        <div class="flex flex-col items-center gap-5 py-2">
          <div
            class="rounded-xl border border-border/30 bg-white p-4 shadow-sm"
          >
            {#if mfaQrDataUrl}
              <img
                src={mfaQrDataUrl}
                alt={$t("settings.security.mfaQrAlt", "MFA QR code")}
                class="block h-48 w-48"
              />
            {:else if mfaQrError}
              <div
                class="flex h-48 w-48 items-center justify-center text-sm text-red-500"
              >
                {$t("settings.security.qrFailed", "Failed to generate QR")}
              </div>
            {:else}
              <div
                class="flex h-48 w-48 items-center justify-center text-sm text-muted-foreground"
              >
                {$t("settings.security.qrGenerating", "Generating QR code...")}
              </div>
            {/if}
          </div>
          {#if mfaStatus?.secret}
            <div class="w-full space-y-2">
              <Label
                for="mfaSecret"
                class="text-xs font-bold tracking-widest text-muted-foreground uppercase"
                >{$t("settings.security.secret", "Secret")}</Label
              >
              <div class="flex items-center gap-2">
                <Input
                  id="mfaSecret"
                  value={mfaStatus.secret}
                  readonly
                  class="h-11 rounded-xl border-border/40 bg-muted/10 px-4 font-mono text-xs"
                />
                <Button
                  variant="secondary"
                  size="icon"
                  onclick={handleMfaCopySecret}
                  aria-label={$t("settings.security.copySecret", "Copy secret")}
                >
                  <Copy class="size-4" />
                </Button>
              </div>
            </div>
          {/if}
          <div class="w-full space-y-2">
            <Label
              for="mfaToken"
              class="text-xs font-bold tracking-widest text-muted-foreground uppercase"
              >{$t("auth.verificationCode", "Verification Code")}</Label
            >
            <Input
              id="mfaToken"
              inputmode="numeric"
              autocomplete="one-time-code"
              value={mfaToken}
              oninput={handleMfaTokenInput}
              placeholder="123456"
              class="h-11 rounded-xl border-border/40 bg-muted/10 px-6 text-center font-bold tracking-[0.5em]"
            />
          </div>
        </div>
      {:else}
        <div
          class="rounded-xl border border-border/30 bg-muted/10 p-4 text-sm text-muted-foreground"
        >
          {$t(
            "settings.security.mfaCurrentlyActive",
            "MFA is currently active for your account.",
          )}
        </div>
      {/if}
      <Dialog.Footer class="pt-4">
        <Button variant="ghost" onclick={() => (mfaDialogOpen = false)}
          >{$t("common.close", "Close")}</Button
        >
        {#if mfaDialogMode === "setup"}
          <Button
            onclick={handleMfaVerify}
            disabled={mfaVerifyLoading || mfaToken.trim().length !== 6}
          >
            {#if mfaVerifyLoading}
              <Loader2 class="size-4 animate-spin" />
              {$t("auth.verifying", "Verifying...")}
            {:else}
              {$t("auth.verify", "Verify")}
            {/if}
          </Button>
        {:else}
          <Button
            variant="destructive"
            onclick={handleMfaDisable}
            disabled={mfaDisableLoading}
          >
            {#if mfaDisableLoading}
              <Loader2 class="size-4 animate-spin" />
              {$t("settings.security.disabling", "Disabling...")}
            {:else}
              {$t("settings.security.disableMfa", "Disable MFA")}
            {/if}
          </Button>
        {/if}
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
</div>
