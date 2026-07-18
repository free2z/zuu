<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import QRCode from 'qrcode';
  import { apiFetch } from '$lib/api/config';
  import { readErrorMessage } from '$lib/utils/apiErrors';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import * as Card from "$lib/components/ui/card";
  import * as Dialog from "$lib/components/ui/dialog";
  import { ShieldCheck, Lock, Loader2, Copy } from '@lucide/svelte';

  export let initialMfaEnabled = false;

  type MfaStatus = {
    enabled: boolean;
    otp_uri?: string;
    secret?: string;
  };

  let mfaEnabled = initialMfaEnabled;
  let mfaStatus: MfaStatus | null = null;
  let mfaLoading = false;
  let mfaError = '';
  let mfaDialogOpen = false;
  let mfaDialogMode: 'setup' | 'manage' = 'setup';
  let mfaToken = '';
  let mfaSetupLoading = false;
  let mfaVerifyLoading = false;
  let mfaDisableLoading = false;
  let mfaQrDataUrl = '';
  let mfaQrError = false;

  let passwordIsSet: boolean | null = null;
  let passwordStatusLoading = false;
  let passwordActionLoading = false;
  let currentPassword = '';
  let newPassword = '';
  let confirmPassword = '';

  async function fetchPasswordIsSet() {
    passwordStatusLoading = true;
    try {
      const response = await apiFetch('/api/emails/password-is-set', { method: 'GET' });
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
    if (passwordActionLoading) return;
    const trimmedNew = newPassword.trim();
    const trimmedConfirm = confirmPassword.trim();
    if (!trimmedNew) {
      toast.error('Enter a new password.');
      return;
    }
    if (trimmedNew !== trimmedConfirm) {
      toast.error('Passwords do not match.');
      return;
    }
    if (passwordIsSet && !currentPassword.trim()) {
      toast.error('Current password is required.');
      return;
    }

    passwordActionLoading = true;
    try {
      const payload = passwordIsSet
        ? { old_password: currentPassword.trim(), new_password: trimmedNew }
        : { new_password: trimmedNew };
      const response = await apiFetch('/api/emails/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const message = await readErrorMessage(response, 'Failed to update password.');
        toast.error(message);
        return;
      }

      currentPassword = '';
      newPassword = '';
      confirmPassword = '';
      passwordIsSet = true;
      toast.success('Password updated successfully.');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update password.');
    } finally {
      passwordActionLoading = false;
    }
  }

  async function fetchMfaStatus() {
    mfaLoading = true;
    mfaError = '';
    try {
      const response = await apiFetch('/api/otp/status/', { method: 'GET' });
      if (!response.ok) {
        mfaError = await readErrorMessage(response, 'Failed to fetch MFA status.');
        return;
      }
      const data = await response.json();
      mfaStatus = data;
      if (typeof data?.enabled === 'boolean') {
        mfaEnabled = data.enabled;
      }
    } catch (err: any) {
      mfaError = err?.message || 'Failed to fetch MFA status.';
    } finally {
      mfaLoading = false;
    }
  }

  async function generateMfaQr(otpUri?: string) {
    mfaQrDataUrl = '';
    mfaQrError = false;
    if (!otpUri) return;
    try {
      mfaQrDataUrl = await QRCode.toDataURL(otpUri, { margin: 1, width: 240 });
    } catch {
      mfaQrError = true;
    }
  }

  async function handleMfaAction() {
    if (passwordIsSet === false) {
      toast.error('Set a password before enabling MFA.');
      return;
    }
    if (mfaEnabled) {
      mfaDialogMode = 'manage';
      mfaDialogOpen = true;
      return;
    }
    await setupMfa();
  }

  async function setupMfa() {
    if (mfaSetupLoading) return;
    mfaSetupLoading = true;
    try {
      const response = await apiFetch('/api/otp/setup/', { method: 'POST' });
      if (!response.ok) {
        const message = await readErrorMessage(response, 'Failed to start MFA setup.');
        toast.error(message);
        return;
      }
      const data = await response.json();
      mfaStatus = { enabled: false, otp_uri: data?.otp_uri, secret: data?.secret };
      mfaDialogMode = 'setup';
      mfaDialogOpen = true;
      mfaToken = '';
      await generateMfaQr(data?.otp_uri);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to start MFA setup.');
    } finally {
      mfaSetupLoading = false;
    }
  }

  async function handleMfaVerify() {
    if (mfaVerifyLoading) return;
    const token = mfaToken.trim();
    if (token.length < 6) {
      toast.error('Enter the 6-digit verification code.');
      return;
    }
    mfaVerifyLoading = true;
    try {
      const response = await apiFetch('/api/otp/enable/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        const message = await readErrorMessage(response, 'Failed to verify MFA.');
        toast.error(message);
        return;
      }
      mfaEnabled = true;
      mfaStatus = { enabled: true };
      mfaDialogOpen = false;
      mfaToken = '';
      toast.success('MFA enabled.');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to verify MFA.');
    } finally {
      mfaVerifyLoading = false;
    }
  }

  async function handleMfaDisable() {
    if (mfaDisableLoading) return;
    mfaDisableLoading = true;
    try {
      const response = await apiFetch('/api/otp/disable/', { method: 'DELETE' });
      if (!response.ok) {
        const message = await readErrorMessage(response, 'Failed to disable MFA.');
        toast.error(message);
        return;
      }
      mfaEnabled = false;
      mfaStatus = { enabled: false };
      mfaDialogOpen = false;
      toast.success('MFA disabled.');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to disable MFA.');
    } finally {
      mfaDisableLoading = false;
    }
  }

  async function handleMfaCopySecret() {
    if (!mfaStatus?.secret) return;
    try {
      await navigator.clipboard.writeText(mfaStatus.secret);
      toast.success('Secret copied to clipboard.');
    } catch {
      toast.error('Copy failed.');
    }
  }

  function handleMfaTokenInput(event: Event & { currentTarget: EventTarget & HTMLInputElement }) {
    const value = event.currentTarget.value.replace(/\s/g, '');
    mfaToken = value;
    if (value.length === 6 && !mfaVerifyLoading) {
      handleMfaVerify();
    }
  }

  function handleMfaDialogChange(open: boolean) {
    mfaDialogOpen = open;
    if (!open) {
      mfaToken = '';
      mfaQrDataUrl = '';
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
      <h3 class="text-lg font-medium">Vault Access</h3>
      <p class="text-sm text-muted-foreground">Update and manage your account credentials.</p>
    </div>

    <div class="rounded-lg border p-6 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div class="flex items-center gap-4">
          <div class={`p-2 rounded-full ${mfaEnabled ? 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400' : 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400'}`}>
            <ShieldCheck class="size-6" />
          </div>
          <div>
            <p class="font-medium">
              {mfaEnabled ? 'MFA Enabled' : 'MFA Disabled'}
            </p>
            <p class="text-sm text-muted-foreground">
              {mfaEnabled ? 'Your account is securely protected.' : 'Activate Multi-Factor Authentication for maximum security.'}
            </p>
          </div>
        </div>
        <Button
          variant="secondary"
          onclick={handleMfaAction}
          disabled={mfaLoading || mfaSetupLoading || mfaVerifyLoading || mfaDisableLoading || passwordIsSet === false}
        >
          {#if mfaLoading || mfaSetupLoading}
            <Loader2 class="size-4 animate-spin mr-2" /> Loading
          {:else}
            {mfaEnabled ? 'Manage Settings' : 'Activate MFA'}
          {/if}
        </Button>
    </div>

    {#if passwordIsSet === false}
        <div class="text-sm font-medium text-orange-600 dark:text-orange-400">
          Please set a password before enabling MFA.
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
        <h4 class="text-lg font-medium flex items-center gap-2">
           Change Password
        </h4>
        <p class="text-sm text-muted-foreground">Ensure your account uses a long, random password to stay secure.</p>
    </div>

    <div class="max-w-md space-y-4">
          {#if passwordIsSet !== false}
            <div class="space-y-2">
              <Label for="currentPassword">Current Password</Label>
              <Input id="currentPassword" type="password" bind:value={currentPassword} placeholder="••••••••" />
            </div>
          {/if}
          <div class="space-y-2">
            <Label for="newPassword">New Password</Label>
            <Input id="newPassword" type="password" bind:value={newPassword} placeholder="••••••••" />
          </div>
          <div class="space-y-2">
            <Label for="confirmPassword">Confirm Password</Label>
            <Input id="confirmPassword" type="password" bind:value={confirmPassword} placeholder="••••••••" />
          </div>
          
          <div class="pt-2">
            <Button
              onclick={handlePasswordChange}
              disabled={passwordActionLoading || passwordStatusLoading}
            >
              {#if passwordActionLoading}
                <Loader2 class="size-4 animate-spin mr-2" /> Updating...
              {:else}
                Update Password
              {/if}
            </Button>
          </div>
    </div>
  </div>


  <Dialog.Root bind:open={mfaDialogOpen} onOpenChange={handleMfaDialogChange}>
    <Dialog.Content class="sm:max-w-[520px]">
      <Dialog.Header>
        <Dialog.Title>{mfaDialogMode === 'manage' ? 'Manage MFA' : 'Set up MFA'}</Dialog.Title>
        <Dialog.Description>
          {#if mfaDialogMode === 'manage'}
            Multi-Factor Authentication adds an extra step during login. You can disable it below.
          {:else}
            Scan the QR code with your authenticator app, then enter the 6-digit code to verify.
          {/if}
        </Dialog.Description>
      </Dialog.Header>
      {#if mfaDialogMode === 'setup'}
        <div class="flex flex-col items-center gap-5 py-2">
          <div class="rounded-xl border border-border/30 bg-white p-4 shadow-sm">
            {#if mfaQrDataUrl}
              <img src={mfaQrDataUrl} alt="MFA QR code" class="block h-48 w-48" />
            {:else if mfaQrError}
              <div class="h-48 w-48 flex items-center justify-center text-sm text-red-500">Failed to generate QR</div>
            {:else}
              <div class="h-48 w-48 flex items-center justify-center text-sm text-muted-foreground">Generating...</div>
            {/if}
          </div>
          {#if mfaStatus?.secret}
            <div class="w-full space-y-2">
              <Label for="mfaSecret" class="text-xs font-bold uppercase tracking-widest text-muted-foreground">Secret</Label>
              <div class="flex items-center gap-2">
                <Input id="mfaSecret" value={mfaStatus.secret} readonly class="h-11 px-4 rounded-xl font-mono text-xs bg-muted/10 border-border/40" />
                <Button variant="secondary" size="icon" onclick={handleMfaCopySecret}>
                  <Copy class="size-4" />
                </Button>
              </div>
            </div>
          {/if}
          <div class="w-full space-y-2">
            <Label for="mfaToken" class="text-xs font-bold uppercase tracking-widest text-muted-foreground">Verification Code</Label>
            <Input
              id="mfaToken"
              inputmode="numeric"
              autocomplete="one-time-code"
              value={mfaToken}
              oninput={handleMfaTokenInput}
              placeholder="123456"
              class="h-11 px-6 rounded-xl bg-muted/10 border-border/40 text-center tracking-[0.5em] font-bold"
            />
          </div>
        </div>
      {:else}
        <div class="rounded-xl border border-border/30 bg-muted/10 p-4 text-sm text-muted-foreground">
          MFA is currently active for your account.
        </div>
      {/if}
      <Dialog.Footer class="pt-4">
        <Button variant="ghost" onclick={() => (mfaDialogOpen = false)}>Close</Button>
        {#if mfaDialogMode === 'setup'}
          <Button onclick={handleMfaVerify} disabled={mfaVerifyLoading || mfaToken.trim().length !== 6}>
            {#if mfaVerifyLoading}
              <Loader2 class="size-4 animate-spin" /> Verifying...
            {:else}
              Verify
            {/if}
          </Button>
        {:else}
          <Button variant="destructive" onclick={handleMfaDisable} disabled={mfaDisableLoading}>
            {#if mfaDisableLoading}
              <Loader2 class="size-4 animate-spin" /> Disabling...
            {:else}
              Disable MFA
            {/if}
          </Button>
        {/if}
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
</div>
