<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { authStore } from '$lib/stores/auth';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import { Loader2, Smartphone } from '@lucide/svelte';

  // Props
  export let open = false;
  export let username = '';
  export let password = '';

  // Event dispatcher
  const dispatch = createEventDispatcher<{
    close: void;
    success: { creator: any };
    back: void;
  }>();

  // Form state
  let otpCode = '';
  let error = '';
  let isLoading = false;

  // Clear form when modal opens/closes
  $: if (!open) {
    otpCode = '';
    error = '';
  }

  // Handle OTP submission
  async function handleSubmit() {
    try {
      if (!otpCode.trim()) {
        error = 'Please enter the verification code';
        return;
      }

      error = '';
      isLoading = true;

      // Login with OTP
      const authResult = await authStore.login(username, password, '', otpCode);

      if (authResult.success) {
        dispatch('success', { creator: authResult.creator });
        close();
      } else {
        error = authResult.error || 'Invalid verification code';
      }
    } catch (err: any) {
      console.error('OTP verification error:', err);
      error = err.message || 'Verification failed';
    } finally {
      isLoading = false;
    }
  }

  // Handle Enter key
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !isLoading) {
      handleSubmit();
    }
  }

  // Close modal
  function close() {
    open = false;
    dispatch('close');
  }

  // Go back to login
  function goBack() {
    dispatch('back');
    close();
  }

  // Auto-format OTP code (6 digits)
  function formatOtpCode(value: string) {
    return value.replace(/\D/g, '').slice(0, 6);
  }

  $: otpCode = formatOtpCode(otpCode);
</script>

<Dialog bind:open>
  <DialogContent class="sm:max-w-[400px]">
    <DialogHeader>
      <DialogTitle
        class="text-center text-2xl font-bold flex items-center justify-center gap-2"
      >
        <Smartphone class="h-6 w-6" />
        {t('common.auth.twoFactorTitle', 'Two-Factor Authentication')}
      </DialogTitle>
      <DialogDescription class="text-center">
        {t(
          'common.auth.otpDescription',
          'Enter the 6-digit code from your authenticator app'
        )}
      </DialogDescription>
    </DialogHeader>

    <form on:submit|preventDefault={handleSubmit} class="space-y-4">
      <!-- OTP Code Field -->
      <div class="space-y-2">
        <Label for="otpCode" class="text-center block">
          {t('common.auth.verificationCode', 'Verification Code')}
        </Label>
        <Input
          id="otpCode"
          type="text"
          bind:value={otpCode}
          placeholder="000000"
          disabled={isLoading}
          onkeydown={handleKeydown}
          class={`text-center text-xl tracking-widest ${error ? 'border-red-500' : ''}`}
          maxlength={6}
          autocomplete="one-time-code"
        />
        {#if error}
          <p class="text-sm text-red-500 text-center">{error}</p>
        {/if}
      </div>

      <!-- Helper Text -->
      <p class="text-center text-sm text-gray-600">
        {t(
          'common.auth.otpHelp',
          'Open your authenticator app and enter the 6-digit code'
        )}
      </p>

      <!-- Action Buttons -->
      <div class="flex gap-3">
        <Button
          type="button"
          variant="outline"
          class="flex-1"
          onclick={goBack}
          disabled={isLoading}
        >
          {t('common.auth.back', 'Back')}
        </Button>

        <Button
          type="submit"
          class="flex-1"
          disabled={isLoading || otpCode.length !== 6}
        >
          {#if isLoading}
            <Loader2 class="mr-2 h-4 w-4 animate-spin" />
            {t('common.auth.verifying', 'Verifying...')}
          {:else}
            {t('common.auth.verify', 'Verify')}
          {/if}
        </Button>
      </div>

      <!-- Trouble Link -->
      <div class="text-center">
        <Button
          variant="link"
          size="sm"
          type="button"
          class="text-blue-600 hover:text-blue-500"
          onclick={() => {
            // TODO: Handle trouble with 2FA
            console.log('Trouble with 2FA');
          }}
        >
          {t('common.auth.troubleWith2FA', 'Having trouble with 2FA?')}
        </Button>
      </div>
    </form>
  </DialogContent>
</Dialog>

