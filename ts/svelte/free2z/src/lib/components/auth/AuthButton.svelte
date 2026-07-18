<script lang="ts">
  import { currentUser } from '$lib/stores/auth';
  import { t } from '$lib/i18n';
  import Button from '$lib/components/ui/button/button.svelte';
  import UnifiedAuthModal from '$lib/components/auth/UnifiedAuthModal.svelte';
  import OTPModal from './OTPModal.svelte';
  import { toast } from 'svelte-sonner';

  // Modal state (declare ONCE)
  let showAuthModal = false;
  let showOTPModal = false;
  let otpData = { username: '', password: '' };

  // Open login modal (prevent nav/bubbling)
  function openLogin(e?: Event) {
    console.debug('[AuthButton] openLogin');
    e?.preventDefault();
    e?.stopPropagation();
    showAuthModal = true;
  }

  // Handle auth modal events
  function handleAuthSuccess(event?: CustomEvent<{ creator: any }>) {
    console.debug('[AuthButton] handleAuthSuccess');
    showAuthModal = false;
    const creator = event?.detail?.creator || $currentUser;
    const name = creator?.full_name || creator?.username || 'there';
    toast.success(`Welcome back, ${name}!`);
  }

  function handleAuthRequiresOTP(event: CustomEvent) {
    console.debug('[AuthButton] handleAuthRequiresOTP');
    otpData = event.detail;
    showAuthModal = false;
    showOTPModal = true;
  }

  function handleOTPSuccess() {
    console.debug('[AuthButton] handleOTPSuccess');
    showOTPModal = false;
    const name = $currentUser?.full_name || $currentUser?.username || 'there';
    toast.success(`Welcome back, ${name}!`);
  }

  function handleOTPBack() {
    console.debug('[AuthButton] handleOTPBack');
    showOTPModal = false;
    showAuthModal = true;
  }
</script>

<!-- Authentication Modals -->
<UnifiedAuthModal
  bind:open={showAuthModal}
  on:success={handleAuthSuccess}
  on:requiresOTP={handleAuthRequiresOTP}
/>

<OTPModal
  bind:open={showOTPModal}
  username={otpData.username}
  password={otpData.password}
  on:success={handleOTPSuccess}
  on:back={handleOTPBack}
/>

<!-- Not authenticated: Show login button -->
<Button
  onclick={openLogin}
  variant="default"
  size="sm"
  type="button"
  class="px-3"
>
  {t('common.auth.signIn', 'Sign In')}
</Button>