<script lang="ts">
  // Identical to Unreleased.svelte except for the one line the fix adds, which
  // is also the one line `src/routes/+layout.svelte` adds. Rendering both in
  // the same process is what makes the regression test a real A/B rather than a
  // claim about a single number.
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import type { QueryClient } from "@tanstack/svelte-query";
  import LiveIndicator from "$lib/components/stream/LiveIndicator.svelte";
  import { registerSsrQueryClientRelease } from "$lib/query-client";

  export let client: QueryClient;
  export let username: string;

  registerSsrQueryClientRelease(client);
</script>

<QueryClientProvider {client}>
  <LiveIndicator {username} />
</QueryClientProvider>
