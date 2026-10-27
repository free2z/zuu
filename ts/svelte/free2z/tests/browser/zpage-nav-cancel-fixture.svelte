<script lang="ts">
  // Test harness for zpage-nav-loading.spec.ts: a `beforeNavigate`
  // callback that cancels every link navigation, the way an unsaved-changes
  // guard does. It is mounted into a live zPage through the dev server, so it
  // shares the app's router.
  import { beforeNavigate } from "$app/navigation";

  beforeNavigate((navigation) => {
    if (navigation.type !== "link") return;
    navigation.cancel();
    const counter = window as unknown as { __f2zCancelledNavigations?: number };
    counter.__f2zCancelledNavigations =
      (counter.__f2zCancelledNavigations ?? 0) + 1;
  });
</script>
