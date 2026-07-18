<script lang="ts">
  import type { PageData } from './$types';
  import { Button } from '$lib/components/ui/button';
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from '$lib/components/ui/card';
  import { Badge } from '$lib/components/ui/badge';

  export let data: PageData;

  $: ref = data.ref;
</script>

<main class="container mx-auto py-8 px-4">
  <div class="max-w-2xl mx-auto">
    <Card>
      <CardHeader>
        <CardTitle>Checkout: {ref}</CardTitle>
      </CardHeader>
      <CardContent>
        <div class="space-y-4">
          <div>
            <Badge>Stripe</Badge>
            <p class="mt-2">Pay with credit card</p>
            <Button class="mt-2" href={data.stripeHref}>Pay with Stripe</Button>
          </div>
          <div>
            <Badge variant="secondary">Zcash</Badge>
            <p class="mt-2">Pay with Zcash</p>
            <Button variant="outline" class="mt-2" href={data.zcashHref}>Pay with Zcash</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  </div>
</main>
