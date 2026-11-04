<script lang="ts">
  import CreatorEarnings from "$lib/components/dashboard/CreatorEarnings.svelte";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { get } from "svelte/store";
  let owner = $state(get(currentUser)!);
  (window as any).switchEconomyFixtureOwner = () => {
    const next = {
      ...owner,
      id: owner.id + 1,
      username: "synthetic-new-owner",
    };
    authStore.hydrateFromSession(next);
    owner = next;
  };
</script>

<section data-testid="economy-reused-owner">
  <CreatorEarnings ownerUsername={owner.username} />
</section>
