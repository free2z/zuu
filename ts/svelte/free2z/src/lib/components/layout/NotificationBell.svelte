<script lang="ts">
  /**
   * The notification bell, including "we stopped listening".
   *
   * The `/ws/profile` reconnect breaker is reachable since, so a real
   * outage can leave a tab with no live notifications for minutes at a time.
   * Nothing in the UI said so: a bell that gave up looked exactly like a bell
   * with no news.
   *
   * ## Why the state lives on the bell rather than beside it
   *
   * The first version of this was a separate amber control next to the bell.
   * Codex review measured it: at 320px on any non-home route the navbar
   * already fits its viewport exactly (menu, brand, search, create, converse,
   * bell, avatar), and one more 32px control pushed the document to 332px —
   * a horizontally scrolling navbar, during an outage, on the narrowest phones
   * we support. A status that breaks the layout it appears in is not an
   * improvement over silence.
   *
   * Folding the state into the bell costs zero layout width at every viewport,
   * and it is also the better design: one control, one meaning, and the
   * meaning is attached to the thing whose behaviour changed.
   *
   * ## Why the click both reconnects and navigates
   *
   * A user who suspects they missed something wants the list, and the list is
   * fetched over HTTP — so the click already recovers what the dead socket
   * cost them. Asking for a reconnection on the way is the part they cannot do
   * themselves. When the controller refuses (its resume cooldown), we say so
   * rather than leave an amber bell that looks ignored.
   *
   * Deliberately silent during ordinary reconnects: the fast retry loop
   * recovers most blips without anyone noticing, and a warning that fires on
   * every blip is a warning people learn to ignore.
   */
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { Bell, BellOff } from "@lucide/svelte";
  import { toast } from "$lib/toast.js";

  import { Button } from "$lib/components/ui/button";
  import { tStore as t } from "$lib/i18n";
  import { currentUser } from "$lib/stores/auth";
  import { requestLogin } from "$lib/stores/auth-modal";
  import { eventNotifications } from "$lib/stores/eventNotifications";
  import {
    notificationSocketAffordance,
    notificationSocketStatus,
  } from "$lib/stores/notificationSocket";

  let { class: className = "" }: { class?: string } = $props();

  const live = $derived($notificationSocketAffordance === "none");
  const retrying = $derived($notificationSocketAffordance === "retrying");
  // Compare against the DECODED pathname. URL.pathname percent-encodes
  // non-ASCII but leaves `@` and `+` alone, while encodeURIComponent encodes
  // `@`/`+` AND non-ASCII — so a username like `kévin+f2z` matched neither
  // naive comparison and the bell stayed dark on its own notifications page.
  // decodeURIComponent normalises both encodings to one comparable form.
  const isActive = $derived.by(() => {
    if (!$currentUser?.username) return false;
    const raw = page.url.pathname;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // Malformed %-escape in the URL; compare the raw pathname instead.
      decoded = raw;
    }
    const base = `/${$currentUser.username}/dashboard/notifications`;
    return decoded === base || decoded.startsWith(`${base}/`);
  });

  const label = $derived(
    live
      ? $t("common.navigation.notifications", "Notifications")
      : retrying
        ? $t(
            "notifications.socket.reconnectingLabel",
            "Notifications — reconnecting live updates…",
          )
        : $t(
            "notifications.socket.offlineLabel",
            "Notifications — live updates are offline. Tap to reconnect.",
          ),
  );

  function handleClick() {
    if (!live && !notificationSocketStatus.retry()) {
      // Refused by the resume cooldown, which exists so a click-happy user
      // cannot hand-drive the tab back to the connection rate the breaker just
      // stopped. Saying nothing would rebuild, one layer up, exactly the
      // silence this component exists to remove.
      //
      // The copy deliberately does not promise a time. Codex review caught an
      // earlier version saying "in a moment" while the armed slow-lane probe
      // was 2.5-7.5 minutes out — a reassurance that is simply not true is a
      // worse outcome than the silence.
      toast.info(
        $t(
          "notifications.socket.retryThrottled",
          "Just tried — we'll keep retrying in the background.",
        ),
      );
    }

    if ($currentUser?.username) {
      goto(`/${$currentUser.username}/dashboard/notifications`);
      return;
    }
    // Only reachable if the bell is rendered for a visitor the store has
    // since signed out; open the modal where they are.
    requestLogin();
  }
</script>

<Button
  variant="ghost"
  size="icon-sm"
  class="relative {className} {live
    ? isActive
      ? 'text-(--f2z-accent-primary)'
      : ''
    : 'text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300'}"
  aria-current={isActive ? "page" : undefined}
  aria-label={label}
  title={label}
  data-testid="navbar-notifications"
  data-socket-state={$notificationSocketAffordance}
  onclick={handleClick}
>
  {#if live}
    <Bell class="size-[0.9375rem] sm:size-4" />
  {:else}
    <!-- A struck-through bell reads as "not listening" without relying on the
         amber, which a colourblind user may not resolve; the pulse is the only
         thing separating "gave up" from "trying again right now", and it is
         bounded by the controller's handshake deadline. -->
    <BellOff
      class="size-[0.9375rem] sm:size-4 {retrying
        ? 'animate-pulse motion-reduce:animate-none'
        : ''}"
    />
  {/if}
  {#if $eventNotifications.unreadCount > 0}
    <span
      class="absolute -top-1 right-0 h-5 min-w-5 rounded-full bg-primary px-1 text-center text-[10px] leading-5 font-bold text-primary-foreground"
    >
      {$eventNotifications.unreadCount > 99
        ? "99+"
        : $eventNotifications.unreadCount}
    </span>
  {/if}
</Button>
<!-- The label above is on a button that is always mounted, so a screen reader
     is never told it changed. This is the announcement. -->
<span class="sr-only" aria-live="polite">{live ? "" : label}</span>
