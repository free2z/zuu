<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { tStore as t } from "$lib/i18n";
</script>

<section
  data-testid="homepage-cta"
  class="relative z-10 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8"
>
  <div class="mx-auto max-w-5xl text-center">
    <h2
      class="mb-6 text-4xl leading-[0.95] font-black tracking-tighter sm:mb-8 sm:text-6xl sm:leading-[0.9] lg:text-7xl"
    >
      {$t("homepage.cta.ownContent", "Own your content.")}<br />
      <span
        class="animate-gradient bg-300% bg-linear-to-r from-primary to-emerald-400 bg-clip-text text-transparent"
        >{$t("homepage.cta.monetizeMind", "Monetize your mind.")}</span
      >
    </h2>

    <p
      class="mx-auto max-w-2xl text-lg leading-relaxed font-light text-muted-foreground sm:text-2xl"
    >
      {$t(
        "homepage.cta.description",
        "Publish independently, connect directly with readers, and receive support, including direct Zcash payments.",
      )}
    </p>

    <!-- Stats / Trust Indicators -->
    <!--
			The label row is the tightest thing on the page: "Intermediaries" is 14
			uppercase characters in a column that is only ~1/3 of a 320px viewport
			. Below `sm` the type shrinks and the tracking tightens so every
			label stays on one line at 320px; `break-words` remains as a last-resort
			guard so a wider font can never overflow its column and collide with the
			neighbouring label the way it used to.
		-->
    <div
      class="mx-auto mt-8 mb-8 grid max-w-2xl grid-cols-3 gap-1 border-y border-dashed border-border/60 py-6 sm:mt-12 sm:mb-12 sm:gap-8 sm:py-8"
    >
      <div class="flex flex-col">
        <span class="text-2xl font-black text-foreground sm:text-3xl">100%</span
        >
        <span
          class="mt-1 text-[9px] leading-tight font-bold tracking-tight break-words text-muted-foreground uppercase sm:text-xs sm:tracking-wider"
          >{$t("homepage.cta.ownership", "Ownership")}</span
        >
      </div>
      <div class="flex flex-col">
        <span class="text-2xl font-black text-foreground sm:text-3xl">0</span>
        <span
          class="mt-1 text-[9px] leading-tight font-bold tracking-tight break-words text-muted-foreground uppercase sm:text-xs sm:tracking-wider"
          >{$t("homepage.cta.intermediaries", "Intermediaries")}</span
        >
      </div>
      <div class="flex flex-col">
        <span class="text-2xl font-black text-foreground sm:text-3xl">∞</span>
        <span
          class="mt-1 text-[9px] leading-tight font-bold tracking-tight break-words text-muted-foreground uppercase sm:text-xs sm:tracking-wider"
          >{$t("homepage.cta.possibilities", "Possibilities")}</span
        >
      </div>
    </div>

    <div class="flex flex-col items-center justify-center gap-4 sm:flex-row">
      <Button
        href="/login?view=signup&next=%2Fedit"
        class="group/btn min-h-11 w-full sm:min-h-9 sm:w-auto"
      >
        {$t("homepage.cta.startWriting", "Start Writing Now")}
        <svg
          class="h-4 w-4 transition-transform group-hover/btn:translate-x-1"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          ><path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M13 7l5 5m0 0l-5 5m5-5H6"
          /></svg
        >
      </Button>
      <Button
        variant="outline"
        href="https://free2z.com/docs/getting-started/"
        target="_blank"
        rel="noreferrer"
        class="min-h-11 w-full sm:min-h-9 sm:w-auto"
      >
        {$t("homepage.cta.howItWorks", "How it Works")}
      </Button>
    </div>

    <p class="mt-6 font-mono text-xs text-muted-foreground opacity-60">
      // {$t(
        "homepage.cta.noCardRequired",
        "No credit card required. Choose the privacy options that fit you.",
      )}
    </p>
  </div>
</section>
