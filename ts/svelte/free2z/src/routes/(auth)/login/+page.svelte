<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { currentUser } from "$lib/stores/auth";
  import { toast } from "svelte-sonner";
  import UnifiedAuthModal from "$lib/components/auth/UnifiedAuthModal.svelte";
  import OTPModal from "$lib/components/auth/OTPModal.svelte";

  let showModal = false;
  let showOTPModal = false;
  let otpData = { username: "", password: "" };

  $: nextPath = $page.url.searchParams.get("next");

  function handleAuthSuccess(event?: CustomEvent<{ creator: any }>) {
    showModal = false;
    const creator = event?.detail?.creator || $currentUser;
    const name = creator?.full_name || creator?.username || "there";
    toast.success(`Welcome back, ${name}!`, { duration: 3000 });

    goto(nextPath || "/");
  }

  function handleAuthRequiresOTP(
    event: CustomEvent<{ username: string; password: string }>,
  ) {
    otpData = event.detail;
    showModal = false;
    showOTPModal = true;
  }

  function handleOTPSuccess() {
    showOTPModal = false;
    const name = $currentUser?.full_name || $currentUser?.username || "there";
    toast.success(`Welcome back, ${name}!`, { duration: 3000 });

    goto(nextPath || "/");
  }

  function handleOTPBack() {
    showOTPModal = false;
    showModal = true;
  }

  onMount(() => {
    // Show modal immediately when page loads
    showModal = true;
  });
</script>

<main class="flex flex-1 items-center justify-center bg-background">
  <UnifiedAuthModal
    bind:open={showModal}
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

  <!-- Background content when modal is closed -->
  {#if !showModal}
    <div class="space-y-4 text-center">
      <h1 class="text-4xl font-bold text-foreground">Welcome to Free2Z</h1>
      <p class="text-muted-foreground">Please sign in to continue</p>
      <button
        class="text-primary hover:underline"
        on:click={() => (showModal = true)}
      >
        Open Login
      </button>
    </div>
  {/if}
</main>
