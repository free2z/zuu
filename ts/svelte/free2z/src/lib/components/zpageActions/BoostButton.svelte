<script lang="ts">
  import { onDestroy } from 'svelte';
  import { authStore } from '$lib/stores/auth';
  import UnifiedAuthModal from '$lib/components/auth/UnifiedAuthModal.svelte';
  import { Tooltip as TooltipPrimitive } from 'bits-ui';
  import { Content as TooltipContent } from '$lib/components/ui/tooltip';
  import { toast } from 'svelte-sonner';
  import {Button} from '$lib/components/ui/button';
  import { tStore as t } from '$lib/i18n';

  export let pageId: string | null = null;
  export let score: number | null = null;

  let localScore = score ?? 0;
  let loading = false;
  let blocked = false; // debounce per-instance
  let showAuthModal = false;


  async function doBoost() {
    if (!pageId) return;
    if (blocked || loading) return;
    const auth = await authStore.ensureAuthenticated();
    if (!auth) {
      // Open auth modal; do not call network
      showAuthModal = true;
      return;
    }

    // Optimistic UI
    localScore = (localScore ?? 0) + 1;
    loading = true;
    blocked = true;

    // disable for short debounce window to avoid many rapid clicks
    setTimeout(() => (blocked = false), 900);

    try {
      const csrf = await authStore.ensureCSRFToken();
      const res = await fetch('/api/zpage/fund/', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRFToken': csrf } : {}),
        },
        body: JSON.stringify({ id: pageId, amount: 2 }),
      });

      if (!res.ok) {
        if (authStore.handleAuthFailure(res.status)) {
          throw new Error($t('pageActions.boost.loginRequired', 'Please log in to boost this page'));
        }
        let message = $t('pageActions.boost.error', 'Failed to boost');
        try {
          const json = await res.json();
          message = json?.message || JSON.stringify(json) || message;
        } catch (e) {
          console.error('Failed to parse error response JSON:', e);
        }
        throw new Error(message);
      }

      // Backend may return new score (like React flow)
      let data: any = null;
      try {
        data = await res.json();
      } catch (err) {
        console.error('Failed to parse JSON response in doBoost:', err);
      }

      if (data && typeof data === 'number') {
        localScore = data;
      } else if (data && data.f2z_score !== undefined) {
        localScore = data.f2z_score;
      }

      toast.success($t('pageActions.boost.success', 'Thanks for the boost!'));
    } catch (err: any) {
      // Revert optimistic increment
      localScore = Math.max(0, (localScore ?? 1) - 1);
      toast.error(err?.message || $t('pageActions.boost.failed', 'Boost failed'));
    } finally {
      loading = false;
    }
  }

  // Keep localScore in sync when parent updates `score` prop
  $: if (score !== null && score !== undefined && score !== localScore) {
    localScore = score;
  }

  onDestroy(() => {
    // noop
  });
</script>

  <div class="relative flex items-center justify-center">
    <TooltipPrimitive.Provider>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger>

          <Button
      class="flex items-center justify-center  rounded-full"
      onclick={doBoost}
      size="icon-lg"
      disabled={loading || blocked}
      aria-busy={loading}
      aria-label={$t('pageActions.boost.label', 'Boost this page with 2Z')}
      title={$t('pageActions.boost.label', 'Boost this page with 2Z')}
        >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-6 h-6" aria-hidden="true">
          <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
        </svg>
          </Button>
        </TooltipPrimitive.Trigger>
        <TooltipContent side="left">{$t('pageActions.boost.tooltip', 'Promote on F2Z')}</TooltipContent>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>

      <!-- score pill centered below the FAB; slight overlap with the circle. Smaller text & padding for compact look -->
      <div class="absolute left-1/2 transform -translate-x-1/2 translate-y-6">
        <div class='bg-(--f2z-accent-primary) text-(--f2z-bg-primary) rounded-full px-2 py-0.5 font-bold text-xs shadow-md'>
          {localScore ?? 0}
        </div>
      </div>

  </div>

  <!-- Local auth modal so clicking while logged-out opens the unified modal -->
  <UnifiedAuthModal bind:open={showAuthModal} />
