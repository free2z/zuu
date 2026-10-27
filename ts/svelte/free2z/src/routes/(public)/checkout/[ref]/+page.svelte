<script lang="ts">
  import type { PageData } from "./$types";
  import { Button } from "$lib/components/ui/button";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import { tStore as t } from "$lib/i18n";
  import SeoHead from "$lib/components/SeoHead.svelte";
  import { NOINDEX_ROBOTS } from "$lib/seo";

  export let data: PageData;

  $: ref = data.ref;
</script>

<!--: link unfurlers reach this page since Django's card tier
     (checkout_social: the site card, noindex) was retired. SeoHead gives
     the shared link the same complete card; robots stays noindex. -->
<SeoHead
  title={$t("checkout.metaTitle", "Checkout {reference} · Free2Z", {
    reference: ref,
  })}
  description={$t(
    "checkout.metaDescription",
    "Choose how to pay for checkout {reference} on Free2Z.",
    { reference: ref },
  )}
  robots={NOINDEX_ROBOTS}
/>

<main class="container mx-auto px-4 py-8">
  <div class="mx-auto max-w-2xl">
    <Card>
      <CardHeader>
        <CardTitle
          >{$t("checkout.title", "Checkout: {reference}", {
            reference: ref,
          })}</CardTitle
        >
      </CardHeader>
      <CardContent>
        <div class="space-y-4">
          <div>
            <Badge>Stripe</Badge>
            <p class="mt-2">
              {$t("checkout.creditCard", "Pay with credit card")}
            </p>
            <Button class="mt-2" href={data.stripeHref}
              >{$t("checkout.payWithStripe", "Pay with Stripe")}</Button
            >
          </div>
          <div>
            <Badge variant="secondary">Zcash</Badge>
            <p class="mt-2">{$t("checkout.zcash", "Pay with Zcash")}</p>
            <Button variant="outline" class="mt-2" href={data.zcashHref}
              >{$t("checkout.payWithZcash", "Pay with Zcash")}</Button
            >
          </div>
        </div>
      </CardContent>
    </Card>
  </div>
</main>
