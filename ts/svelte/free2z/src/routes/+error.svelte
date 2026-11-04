<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { Button } from "$lib/components/ui/button";
  import Home from "@lucide/svelte/icons/home";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import { tStore as t } from "$lib/i18n";
  import { isSdkFlow } from "$lib/sdk-flow";

  const errorMap: Record<
    number,
    {
      titleKey: string;
      title: string;
      descriptionKey: string;
      description: string;
    }
  > = {
    400: {
      titleKey: "errors.http.400.title",
      title: "Bad Request",
      descriptionKey: "errors.http.400.description",
      description:
        "The server could not understand the request due to invalid syntax.",
    },
    401: {
      titleKey: "errors.http.401.title",
      title: "Unauthorized",
      descriptionKey: "errors.http.401.description",
      description: "You need to be logged in to access this page.",
    },
    403: {
      titleKey: "errors.http.403.title",
      title: "Forbidden",
      descriptionKey: "errors.http.403.description",
      description: "You do not have permission to access this resource.",
    },
    404: {
      titleKey: "errors.http.404.title",
      title: "Not Found",
      descriptionKey: "errors.http.404.description",
      description:
        "We couldn't find the page you're looking for. It may have been moved, renamed, or temporarily unavailable.",
    },
    // 410 is not 404 with nicer wording: it is the answer for a feature that
    // was deliberately retired. Without an entry here it fell through
    // to "Unknown Error / please contact support", which invites a support
    // ticket for something working exactly as intended.
    410: {
      titleKey: "errors.http.410.title",
      title: "No Longer Available",
      descriptionKey: "errors.http.410.description",
      description:
        "This feature has been retired and the page is permanently gone. Nothing replaced it, so there is nowhere new to send you.",
    },
    // An API throttle forwarded by an SSR loader, with the API's
    // Retry-After. "Unknown Error / contact support" would invite exactly the
    // immediate retries the throttle is asking the reader not to make.
    429: {
      titleKey: "errors.http.429.title",
      title: "Too Many Requests",
      descriptionKey: "errors.http.429.description",
      description:
        "We're getting more requests than we can serve right now. Please wait a moment before trying again.",
    },
    500: {
      titleKey: "errors.http.500.title",
      title: "Server Error",
      descriptionKey: "errors.http.500.description",
      description: "Something went wrong on our end. Please try again later.",
    },
    503: {
      titleKey: "errors.http.503.title",
      title: "Service Unavailable",
      descriptionKey: "errors.http.503.description",
      description:
        "The server is currently unavailable. Please try again later.",
    },
  };

  const currentStatus = $derived(page.status);
  const statusInfo = $derived(errorMap[currentStatus]);
  const serverMessageKey = $derived(
    page.error?.message?.startsWith("errors.") ? page.error.message : null,
  );
  const errorInfo = $derived({
    title: serverMessageKey
      ? $t(serverMessageKey, statusInfo?.title || "Unknown Error")
      : statusInfo
        ? $t(statusInfo.titleKey, statusInfo.title)
        : $t("errors.unknown.title", "Unknown Error"),
    description: statusInfo
      ? $t(statusInfo.descriptionKey, statusInfo.description)
      : $t(
          "errors.unknown.description",
          "Something went wrong. Please try again or contact support.",
        ),
  });

  // On a page an SDK app opens there is no way into the site from here:
  // "Go Back" only goes back, and the button is hidden with no history.
  const sdkPage = $derived(isSdkFlow(new URL(page.url.href)));
  const canGoBack = $derived(
    !sdkPage || (typeof window !== "undefined" && window.history.length > 1),
  );

  function goBack() {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    if (sdkPage) return;

    void goto("/");
  }
</script>

<svelte:head>
  <title>{currentStatus} — {errorInfo.title} | Free2Z</title>
  <meta name="robots" content="noindex, nofollow, noarchive" />
</svelte:head>

<div
  class="relative flex h-[calc(100vh-3.5rem)] w-full shrink-0 flex-col items-center justify-center overflow-hidden bg-background"
>
  <!-- Abstract Background (Entire Page) -->
  <div class="pointer-events-none absolute inset-0 overflow-hidden select-none">
    <!-- Gradient -->
    <div
      class="absolute inset-0 bg-linear-to-b from-primary/5 via-transparent to-primary/5"
    ></div>

    <!-- Animated Rings (Centered) -->
    <div
      class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 scale-50 opacity-50 sm:scale-75 md:scale-100"
    >
      <!-- Inner Ring -->
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <div
          class="h-[300px] w-[300px] animate-[spin_12s_linear_infinite] rounded-full border-[3px] border-primary/30"
        ></div>
      </div>
      <!-- Middle Ring -->
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <div
          class="h-[500px] w-[500px] animate-[spin_20s_linear_infinite_reverse] rounded-full border-2 border-dashed border-primary/20"
        ></div>
      </div>
      <!-- Outer Ring -->
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <div
          class="h-[700px] w-[700px] animate-[spin_30s_linear_infinite] rounded-full border border-primary/30"
        ></div>
      </div>
      <!-- Extra Outer Ring -->
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <div
          class="h-[900px] w-[900px] animate-[spin_60s_linear_infinite_reverse] rounded-full border-4 border-dotted border-primary/10"
        ></div>
      </div>
    </div>

    <!-- Floating Particles -->
    <div
      class="absolute top-1/4 left-1/4 h-4 w-4 animate-bounce rounded-full bg-primary/20 delay-100"
    ></div>
    <div
      class="absolute right-1/4 bottom-1/3 h-3 w-3 animate-bounce rounded-full bg-primary/10 delay-300"
    ></div>
    <div
      class="absolute top-1/3 right-1/3 h-2 w-2 animate-pulse rounded-full bg-primary/10"
    ></div>
    <div
      class="absolute bottom-1/4 left-1/3 h-2 w-2 animate-pulse rounded-full bg-primary/20 delay-700"
    ></div>
  </div>

  <!-- Content -->
  <div
    class="animate-float-up relative z-10 mx-auto max-w-lg space-y-4 px-6 text-center sm:space-y-8"
  >
    <div class="space-y-4">
      <h1
        class="cursor-default bg-linear-to-b from-foreground to-foreground/50 bg-clip-text text-[5rem] leading-none font-black tracking-tighter text-transparent drop-shadow-sm transition-all duration-500 select-none hover:scale-105 hover:to-primary/50 sm:text-[7rem] md:text-[10rem]"
      >
        {currentStatus}
      </h1>
      <h2 class="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        {errorInfo.title}
      </h2>
      <p
        class="mx-auto max-w-md text-base leading-relaxed text-muted-foreground sm:text-lg"
      >
        {errorInfo.description}
      </p>
    </div>

    <div
      class="flex flex-col items-center justify-center gap-3 pt-4 sm:flex-row sm:gap-4 sm:pt-8"
    >
      {#if canGoBack}
        <Button
          variant="outline"
          onclick={goBack}
          class="w-full min-w-[140px] gap-2 transition-all sm:w-auto "
        >
          <ArrowLeft class="h-4 w-4" />
          {$t("errors.goBack", "Go Back")}
        </Button>
      {/if}
      <!-- Not on a page an SDK app opens: "home" is the site, whose
           navigation reaches Credits ($lib/sdk-flow). -->
      {#if !sdkPage}
        <Button
          href="/"
          variant="default"
          class="w-full min-w-[140px] gap-2 shadow-lg transition-all  hover:shadow-primary/25 sm:w-auto"
        >
          <Home class="h-4 w-4" />
          {$t("errors.returnHome", "Return Home")}
        </Button>
      {/if}
    </div>
  </div>
</div>
