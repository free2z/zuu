<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { mode, resetMode, setMode, userPrefersMode } from 'mode-watcher';
  import { apiFetch } from '$lib/api/config';
  import { readErrorMessage } from '$lib/utils/apiErrors';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import { Switch } from '$lib/components/ui/switch';
  import * as Card from "$lib/components/ui/card";
  import { Sun, Moon, Laptop } from '@lucide/svelte';
    import ModeToggle from '../layout/ModeToggle.svelte';

  export let username: string;
  export let initialEmail: string | null = null;

  type EmailStatus = {
    email: string | null;
    confirmed: boolean;
    pending: boolean;
    is_public: boolean;
    get_notifications: boolean;
  };

  let email = initialEmail || '';
  let emailStatus: EmailStatus | null = null;
  let emailStatusLoading = false;
  let emailStatusError = '';
  let emailActionLoading = false;
  let emailPublic = false;
  let emailNotifications = false;
  let emailDirty = false;

  let themePreference: 'light' | 'dark' | 'system' = 'system';
  let derivedMode: 'light' | 'dark' | undefined = undefined;
  let themeDescription = '';

  const themeOptions = [
    {
      value: 'light',
      label: 'Light',
      description: 'Always use light mode.',
      icon: Sun,
      action: () => setMode('light'),
    },
    {
      value: 'dark',
      label: 'Dark',
      description: 'Always use dark mode.',
      icon: Moon,
      action: () => setMode('dark'),
    },
    {
      value: 'system',
      label: 'System',
      description: 'Follow your device settings.',
      icon: Laptop,
      action: () => resetMode(),
    },
  ];

  $: themePreference = (userPrefersMode.current || 'system') as 'light' | 'dark' | 'system';
  $: derivedMode = mode.current;
  $: themeDescription = themeOptions.find((option) => option.value === themePreference)?.description || '';

  async function fetchEmailStatus() {
    emailStatusLoading = true;
    emailStatusError = '';
    try {
      const response = await apiFetch('/api/emails/status', { method: 'GET' });
      if (!response.ok) {
        emailStatusError = await readErrorMessage(response, 'Failed to fetch email status.');
        return;
      }
      const data = await response.json();
      emailStatus = data;
      emailPublic = Boolean(data?.is_public);
      emailNotifications = Boolean(data?.get_notifications);
      if (!emailDirty) {
        email = data?.email || '';
      }
    } catch (err: any) {
      emailStatusError = err?.message || 'Failed to fetch email status.';
    } finally {
      emailStatusLoading = false;
    }
  }

  async function handleEmailUpdate() {
    if (emailActionLoading) return;
    const trimmed = email.trim();
    if (!trimmed) {
      toast.error('Enter an email address.');
      return;
    }
    if (emailStatus?.confirmed && emailStatus.email === trimmed) {
      toast.info('Email already confirmed.');
      return;
    }
    if (emailStatus?.pending && emailStatus.email === trimmed) {
      await handleEmailResend();
      return;
    }
    emailActionLoading = true;
    try {
      const response = await apiFetch('/api/emails/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed }),
      });
      if (!response.ok) {
        const message = await readErrorMessage(response, 'Failed to update email.');
        toast.error(message);
        return;
      }
      toast.success('Email update requested.');
      emailDirty = false;
      await fetchEmailStatus();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update email.');
    } finally {
      emailActionLoading = false;
    }
  }

  async function handleEmailResend() {
    if (emailActionLoading || !emailStatus?.email) return;
    emailActionLoading = true;
    try {
      const response = await apiFetch('/api/emails/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailStatus.email }),
      });
      if (!response.ok) {
        const message = await readErrorMessage(response, 'Failed to resend email.');
        toast.error(message);
        return;
      }
      toast.success('Confirmation email resent.');
      await fetchEmailStatus();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to resend email.');
    } finally {
      emailActionLoading = false;
    }
  }

  async function handleEmailDelete() {
    if (emailActionLoading) return;
    emailActionLoading = true;
    try {
      const response = await apiFetch('/api/emails/delete', { method: 'DELETE' });
      if (!response.ok) {
        const message = await readErrorMessage(response, 'Failed to delete email.');
        toast.error(message);
        return;
      }
      toast.success('Email deleted.');
      email = '';
      emailDirty = false;
      await fetchEmailStatus();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete email.');
    } finally {
      emailActionLoading = false;
    }
  }

  async function handleEmailPublicToggle(nextValue: boolean) {
    if (!emailStatus) return;
    emailPublic = nextValue;
    try {
      const response = await apiFetch('/api/emails/public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: nextValue }),
      });
      if (!response.ok) {
        const message = await readErrorMessage(response, 'Failed to update public email.');
        toast.error(message);
        emailPublic = !nextValue;
        return;
      }
      emailStatus = { ...emailStatus, is_public: nextValue };
      toast.success('Public email updated.');
    } catch (err: any) {
      emailPublic = !nextValue;
      toast.error(err?.message || 'Failed to update public email.');
    }
  }

  async function handleEmailNotificationsToggle(nextValue: boolean) {
    if (!emailStatus) return;
    emailNotifications = nextValue;
    try {
      const response = await apiFetch('/api/emails/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: nextValue }),
      });
      if (!response.ok) {
        const message = await readErrorMessage(response, 'Failed to update notifications.');
        toast.error(message);
        emailNotifications = !nextValue;
        return;
      }
      emailStatus = { ...emailStatus, get_notifications: nextValue };
      toast.success('Email notifications updated.');
    } catch (err: any) {
      emailNotifications = !nextValue;
      toast.error(err?.message || 'Failed to update notifications.');
    }
  }

  onMount(() => {
    fetchEmailStatus();
  });
</script>

<div class="space-y-8">
  <div class="space-y-6">
    <div>
      <h3 class="text-lg font-medium">Identity Hub</h3>
      <p class="text-sm text-muted-foreground">Manage your system identifiers and contact points.</p>
    </div>

    <div class="grid md:grid-cols-2 gap-8">
      <div class="space-y-2">
        <Label>Unique Identifier</Label>
        <div class="font-mono text-sm bg-muted/50 px-3 py-2 rounded-md border text-foreground flex items-center gap-1">
          <span class="text-muted-foreground">@</span>
          <span>{username}</span>
        </div>
      </div>
      
      <div class="space-y-2">
        <Label for="primaryEmail">Email Address</Label>
        <div class="flex flex-col md:flex-row gap-2">
          <Input
            id="primaryEmail"
            type="email"
            bind:value={email}
            oninput={() => (emailDirty = true)}
            placeholder="you@domain.com"
            class="flex-1"
          />
          <Button
            onclick={handleEmailUpdate}
            disabled={emailActionLoading || emailStatusLoading}
          >
            {#if emailActionLoading}
              <span class="flex items-center gap-2">
                <span class="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin"></span>
                Updating...
              </span>
            {:else}
              Update
            {/if}
          </Button>
        </div>
        
        <div class="space-y-2">
          {#if emailStatusLoading}
            <p class="text-xs text-muted-foreground">Checking email status...</p>
          {:else if emailStatusError}
            <p class="text-xs text-destructive">{emailStatusError}</p>
          {:else if emailStatus}
            <div class="flex flex-col gap-3 pt-2">
              <div class="flex items-center gap-2">
                 {#if emailStatus.confirmed}
                   <Badge variant="secondary" class="text-green-600 bg-green-500/10 hover:bg-green-500/20">Confirmed</Badge>
                 {:else if emailStatus.pending}
                   <Badge variant="secondary" class="text-yellow-600 bg-yellow-500/10 hover:bg-yellow-500/20">Pending</Badge>
                 {:else}
                   <Badge variant="secondary">Unverified</Badge>
                 {/if}
              </div>

              {#if emailStatus.confirmed}
                <div class="flex flex-wrap items-center gap-6">
                  <div class="flex items-center gap-2">
                    <Switch checked={emailPublic} onCheckedChange={handleEmailPublicToggle} id="public-email" />
                    <Label for="public-email" class="font-normal cursor-pointer">Public visibility</Label>
                  </div>
                  <div class="flex items-center gap-2">
                    <Switch checked={emailNotifications} onCheckedChange={handleEmailNotificationsToggle} id="notify-email" />
                     <Label for="notify-email" class="font-normal cursor-pointer">Receive notifications</Label>
                  </div>
                </div>
                <div>
                   <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive pl-0" onclick={handleEmailDelete} disabled={emailActionLoading}>Remove Email</Button>
                </div>
              {:else if emailStatus.pending}
                 <div class="flex items-center gap-2">
                    <Button variant="outline" size="sm" onclick={handleEmailResend} disabled={emailActionLoading}>Resend Confirmation</Button>
                    <Button variant="ghost" size="sm" onclick={handleEmailDelete} disabled={emailActionLoading}>Cancel</Button>
                 </div>
              {/if}
            </div>
          {:else}
            <p class="text-xs text-muted-foreground">No email on file yet.</p>
          {/if}
        </div>
      </div>
    </div>
  </div>

  <div class="border-t pt-8 space-y-6">
    <div class="space-y-1">
      <h3 class="text-lg font-medium">Appearance</h3>
      <p class="text-sm text-muted-foreground">Customize your interface theme.</p>
    </div>
    
    <div class="max-w-xs">
      <ModeToggle />
    </div>
  </div>
</div>

