<script lang="ts">
  import { ThumbsDown, ThumbsUp } from "@lucide/svelte";
  import { onDestroy } from "svelte";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { env } from "$env/dynamic/public";
  import type { CommentData } from "./types";
  import { toast } from "svelte-sonner";
  import { tStore as t } from "$lib/i18n";

  export let comment: CommentData;

  let tuzis = comment.tuzis;
  let pulsing: "up" | "down" | false = false;
  let voting = false;
  let pulseTimeout: ReturnType<typeof setTimeout> | undefined;
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  $: tuzis = comment.tuzis;

  function applyFallbackVote(voteType: "up" | "down") {
    tuzis += voteType === "up" ? 1 : -1;
  }

  async function applyVoteResponse(res: Response, voteType: "up" | "down") {
    const text = await res.text();
    if (!text) {
      applyFallbackVote(voteType);
      return;
    }

    try {
      const data = JSON.parse(text);
      const nextTuzis =
        data?.tuzis === undefined || data?.tuzis === null
          ? NaN
          : Number(data.tuzis);
      if (Number.isFinite(nextTuzis)) {
        tuzis = nextTuzis;
        return;
      }
    } catch (error) {
      console.error("Error parsing vote response:", error);
    }

    applyFallbackVote(voteType);
  }

  function schedulePulseEnd() {
    if (pulseTimeout) clearTimeout(pulseTimeout);
    pulseTimeout = setTimeout(() => {
      pulsing = false;
      pulseTimeout = undefined;
    }, 450);
  }

  onDestroy(() => {
    if (pulseTimeout) clearTimeout(pulseTimeout);
  });

  async function handleVote(voteType: "up" | "down") {
    if (voting) return;

    const hasActiveSession = await authStore.ensureAuthenticated();
    if (!hasActiveSession || !$currentUser) {
      toast.error($t("comments.loginToVote", "Please log in to vote"));
      return;
    }

    voting = true;
    if (pulseTimeout) clearTimeout(pulseTimeout);
    pulsing = voteType;

    try {
      const csrf = await authStore.ensureCSRFToken();
      const res = await fetch(`${apiBase}/api/comments/${comment.uuid}/vote/`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(csrf ? { "X-CSRFToken": csrf } : {}),
        },
        body: JSON.stringify({ vote: voteType }),
      });

      if (!res.ok) {
        if (authStore.handleAuthFailure(res.status)) {
          throw new Error($t("comments.loginToVote", "Please log in to vote"));
        }

        let errorMessage = $t("comments.voteFailed", "Vote failed");
        try {
          const contentType = res.headers.get("content-type");
          if (contentType?.includes("application/json")) {
            const data = await res.json();
            errorMessage = data.error || errorMessage;
          } else {
            errorMessage = $t(
              "comments.serverError",
              "Server error: {status} {statusText}",
            )
              .replace("{status}", String(res.status))
              .replace("{statusText}", res.statusText);
          }
        } catch (error) {
          console.error("Error parsing vote error:", error);
        }
        throw new Error(errorMessage);
      }

      await applyVoteResponse(res, voteType);
    } catch (error: any) {
      console.error(error);
      toast.error(
        error.message ||
          $t("comments.backendError", "Problem with backend, please try again"),
      );
    } finally {
      voting = false;
      schedulePulseEnd();
    }
  }
</script>

<div
  class="-ml-1.5 inline-flex items-center"
  role="group"
  aria-label={$t("comments.voteWeight", "Comment weight in 2Zs")}
>
  <button
    type="button"
    onclick={() => handleVote("up")}
    disabled={voting}
    aria-label={$t("comments.upvote", "Upvote")}
    class="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
  >
    <ThumbsUp
      strokeWidth={1.5}
      class="size-4 transition-transform duration-200 motion-reduce:transition-none {pulsing ===
      'up'
        ? 'text-primary motion-safe:-translate-y-0.5 motion-safe:scale-110'
        : ''}"
    />
  </button>

  <span
    class="flex items-baseline gap-0.5 px-0.5 transition-transform duration-200 motion-reduce:transition-none {pulsing
      ? 'motion-safe:scale-110'
      : ''}"
    aria-live="polite"
  >
    <span
      class="min-w-[1.5ch] text-center text-sm font-bold tabular-nums {tuzis > 0
        ? 'text-primary'
        : 'text-foreground'}"
    >
      {tuzis}
    </span>
    <span class="text-[10px] font-medium text-muted-foreground">2Zs</span>
  </span>

  <button
    type="button"
    onclick={() => handleVote("down")}
    disabled={voting}
    aria-label={$t("comments.downvote", "Downvote")}
    class="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
  >
    <ThumbsDown
      strokeWidth={1.5}
      class="size-4 transition-transform duration-200 motion-reduce:transition-none {pulsing ===
      'down'
        ? 'text-foreground motion-safe:translate-y-0.5 motion-safe:scale-110'
        : ''}"
    />
  </button>
</div>
