<script lang="ts">
  import { onDestroy } from "svelte";
  import { apiFetch } from "$lib/api/config";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import { tStore as t } from "$lib/i18n";
  import { Coins, Crop, Loader2, Sparkles } from "@lucide/svelte";

  interface Props {
    apiBase: string;
    buildMediaUrl: (path?: string | null) => string;
    onGenerated: () => void;
    onChoose: (file: File, prompt: string) => void | Promise<void>;
  }

  const MAX_API_PROMPT_LENGTH = 4000;
  const COVER_COMPOSITION_GUIDANCE =
    "Layout requirement: create an ultra-wide panoramic website cover designed for a 4:1 (1600 x 400) crop. Keep every important subject, face, focal point, and essential detail inside the central horizontal band. Leave generous breathing room on the left and right, with expendable background above and below. Do not add text unless the user's prompt explicitly requests it.";
  const maxUserPromptLength =
    MAX_API_PROMPT_LENGTH - COVER_COMPOSITION_GUIDANCE.length - 2;

  let { apiBase, buildMediaUrl, onGenerated, onChoose }: Props = $props();

  let prompt = $state("");
  let generating = $state(false);
  let generatedFile = $state<File | null>(null);
  let generatedPreviewUrl = $state("");
  let error = $state("");

  function revokePreviewUrl() {
    if (generatedPreviewUrl) {
      URL.revokeObjectURL(generatedPreviewUrl);
      generatedPreviewUrl = "";
    }
  }

  function clearGeneratedImage() {
    revokePreviewUrl();
    generatedFile = null;
  }

  function generatedImageUrl(data: unknown): string {
    if (typeof data === "string") {
      return data;
    }

    if (data && typeof data === "object" && "url" in data) {
      const url = (data as { url?: unknown }).url;
      return typeof url === "string" ? url : "";
    }

    return "";
  }

  async function responseError(response: Response) {
    let detail = "";

    try {
      const data = await response.json();
      const responseDetail = data?.detail || data?.message || data?.error;
      if (typeof responseDetail === "string") {
        detail = responseDetail.trim();
      }
    } catch {
      // Use a status-specific or generic message below.
    }

    if (response.status === 401) {
      return $t(
        "editor.aiCoverSignedOut",
        "Your session has expired. Sign in again to generate an image.",
      );
    }

    if (response.status === 403) {
      const balanceError = /enough|2zs?|tuzi/i.test(detail);
      if (balanceError) {
        return $t(
          "editor.aiCoverInsufficientBalance",
          "You need at least 5 2Zs to generate an image. You have not been charged.",
        );
      }

      return (
        detail ||
        $t(
          "editor.aiCoverNotAllowed",
          "You do not have permission to generate an image. Try signing in again.",
        )
      );
    }

    if (detail) {
      return detail;
    }

    return $t(
      "editor.aiCoverGenerationFailed",
      "We could not generate that image. Please try again.",
    );
  }

  async function generateImage() {
    const trimmedPrompt = prompt.trim().slice(0, maxUserPromptLength);
    if (!trimmedPrompt || generating) {
      return;
    }

    const generationPrompt = `${trimmedPrompt}\n\n${COVER_COMPOSITION_GUIDANCE}`;

    generating = true;
    error = "";
    clearGeneratedImage();

    try {
      const response = await apiFetch(`${apiBase}/api/openai/image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: generationPrompt,
          size: "1792x1024",
        }),
      });

      if (!response.ok) {
        error = await responseError(response);
        return;
      }

      const imagePath = generatedImageUrl(await response.json());
      if (!imagePath) {
        throw new Error(
          $t(
            "editor.aiCoverMissingImage",
            "The image was generated, but its preview was unavailable. Look for it in Your Cloud.",
          ),
        );
      }

      onGenerated();

      const imageResponse = await fetch(buildMediaUrl(imagePath), {
        credentials: "include",
      });
      if (!imageResponse.ok) {
        throw new Error(
          $t(
            "editor.aiCoverPreviewFailed",
            "The image was generated, but its preview could not be loaded. Look for it in Your Cloud.",
          ),
        );
      }

      const blob = await imageResponse.blob();
      if (!blob.type.startsWith("image/")) {
        throw new Error(
          $t(
            "editor.aiCoverInvalidImage",
            "The generated file was not a supported image.",
          ),
        );
      }

      const extension = blob.type.split("/")[1] || "webp";
      generatedFile = new File([blob], `ai-cover.${extension}`, {
        type: blob.type,
      });
      generatedPreviewUrl = URL.createObjectURL(blob);
    } catch (caught: any) {
      error =
        caught?.message ||
        $t(
          "editor.aiCoverGenerationFailed",
          "We could not generate that image. Please try again.",
        );
    } finally {
      generating = false;
    }
  }

  async function chooseGeneratedImage() {
    if (!generatedFile) {
      return;
    }

    await onChoose(generatedFile, prompt.trim());
  }

  onDestroy(revokePreviewUrl);
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
  <div class="space-y-2">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm font-medium text-foreground">
        {$t("editor.aiCoverPromptLabel", "Describe your cover image")}
      </p>
      <Badge variant="outline" class="gap-1.5">
        <Coins class="h-3.5 w-3.5" />
        {$t("editor.aiCoverCost", "Costs 5 2Zs")}
      </Badge>
    </div>

    <Textarea
      bind:value={prompt}
      rows={4}
      maxlength={maxUserPromptLength}
      placeholder={$t(
        "editor.aiCoverPromptPlaceholder",
        "A cinematic mountain village at sunrise, with open space for a title…",
      )}
      disabled={generating}
      aria-label={$t("editor.aiCoverPromptLabel", "Describe your cover image")}
    />
    <p class="text-xs text-muted-foreground">
      {$t(
        "editor.aiCoverHint",
        "Key subjects will be kept in the center of a wide composition, then you can fine-tune the 1600 × 400 crop.",
      )}
    </p>
  </div>

  {#if error}
    <div
      class="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      role="alert"
    >
      {error}
    </div>
  {/if}

  {#if generatedPreviewUrl}
    <div class="space-y-3">
      <div class="overflow-hidden rounded-xl border bg-muted">
        <img
          src={generatedPreviewUrl}
          alt={$t("editor.aiCoverPreviewAlt", "Generated cover preview")}
          class="aspect-[7/4] w-full object-cover"
        />
      </div>
      <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          onclick={() => void generateImage()}
          disabled={generating || !prompt.trim()}
        >
          {#if generating}
            <Loader2 class="h-4 w-4 animate-spin" />
          {:else}
            <Sparkles class="h-4 w-4" />
          {/if}
          {$t("editor.aiCoverGenerateAgain", "Generate Again")}
        </Button>
        <Button type="button" onclick={() => void chooseGeneratedImage()}>
          <Crop class="h-4 w-4" />
          {$t("editor.aiCoverCrop", "Crop and Use")}
        </Button>
      </div>
    </div>
  {:else}
    <Button
      type="button"
      class="self-end"
      onclick={() => void generateImage()}
      disabled={generating || !prompt.trim()}
    >
      {#if generating}
        <Loader2 class="h-4 w-4 animate-spin" />
        {$t("editor.aiCoverGenerating", "Generating…")}
      {:else}
        <Sparkles class="h-4 w-4" />
        {$t("editor.aiCoverGenerate", "Generate Image")}
      {/if}
    </Button>
  {/if}
</div>
