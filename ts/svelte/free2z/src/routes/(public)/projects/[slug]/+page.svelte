<script lang="ts">
  import { page } from '$app/stores';
  import { Button } from '$lib/components/ui/button';
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from '$lib/components/ui/card';

  $: slug = $page.params.slug;
</script>

<main class="container mx-auto py-8 px-4">
  <div class="max-w-4xl mx-auto">
    <Card>
      <CardHeader>
        <CardTitle>Project: {slug}</CardTitle>
      </CardHeader>
      <CardContent>
        <p class="mb-4">Project details and description.</p>
        <div class="flex gap-4">
          <Button>Contribute</Button>
          <Button variant="outline">Share</Button>
        </div>
      </CardContent>
    </Card>
  </div>
</main>
