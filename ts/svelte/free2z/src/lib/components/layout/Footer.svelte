<script lang="ts">
  import {
    ArrowUpRight,
    BookOpen,
    Github,
    Heart,
    LockKeyhole,
    MessageCircleQuestion,
  } from "@lucide/svelte";
  import { loading, tStore as t } from "$lib/i18n";
  import LanguageSelector from "$lib/components/layout/LanguageSelector.svelte";
  import ModeToggle from "$lib/components/layout/ModeToggle.svelte";

  const year = new Date().getFullYear();
  const linkClass =
    "group inline-flex w-fit items-center gap-1.5 text-sm text-(--f2z-text-muted) transition-colors hover:text-(--f2z-text-primary) focus-visible:text-(--f2z-accent-primary) focus-visible:outline-none";
</script>

<footer
  class="relative mt-16 overflow-hidden border-t border-(--f2z-border-primary) bg-(--f2z-bg-secondary)"
  aria-label={$t("footer.label", "Site footer")}
>
  <div class="pointer-events-none absolute inset-0" aria-hidden="true">
    <div
      class="absolute inset-0 bg-[linear-gradient(to_right,#8080800d_1px,transparent_1px),linear-gradient(to_bottom,#8080800d_1px,transparent_1px)] mask-[radial-gradient(ellipse_80%_90%_at_50%_50%,#000_45%,transparent_100%)] bg-size-[24px_24px]"
    ></div>
    <div class="footer-wordmark">Free2Z</div>
  </div>
  <div
    class="pointer-events-none absolute -top-32 left-1/2 h-64 w-[42rem] -translate-x-1/2 rounded-full bg-(--f2z-accent-primary)/8 blur-3xl"
  ></div>
  <div
    class="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-(--f2z-accent-primary)/55 to-transparent"
  ></div>

  <div
    class="relative mx-auto max-w-7xl px-5 pt-12 pb-6 sm:px-8 sm:pt-14 lg:px-10"
  >
    <div
      class="grid gap-10 border-b border-(--f2z-border-primary) pb-10 sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr_1.15fr] lg:gap-12"
    >
      <div class="max-w-sm sm:col-span-2 lg:col-span-1">
        <a
          href="/"
          class="inline-flex items-center gap-2 text-2xl font-bold tracking-tight text-(--f2z-text-primary) transition-colors hover:text-(--f2z-accent-primary) focus-visible:text-(--f2z-accent-primary) focus-visible:outline-none"
          aria-label={$t("footer.home", "Free2Z home")}
        >
          <span
            class="grid size-9 place-items-center rounded-xl border border-(--f2z-accent-primary)/25 bg-(--f2z-accent-primary)/10 text-base text-(--f2z-accent-primary) shadow-sm"
            >2Z</span
          >
          {!$loading ? $t("common.navigation.logo", "Free2Z") : "Free2Z"}
        </a>
        <p class="mt-4 max-w-xs text-sm leading-6 text-(--f2z-text-muted)">
          {$t(
            "footer.tagline",
            "Independent publishing, direct support, and the freedom to create.",
          )}
        </p>
        <a
          href="/free2z"
          class="mt-5 inline-flex h-8 min-w-28 items-center justify-start gap-1.5 rounded-md border border-(--f2z-border-primary) bg-(--f2z-bg-primary)/70 px-2 text-(--f2z-text-secondary) shadow-none backdrop-blur-sm transition-all hover:border-(--f2z-accent-primary)/45 hover:bg-(--f2z-bg-primary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/30 focus-visible:outline-none"
          title={$t(
            "footer.statusDescription",
            "Official platform status and updates",
          )}
        >
          <span class="relative flex size-1.5">
            <span
              class="absolute inline-flex size-full animate-ping rounded-full bg-(--f2z-accent-primary) opacity-50"
            ></span>
            <span
              class="relative inline-flex size-1.5 rounded-full bg-(--f2z-accent-primary)"
            ></span>
          </span>
          <span class="flex-1 text-left text-xs font-medium">
            {$t("footer.status", "Status & updates")}
          </span>
          <ArrowUpRight class="size-2.5 text-(--f2z-text-muted)" />
        </a>
      </div>

      <nav aria-label={$t("footer.resources", "Resources")}>
        <h2
          class="text-xs font-semibold tracking-[0.14em] text-(--f2z-text-secondary) uppercase"
        >
          {$t("footer.resources", "Resources")}
        </h2>
        <ul class="mt-4 space-y-3">
          <li>
            <a href="/docs/" data-sveltekit-reload class={linkClass}>
              <BookOpen
                class="size-4 text-(--f2z-text-tertiary) transition-colors group-hover:text-(--f2z-accent-primary)"
              />
              {$t("footer.documentation", "Documentation")}
            </a>
          </li>
          <li>
            <a
              href="/docs/getting-started/"
              data-sveltekit-reload
              class={linkClass}
            >
              <MessageCircleQuestion
                class="size-4 text-(--f2z-text-tertiary) transition-colors group-hover:text-(--f2z-accent-primary)"
              />
              {$t("footer.help", "Help center")}
            </a>
          </li>
          <li>
            <a
              href="/docs/privacy-and-security/"
              data-sveltekit-reload
              class={linkClass}
            >
              <LockKeyhole
                class="size-4 text-(--f2z-text-tertiary) transition-colors group-hover:text-(--f2z-accent-primary)"
              />
              {$t("footer.security", "Privacy & security")}
            </a>
          </li>
        </ul>
      </nav>

      <nav aria-label={$t("footer.legal", "Legal")}>
        <h2
          class="text-xs font-semibold tracking-[0.14em] text-(--f2z-text-secondary) uppercase"
        >
          {$t("footer.legal", "Legal")}
        </h2>
        <ul class="mt-4 space-y-3">
          <li>
            <a href="/docs/legal/" data-sveltekit-reload class={linkClass}
              >{$t("footer.terms", "Terms of service")}</a
            >
          </li>
          <li>
            <a
              href="/docs/legal/privacy-policy/"
              data-sveltekit-reload
              class={linkClass}>{$t("footer.privacy", "Privacy policy")}</a
            >
          </li>
        </ul>
      </nav>

      <div>
        <h2
          class="text-xs font-semibold tracking-[0.14em] text-(--f2z-text-secondary) uppercase"
        >
          {$t("footer.connect", "Connect")}
        </h2>
        <div class="mt-4 flex items-center gap-1.5">
          <a
            href="https://x.com/free2zcash"
            target="_blank"
            rel="noreferrer"
            class="grid size-8 place-items-center rounded-full border border-(--f2z-border-primary) bg-(--f2z-bg-primary)/60 text-xs font-semibold text-(--f2z-text-muted) transition-all hover:-translate-y-0.5 hover:border-(--f2z-accent-primary)/45 hover:text-(--f2z-text-primary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/30 focus-visible:outline-none"
            aria-label={$t("footer.xLabel", "Free2Z on X")}>X</a
          >
          <a
            href="https://github.com/free2z/zuu"
            target="_blank"
            rel="noreferrer"
            class="grid size-8 place-items-center rounded-full border border-(--f2z-border-primary) bg-(--f2z-bg-primary)/60 text-(--f2z-text-muted) transition-all hover:-translate-y-0.5 hover:border-(--f2z-accent-primary)/45 hover:text-(--f2z-text-primary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/30 focus-visible:outline-none"
            aria-label={$t("footer.githubLabel", "Free2Z on GitHub")}
            ><Github class="size-3.5" /></a
          >
          <a
            href="/free2z"
            class="grid size-8 place-items-center rounded-full border border-(--f2z-border-primary) bg-(--f2z-bg-primary)/60 text-(--f2z-text-muted) transition-all hover:-translate-y-0.5 hover:border-(--f2z-accent-primary)/45 hover:text-(--f2z-text-primary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/30 focus-visible:outline-none"
            aria-label={$t("footer.communityLabel", "Free2Z community profile")}
            ><Heart class="size-3.5" /></a
          >
        </div>
        <p class="mt-4 text-xs leading-5 text-(--f2z-text-muted)">
          {$t(
            "footer.connectDescription",
            "Follow product news and join the conversation.",
          )}
        </p>
      </div>
    </div>

    <div
      class="flex flex-col gap-5 pt-6 lg:flex-row lg:items-center lg:justify-between"
    >
      <p class="order-2 text-xs text-(--f2z-text-muted) lg:order-1">
        © {year} 2Z Inc. {$t("footer.rights", "All rights reserved.")}
      </p>
      <div
        class="order-1 flex flex-wrap items-center gap-2 lg:order-2"
        aria-label={$t("footer.preferences", "Display preferences")}
      >
        <span
          class="mr-1 hidden text-xs font-medium text-(--f2z-text-muted) sm:inline"
        >
          {$t("footer.preferences", "Display preferences")}
        </span>
        <LanguageSelector />
        <ModeToggle />
      </div>
    </div>
  </div>
</footer>

<style>
  .footer-wordmark {
    position: absolute;
    top: clamp(0.5rem, 1.5vw, 1.25rem);
    left: 0;
    width: 100%;
    white-space: nowrap;
    color: color-mix(in srgb, var(--f2z-accent-primary) 7%, transparent);
    background: linear-gradient(
      105deg,
      transparent 35%,
      color-mix(in srgb, var(--f2z-accent-primary) 18%, transparent) 50%,
      transparent 65%
    );
    background-position: 100% 50%;
    background-size: 240% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    font-size: clamp(8rem, 27vw, 33rem);
    font-weight: 800;
    letter-spacing: -0.07em;
    line-height: 1;
    text-align: center;
    mask-image: linear-gradient(to bottom, black 15%, transparent 82%);
    animation: footer-wordmark-glint 14s linear infinite;
    will-change: background-position;
  }

  @keyframes footer-wordmark-glint {
    from {
      background-position: 100% 50%;
    }
    to {
      background-position: -100% 50%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .footer-wordmark {
      animation: none;
      background-position: 50% 50%;
    }
  }
</style>
