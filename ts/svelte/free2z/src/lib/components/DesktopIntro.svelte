<script lang="ts">
  import { tStore as t } from "$lib/i18n";
  import { Button } from "$lib/components/ui/button";
</script>

<section
  class="relative hidden px-4 pt-3 pb-1 sm:px-6 md:block lg:px-8"
  aria-labelledby="desktop-intro-heading"
>
  <div
    class="relative mx-auto grid max-w-7xl gap-6 lg:max-w-6xl lg:grid-cols-[minmax(0,1fr)_minmax(30rem,0.9fr)] lg:items-center lg:gap-16"
  >
    <div>
      <p
        class="mb-2 text-sm font-semibold tracking-[0.2em] text-(--f2z-accent-primary) uppercase"
      >
        {$t("homepage.mobileEyebrow", "Independent publishing")}
      </p>
      <h1
        id="desktop-intro-heading"
        class="max-w-5xl text-4xl leading-[1.02] font-bold tracking-[-0.05em] text-(--f2z-text-primary) lg:text-6xl"
      >
        {$t("homepage.mobileHeadline", "Ideas worth your attention.")}
      </h1>
      <p
        class="mt-3 max-w-4xl text-xl leading-relaxed text-(--f2z-text-muted) lg:text-2xl"
      >
        {$t(
          "homepage.mobileDescription",
          "Read independent voices, discover original work, and support creators directly.",
        )}
      </p>
    </div>

    <div
      class="lg:max-w-xl lg:justify-self-end lg:border-l lg:border-(--f2z-border-primary)/60 lg:pl-8"
    >
      <div
        class="mt-1 grid grid-cols-3 gap-5 border-y border-dashed border-(--f2z-border-primary)/70 py-3 lg:mt-0 lg:gap-6 lg:py-4"
      >
        <div class="flex flex-col">
          <span
            class="text-2xl font-black tracking-tight text-(--f2z-text-primary) lg:text-3xl"
            >100%</span
          >
          <span
            class="mt-1 text-[10px] font-bold tracking-[0.08em] text-(--f2z-text-muted) uppercase lg:text-xs"
          >
            {$t("homepage.cta.ownership", "Ownership")}
          </span>
        </div>
        <div
          class="flex flex-col border-l border-(--f2z-border-primary)/60 pl-4"
        >
          <span
            class="text-2xl font-black tracking-tight text-(--f2z-text-primary) lg:text-3xl"
            >0</span
          >
          <span
            class="mt-1 text-[10px] font-bold tracking-[0.08em] text-(--f2z-text-muted) uppercase lg:text-xs"
          >
            {$t("homepage.cta.intermediaries", "Intermediaries")}
          </span>
        </div>
        <div
          class="flex flex-col border-l border-(--f2z-border-primary)/60 pl-4"
        >
          <span
            class="text-2xl font-black tracking-tight text-(--f2z-text-primary) lg:text-3xl"
            >∞</span
          >
          <span
            class="mt-1 text-[10px] font-bold tracking-[0.08em] text-(--f2z-text-muted) uppercase lg:text-xs"
          >
            {$t("homepage.cta.possibilities", "Possibilities")}
          </span>
        </div>
      </div>

      <div class="mt-4 flex max-w-full flex-wrap items-center gap-3">
        <Button
          href="/login?view=signup&next=%2Fedit"
          size="lg"
          class="group/btn h-10 max-w-full rounded-lg px-5 text-base font-semibold shadow-none"
        >
          {$t("homepage.cta.startWriting", "Start Writing Now")}
          <svg
            class="size-4 transition-transform group-hover/btn:translate-x-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M13 7l5 5m0 0-5 5m5-5H6"
            />
          </svg>
        </Button>
        <a
          href="/docs/getting-started/"
          data-sveltekit-reload
          class="inline-flex h-10 shrink-0 items-center rounded-lg px-3 text-base font-medium text-(--f2z-text-secondary) no-underline transition-colors hover:text-(--f2z-accent-primary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/30 focus-visible:outline-none"
        >
          {$t("homepage.cta.howItWorks", "How it Works")}
        </a>
      </div>
    </div>
  </div>
</section>
