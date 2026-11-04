<script lang="ts">
  // The layout as it was BEFORE the fix: a per-render QueryClient handed to
  // QueryClientProvider with nothing arranging for its teardown.
  //
  // This fixture is the NEGATIVE CONTROL for tests/ssr-query-teardown.test.mjs.
  // It must never call registerSsrQueryClientRelease — its only job is to show
  // that a finished server render leaves an armed gc timer behind.
  //
  // It renders the real LiveIndicator, which is the component the heap snapshot
  // implicated: it appears once per card (~20 on the homepage) and its
  // `gcTime: 5 * 60 * 1000` is the `TimersList[300000]` bucket in the retaining
  // path.
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import type { QueryClient } from "@tanstack/svelte-query";
  import LiveIndicator from "$lib/components/stream/LiveIndicator.svelte";

  export let client: QueryClient;
  export let username: string;
</script>

<QueryClientProvider {client}>
  <LiveIndicator {username} />
</QueryClientProvider>
