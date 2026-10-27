<script lang="ts">
  import { tStore as t } from "$lib/i18n";
  import { Button } from "$lib/components/ui/button";
</script>

<!-- A compact editorial masthead for anonymous visitors: enough context and
     an onboarding path without putting a marketing panel in front of the feed. -->
<header class="relative overflow-x-clip px-4 pt-2">
  <div
    class="pointer-events-none absolute -top-24 -right-20 size-72 rounded-full bg-(--f2z-accent-primary)/10 blur-3xl"
    aria-hidden="true"
  ></div>
  <div class="relative pt-1 pb-4">
    <div class="relative">
      <p
        class="mb-2 text-[11px] font-semibold tracking-[0.16em] text-(--f2z-accent-primary) uppercase"
      >
        {$t("homepage.mobileEyebrow", "Independent publishing")}
      </p>
      <h1
        class="max-w-sm text-[1.75rem] leading-[1.08] font-bold tracking-[-0.035em] text-(--f2z-text-primary)"
      >
        {$t("homepage.mobileHeadline", "Ideas worth your attention.")}
      </h1>
      <p class="mt-2 max-w-md text-sm leading-6 text-(--f2z-text-muted)">
        {$t(
          "homepage.mobileDescription",
          "Read independent voices, discover original work, and support creators directly.",
        )}
      </p>

      <div
        class="mt-4 grid grid-cols-3 gap-2 border-y border-dashed border-(--f2z-border-primary)/70 py-3"
      >
        <div class="flex flex-col">
          <span
            class="text-lg font-black tracking-tight text-(--f2z-text-primary)"
            >100%</span
          >
          <span
            class="mt-0.5 text-[9px] font-bold tracking-[0.08em] text-(--f2z-text-muted) uppercase"
          >
            {$t("homepage.cta.ownership", "Ownership")}
          </span>
        </div>
        <div
          class="flex flex-col border-l border-(--f2z-border-primary)/60 pl-3"
        >
          <span
            class="text-lg font-black tracking-tight text-(--f2z-text-primary)"
            >0</span
          >
          <span
            class="mt-0.5 text-[9px] font-bold tracking-[0.08em] text-(--f2z-text-muted) uppercase"
          >
            {$t("homepage.cta.intermediaries", "Intermediaries")}
          </span>
        </div>
        <div
          class="flex flex-col border-l border-(--f2z-border-primary)/60 pl-3"
        >
          <span
            class="text-lg font-black tracking-tight text-(--f2z-text-primary)"
            >∞</span
          >
          <span
            class="mt-0.5 text-[9px] font-bold tracking-[0.08em] text-(--f2z-text-muted) uppercase"
          >
            {$t("homepage.cta.possibilities", "Possibilities")}
          </span>
        </div>
      </div>

      <div
        class="mt-4 flex max-w-full flex-wrap items-center gap-1.5 max-[380px]:flex-col max-[380px]:items-stretch"
      >
        <Button
          href="/login?view=signup&next=%2Fedit"
          size="sm"
          class="group/btn h-9 max-w-full rounded-md px-3 text-sm font-semibold shadow-none max-[380px]:w-full"
        >
          {$t("homepage.cta.startWriting", "Start Writing Now")}
          <svg
            class="size-3.5 transition-transform group-hover/btn:translate-x-0.5"
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
          class="inline-flex h-9 shrink-0 items-center rounded-md px-2.5 text-sm font-medium text-(--f2z-text-secondary) no-underline transition-colors hover:text-(--f2z-accent-primary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/30 focus-visible:outline-none max-[380px]:w-full max-[380px]:justify-center"
        >
          {$t("homepage.cta.howItWorks", "How it Works")}
        </a>
      </div>
    </div>
  </div>
</header>
