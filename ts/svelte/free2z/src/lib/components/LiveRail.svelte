<script lang="ts">
  import { onMount, tick } from "svelte";
  import { Radio, Ticket, Users } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import { streamWatchPath } from "$lib/utils/stream-path";
  import type { PublicMeetingList } from "$lib/api/f2z.schemas";

  type Stream = PublicMeetingList;

  export let streams: Stream[] = [];
  /** Match the column of the content below (the anonymous intro is narrower). */
  export let narrow = false;
  export let imageUrl: (path?: string | null) => string | null;
  export let modeLabel: (stream: Stream) => string;
  export let ariaLabel: (stream: Stream) => string;

  // Avatar-less creators still get a tint of their own, stable per username.
  const FALLBACK_TINTS = [
    "linear-gradient(135deg,#f97316,#db2777)",
    "linear-gradient(135deg,#eab308,#16a34a)",
    "linear-gradient(135deg,#6366f1,#06b6d4)",
    "linear-gradient(135deg,#a855f7,#ec4899)",
    "linear-gradient(135deg,#14b8a6,#0ea5e9)",
  ];
  function fallbackTint(name: string): string {
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return FALLBACK_TINTS[hash % FALLBACK_TINTS.length];
  }

  // Avatars that fail to load fall back to initials instead of a broken image.
  let failed: Record<string, true> = {};
  function avatarFailed(key: string) {
    failed = { ...failed, [key]: true };
  }

  $: items = streams.map((stream) => {
    const key = stream.username + ":" + stream.meeting_type;
    const img = imageUrl(stream.avatar);
    const broken = Boolean(failed[key]);
    return {
      key,
      href: streamWatchPath(stream.username, stream.meeting_type),
      name: stream.username,
      initials: stream.username?.slice(0, 2).toUpperCase(),
      img,
      // The capsule is tinted by a blurred copy of the creator's own avatar,
      // so every pill carries that person's colours.
      broken,
      tint:
        img && !broken
          ? `url(${JSON.stringify(img)}) center / cover`
          : fallbackTint(stream.username ?? ""),
      mode: modeLabel(stream),
      // Same icons as the stream type everywhere else: free broadcast,
      // subscribers-only, pay-per-view.
      icon:
        stream.meeting_type === "broadcast"
          ? Radio
          : stream.meeting_type === "subscribers-only"
            ? Users
            : Ticket,
      label: ariaLabel(stream),
    };
  });

  // Edge fades appear only where there is more to scroll, so the first and
  // last capsules are never left half-faded.
  let rail: HTMLUListElement | undefined;
  let fadeStart = false;
  let fadeEnd = false;
  function updateFades() {
    if (!rail) return;
    const max = rail.scrollWidth - rail.clientWidth;
    fadeStart = rail.scrollLeft > 1;
    fadeEnd = rail.scrollLeft < max - 1;
  }
  $: if (rail && items) tick().then(updateFades);

  // Tabbing through the rail must always land on a fully visible capsule,
  // clear of the edge fades (scroll-padding-inline keeps that margin).
  function revealFocused(event: FocusEvent) {
    (event.target as HTMLElement).scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }
  onMount(() => {
    if (!rail || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateFades);
    observer.observe(rail);
    // Web fonts change capsule widths without resizing the rail itself.
    document.fonts?.ready.then(updateFades);
    return () => observer.disconnect();
  });
</script>

<!-- Live rail: a quiet strip that reads as the header line of the page below
     it (same column, mono label over a dashed rule, like "Featured Story"). The negative bottom margin
     cancels most of the shell gap so it sits with the hero, not apart from it. -->
<section
  data-testid="homepage-live-now"
  aria-labelledby="homepage-live-now-heading"
  class="relative z-10 -mb-6 md:-mt-2 md:-mb-8 lg:-mt-5 lg:-mb-16"
>
  <!-- Full-bleed glass band; the contents stay on the page column. -->
  <div
    class="live-card relative overflow-hidden border-y border-border/60 bg-card/30 backdrop-blur-sm"
  >
    <span
      class="pointer-events-none absolute -top-16 left-[10%] size-48 rounded-full bg-red-500/10 blur-3xl"
      aria-hidden="true"
    ></span>
    <div
      class="relative mx-auto flex max-w-7xl min-w-0 flex-col gap-3 px-4 py-3 sm:px-6 sm:py-4 lg:px-8 {narrow
        ? 'lg:max-w-[76rem]'
        : ''}"
    >
      <div class="relative flex items-center gap-3 px-1">
        <h2
          id="homepage-live-now-heading"
          class="flex shrink-0 items-center gap-2 font-mono text-[11px] font-bold tracking-[0.2em] text-red-500 uppercase"
        >
          <span class="live-dot" aria-hidden="true"></span>
          <span>{$t("homepage.liveNow", "Live Now")}</span>
          <span
            class="font-normal tracking-normal text-muted-foreground"
            aria-hidden="true">· {items.length}</span
          >
        </h2>
        <span
          class="h-px min-w-8 flex-1 border-t border-dashed border-border/50"
          aria-hidden="true"
        ></span>
      </div>

      <ul
        bind:this={rail}
        on:scroll|passive={updateFades}
        on:focusin={revealFocused}
        class:fade-start={fadeStart}
        class:fade-end={fadeEnd}
        class="rail-scroll relative -mx-3 -my-2 flex min-w-0 items-center gap-2.5 overflow-x-auto px-3 py-2 sm:-mx-4 sm:px-4"
      >
        {#each items as it (it.key)}
          <li class="shrink-0">
            <a
              data-testid="homepage-live-now-card"
              href={it.href}
              aria-label={it.label}
              class="capsule group relative flex items-center gap-2.5 overflow-hidden rounded-full border border-white/10 bg-background/40 py-1.5 pr-5 pl-1.5 backdrop-blur-sm transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-px hover:border-red-500/40 focus-visible:ring-2 focus-visible:ring-red-500/60 focus-visible:outline-none motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            >
              <span
                class="pointer-events-none absolute inset-0 scale-150 opacity-15 blur-xl saturate-150 transition-opacity duration-300 group-hover:opacity-30"
                style:background={it.tint}
                aria-hidden="true"
              ></span>
              <span
                class="pointer-events-none absolute inset-0 rounded-full bg-linear-to-b from-white/[0.07] to-transparent"
                aria-hidden="true"
              ></span>
              <!-- Hover detail: a single soft light sweep across the pill. -->
              <span class="sheen" aria-hidden="true"></span>

              <span class="live-ring avatar-pop relative shrink-0 rounded-full">
                <span
                  class="grid size-8 place-items-center overflow-hidden rounded-full text-[10px] font-bold text-white"
                  style:background={it.img && !it.broken ? undefined : it.tint}
                >
                  {#if it.img}
                    <!-- Kept in the DOM when it fails (hidden), so the
                         initials underneath show instead of a broken image. -->
                    <img
                      src={it.img}
                      on:error={() => avatarFailed(it.key)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      class="col-start-1 row-start-1 size-full object-cover"
                      class:invisible={it.broken}
                    />
                  {/if}
                  {#if !it.img || it.broken}
                    <span class="col-start-1 row-start-1">{it.initials}</span>
                  {/if}
                </span>
              </span>

              <span class="relative flex min-w-0 flex-col gap-1">
                <span
                  class="max-w-44 truncate text-sm leading-none font-semibold text-foreground"
                  >@{it.name}</span
                >
                <span
                  class="flex items-center gap-1 text-[11px] leading-none whitespace-nowrap text-muted-foreground transition-colors group-hover:text-foreground/75"
                >
                  <svelte:component
                    this={it.icon}
                    class="size-3 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{it.mode}</span>
                </span>
              </span>
            </a>
          </li>
        {/each}
      </ul>
    </div>
  </div>
</section>

<style>
  .live-dot {
    position: relative;
    display: inline-flex;
    width: 6px;
    height: 6px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: rgb(239 68 68);
  }
  .live-dot::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: inherit;
    animation: live-ping 1.4s cubic-bezier(0, 0, 0.2, 1) infinite;
  }
  @keyframes live-ping {
    75%,
    100% {
      transform: scale(2.4);
      opacity: 0;
    }
  }

  /* Red "on air" ring. The breathing glow lives on a pseudo-element and only
     its opacity animates, so it stays on the compositor (no per-frame paint). */
  .live-ring {
    box-shadow:
      0 0 0 2px var(--background, #0a0c09),
      0 0 0 3.5px rgb(239 68 68);
  }
  .live-ring::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: 0 0 10px 6px rgb(239 68 68 / 0.35);
    opacity: 0;
    pointer-events: none;
    animation: live-breathe 2.4s ease-in-out infinite;
  }
  @keyframes live-breathe {
    50% {
      opacity: 1;
    }
  }

  /* Hover/focus micro-interaction: everything below animates only transform
     and opacity, so it runs on the compositor. */
  .avatar-pop {
    transition: transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .capsule:hover .avatar-pop,
  .capsule:focus-visible .avatar-pop {
    transform: scale(1.08) rotate(-4deg);
  }
  .capsule:hover .live-ring::after,
  .capsule:focus-visible .live-ring::after {
    animation: none;
    opacity: 1;
    transition: opacity 300ms ease-out;
  }

  .sheen {
    position: absolute;
    inset: 0;
    pointer-events: none;
    border-radius: inherit;
    overflow: hidden;
  }
  .sheen::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 40%;
    background: linear-gradient(
      100deg,
      transparent,
      rgb(255 255 255 / 0.12),
      transparent
    );
    transform: translateX(-120%) skewX(-12deg);
    opacity: 0;
  }
  .capsule:hover .sheen::before,
  .capsule:focus-visible .sheen::before {
    animation: sheen-sweep 900ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
  }
  @keyframes sheen-sweep {
    0% {
      transform: translateX(-120%) skewX(-12deg);
      opacity: 1;
    }
    100% {
      transform: translateX(320%) skewX(-12deg);
      opacity: 0;
    }
  }

  .capsule:hover {
    box-shadow:
      0 8px 24px -12px rgb(239 68 68 / 0.55),
      inset 0 1px 0 rgb(255 255 255 / 0.06);
  }

  .rail-scroll {
    --fade-start: 0px;
    --fade-end: 0px;
    scrollbar-width: none;
    /* Keyboard focus scrolls a capsule clear of the edge fades. */
    scroll-padding-inline: 2.5rem;
    mask-image: linear-gradient(
      to right,
      transparent,
      #000 var(--fade-start),
      #000 calc(100% - var(--fade-end)),
      transparent
    );
  }
  .rail-scroll.fade-start {
    --fade-start: 2.5rem;
  }
  .rail-scroll.fade-end {
    --fade-end: 2.5rem;
  }
  .live-card {
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.04);
  }
  .rail-scroll::-webkit-scrollbar {
    display: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .live-dot::after,
    .live-ring::after {
      animation: none;
    }
    .avatar-pop {
      transition: none;
    }
    .capsule:hover .avatar-pop,
    .capsule:focus-visible .avatar-pop {
      transform: none;
    }
    .capsule:hover .sheen::before,
    .capsule:focus-visible .sheen::before {
      animation: none;
    }
  }
</style>
