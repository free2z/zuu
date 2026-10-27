<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { captureAccountToast, toastPresentation } from "$lib/toast.js";
  import { apiFetch } from "$lib/api/config";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import { tStore as t } from "$lib/i18n";
  import { authStore, currentUser } from "$lib/stores/auth";
  import InsufficientFunds from "$lib/components/InsufficientFunds.svelte";
  import {
    insufficientFundsFromResponse,
    type InsufficientFundsDetails,
  } from "$lib/insufficient-funds";
  import {
    clearIntentIdempotencyKey,
    isIdempotencyStorageUnavailable,
    isIdempotencyStorageCleanupFailure,
    intentIdempotencyKey,
    intentIdempotencySnapshot,
    storedIntentIdempotencyKey,
    archiveUnknownIntentIdempotencyKey,
  } from "$lib/subscribe-idempotency";
  import { Check, Loader2, Sparkles } from "@lucide/svelte";

  type CoverChoice = {
    id: string;
    provider: string;
    model: string;
    display_name: string;
    destination: string;
    privacy_policy_url: string;
    snapshot_token: string;
    price_2z: number;
    availability: string;
    queue: string;
  };

  type SavedCoverIntent = {
    actor: string;
    actorId: string;
    key?: string;
    prompt: string;
    generationPrompt: string;
    choice: CoverChoice;
    choiceSnapshot: string;
  };

  interface Props {
    apiBase: string;
    buildMediaUrl: (path?: string | null) => string;
    onGenerated: () => void;
    onChoose: (file: File, prompt: string) => void | Promise<void>;
  }

  const MAX_API_PROMPT_LENGTH = 4000;
  /*
    This used to say "designed for a 4:1 (1600 x 400) crop", which was guidance
    for a crop that no longer happens: nothing on the site crops a cover any
    more  and the editor no longer forces a shape. Asking
    for an ultra-wide composition with expendable background above and below was
    then actively counterproductive — a 4:1 image is the *worst* shape to store,
    because it maximises the blur pad on the square thumbnail, the densest
    surface on the site. What the model should aim for is a whole picture that
    reads well at any size.
  */
  const COVER_COMPOSITION_GUIDANCE =
    "Layout requirement: create a complete website cover image that is shown whole, never cropped. Compose it so it reads clearly at both large and thumbnail sizes, and keep every important subject, face and focal point well inside the frame rather than touching an edge. A landscape shape between 16:9 and square works best. Do not add text unless the user's prompt explicitly requests it.";
  const maxUserPromptLength =
    MAX_API_PROMPT_LENGTH - COVER_COMPOSITION_GUIDANCE.length - 2;

  let { apiBase, buildMediaUrl, onGenerated, onChoose }: Props = $props();

  let prompt = $state("");
  let generating = $state(false);
  let generatedFile = $state<File | null>(null);
  let generatedPreviewUrl = $state("");
  let generatedAttribution = $state<{
    provider: string;
    model: string;
  } | null>(null);
  let error = $state("");
  let unknownOutcomeIntent = $state<any | null>(null);
  let paymentError = $state<{ message: string; generation: number } | null>(
    null,
  );
  let outcomeGeneration = $state<number | null>(null);
  $effect(() => {
    if (
      outcomeGeneration !== null &&
      outcomeGeneration !== $toastPresentation.generation
    ) {
      error = "";
      insufficientFunds = null;
      paymentError = null;
      clearGeneratedImage();
      outcomeGeneration = null;
    }
  });
  function capturePaymentNotice() {
    return captureAccountToast({
      onError: (message) => {
        paymentError = {
          message: String(message),
          generation: $toastPresentation.generation,
        };
      },
    });
  }
  let insufficientFunds = $state<InsufficientFundsDetails | null>(null);
  let choices = $state<CoverChoice[]>([]);
  let savedCoverIntent = $state<SavedCoverIntent | null>(null);
  let selectedChoice = $state("");
  let acceptedTerms = $state(false);
  let hasChosenChoice = $state(false);
  let choicesLoaded = $state(false);

  function savedCoverIntentKey(actor: string) {
    return `f2z:creator-cover-intent:v1:${encodeURIComponent(actor)}`;
  }

  function coverIntentLockName(actor: string) {
    // Recovery storage has one slot per actor, so every cover transition shares a lock.
    return `f2z:creator-cover-intent-lock:v1:${encodeURIComponent(actor)}`;
  }

  function restoreSavedCoverIntent(actor: string, restoreEditor = false) {
    try {
      const saved = readSavedCoverIntent(actor);
      if (!saved) return;
      // Catalogue polling must not replace this tab's unresolved request with
      // a newer request another tab placed in the shared recovery slot.
      const pending = untrack(() => savedCoverIntent);
      if (pending?.actor === actor && pending.key && pending.key !== saved.key)
        return;
      savedCoverIntent = saved;
      if (restoreEditor) {
        prompt = saved.prompt;
        selectedChoice = saved.choice.id;
      }
    } catch {
      // An unreadable recovery record cannot authorize a paid retry.
    }
  }

  function readSavedCoverIntent(actor: string): SavedCoverIntent | null {
    const raw = localStorage.getItem(savedCoverIntentKey(actor));
    if (!raw) return null;
    const saved = JSON.parse(raw) as SavedCoverIntent;
    if (
      saved.actor !== actor ||
      $currentUser?.id === undefined ||
      saved.actorId !== String($currentUser.id) ||
      typeof saved.prompt !== "string" ||
      typeof saved.generationPrompt !== "string" ||
      typeof saved.choiceSnapshot !== "string" ||
      typeof saved.choice?.id !== "string"
    )
      return null;
    return saved;
  }

  function saveCoverIntent(saved: SavedCoverIntent) {
    localStorage.setItem(
      savedCoverIntentKey(saved.actor),
      JSON.stringify(saved),
    );
    savedCoverIntent = saved;
  }

  function clearSavedCoverIntent(actor: string, expectedKey?: string) {
    const key = savedCoverIntentKey(actor);
    if (expectedKey !== undefined) {
      try {
        const saved = JSON.parse(localStorage.getItem(key) ?? "null");
        if (saved?.actor !== actor || saved?.key !== expectedKey) return;
      } catch {
        return;
      }
    }
    localStorage.removeItem(key);
    if (
      savedCoverIntent?.actor === actor &&
      (expectedKey === undefined || savedCoverIntent.key === expectedKey)
    )
      savedCoverIntent = null;
  }

  let restoredActor: string | undefined;
  $effect(() => {
    const actor = $currentUser?.username;
    const actorId = $currentUser?.id;
    const identity =
      actor && actorId !== undefined ? `${actorId}:${actor}` : "";
    if (identity === restoredActor) return;
    const changedAccount = restoredActor !== undefined;
    restoredActor = identity;
    untrack(() => {
      savedCoverIntent = null;
      if (changedAccount) prompt = "";
      if (actor) restoreSavedCoverIntent(actor, true);
    });
  });

  let availabilityTimer: ReturnType<typeof setInterval>;
  onMount(() => {
    void loadChoices();
    availabilityTimer = setInterval(() => void loadChoices(), 60_000);
  });

  async function loadChoices() {
    choicesLoaded = false;
    try {
      const response = await apiFetch(`${apiBase}/api/ai/creator-options/`);
      if (!response.ok) throw new Error("Could not load AI choices");
      const data = await response.json();
      choices = Array.isArray(data?.cover) ? data.cover : [];
      const actor = $currentUser?.username;
      if (actor) restoreSavedCoverIntent(actor);
      if (!choices.some((choice) => choice.id === selectedChoice)) {
        if (savedCoverIntent?.choice.id === selectedChoice) {
          // Keep the recorded disclosure available for paid-receipt recovery.
        } else if (selectedChoice) {
          selectedChoice = "";
          acceptedTerms = false;
        } else if (!hasChosenChoice) {
          selectedChoice = choices[0]?.id ?? "";
          hasChosenChoice = Boolean(selectedChoice);
        }
      }
    } catch {
      choices = [];
      if (savedCoverIntent?.choice.id !== selectedChoice) selectedChoice = "";
    } finally {
      choicesLoaded = true;
    }
  }

  let selectedModel = $derived.by(() => {
    const savedIntent = savedCoverIntent;
    if (
      savedIntent &&
      savedIntent.actor === $currentUser?.username &&
      savedIntent.actorId === String($currentUser?.id) &&
      savedIntent.prompt === prompt.trim() &&
      savedIntent.choice.id === selectedChoice
    )
      return savedIntent.choice;
    return choices.find((choice) => choice.id === selectedChoice) ?? null;
  });
  let previousDisclosure = "";
  $effect(() => {
    const currentDisclosure = selectedModel
      ? JSON.stringify([
          selectedModel.id,
          selectedModel.provider,
          selectedModel.model,
          selectedModel.destination,
          selectedModel.privacy_policy_url,
          selectedModel.price_2z,
          selectedModel.snapshot_token,
          prompt,
        ])
      : "";
    if (previousDisclosure && currentDisclosure !== previousDisclosure) {
      acceptedTerms = false;
    }
    previousDisclosure = currentDisclosure;
  });

  function revokePreviewUrl() {
    if (generatedPreviewUrl) {
      URL.revokeObjectURL(generatedPreviewUrl);
      generatedPreviewUrl = "";
    }
  }

  function clearGeneratedImage() {
    revokePreviewUrl();
    generatedFile = null;
    generatedAttribution = null;
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

  async function responseError(response: Response, data?: any) {
    let detail = "";

    if (data === undefined) {
      try {
        data = await response.json();
      } catch {
        // Use a status-specific or generic message below.
      }
    }

    try {
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

    // Older deployments answered 403 for authorization failures. Valid
    // balance refusals are intercepted above and use the shared contract.
    if (response.status === 403) {
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
    const preflightActor = $currentUser?.id ?? $currentUser?.username;
    const authenticationOwner = authStore.captureRequestOwnership();
    const ownsPreflight =
      preflightActor !== undefined ? authenticationOwner : () => true;
    let operationNotice = capturePaymentNotice();
    const trimmedPrompt = prompt.trim().slice(0, maxUserPromptLength);
    if (!trimmedPrompt || generating || !selectedModel) {
      return;
    }
    const choiceForRequest = selectedModel;
    const savedIntent = savedCoverIntent;
    let savedRequest =
      savedIntent &&
      savedIntent.actor === $currentUser?.username &&
      savedIntent.actorId === String($currentUser?.id) &&
      savedIntent.prompt === trimmedPrompt &&
      savedIntent.choice.id === choiceForRequest.id
        ? savedIntent
        : null;
    const generationPrompt =
      savedRequest?.generationPrompt ??
      `${trimmedPrompt}\n\n${COVER_COMPOSITION_GUIDANCE}`;
    let preservesOtherSavedIntent = Boolean(savedIntent && !savedRequest);

    // Lock before the authentication await so rapid clicks cannot start two
    // generation attempts while the session is being hydrated.
    generating = true;
    error = "";
    paymentError = null;
    insufficientFunds = null;
    clearGeneratedImage();

    try {
      const authenticated = await authStore.ensureAuthenticated();
      if (destroyed) return;
      if (!ownsPreflight()) {
        if (!destroyed && authenticationOwner.wasExpired?.()) {
          operationNotice.error(
            $t("economy.signInAgain", "Sign in again before continuing."),
          );
        }
        return;
      }
      if (!authenticated || !$currentUser) {
        error = $t(
          "editor.aiCoverSignedOut",
          "Your session has expired. Sign in again to generate an image.",
        );
        return;
      }

      operationNotice = capturePaymentNotice();
      outcomeGeneration = $toastPresentation.generation;
      const expectedActorId = $currentUser.id;
      // The actor must come from the resolved session. Minting while the
      // identity store is still null would put this charge in a fallback
      // bucket, so a later hydrated retry could be charged again.
      const intent = {
        actor: $currentUser.username,
        action: "ai_image",
        resource: "/api/openai/image",
        // A fixed operation label keeps the key stable if the server refreshes
        // the displayed price or provider snapshot after an ambiguous result.
        amount: "creator-cover",
        intent: JSON.stringify({
          choice: choiceForRequest.id,
          prompt: generationPrompt,
          size: "1536x1024",
        }),
      };
      const previousIntent =
        choiceForRequest.id === "openai-image"
          ? {
              actor: $currentUser.username,
              action: "ai_image",
              resource: "/api/openai/image",
              amount: "6",
              intent: JSON.stringify({
                prompt: generationPrompt,
                size: "1536x1024",
              }),
            }
          : undefined;
      const lockManager = navigator.locks;
      if (!lockManager)
        throw new Error(
          "This browser cannot safely coordinate paid AI requests across tabs. Update your browser before submitting.",
        );
      let requestKey: string | undefined;
      let snapshotToken: string | null = null;
      let isLegacyRetry = false;
      await lockManager.request(coverIntentLockName(intent.actor), () => {
        if (
          !operationNotice.isCurrent() ||
          !ownsPreflight() ||
          $currentUser?.username !== intent.actor ||
          $currentUser?.id !== expectedActorId
        )
          return;
        const latestSavedIntent = readSavedCoverIntent(intent.actor);
        const latestSavedRequest =
          latestSavedIntent &&
          latestSavedIntent.prompt === trimmedPrompt &&
          latestSavedIntent.choice.id === choiceForRequest.id
            ? latestSavedIntent
            : null;
        if (
          !savedRequest &&
          latestSavedRequest &&
          (latestSavedRequest.choiceSnapshot !==
            choiceForRequest.snapshot_token ||
            JSON.stringify(latestSavedRequest.choice) !==
              JSON.stringify(choiceForRequest))
        ) {
          savedCoverIntent = latestSavedRequest;
          acceptedTerms = false;
          error =
            "The saved request has different provider or pricing terms. Review them and agree before retrying.";
          return;
        }
        // This tab's unresolved request owns its exact key even if another
        // tab completes it and clears/replaces the shared recovery slot.
        if (!savedRequest && latestSavedRequest)
          savedRequest = latestSavedRequest;
        preservesOtherSavedIntent = Boolean(
          latestSavedIntent &&
          (!latestSavedRequest ||
            (savedRequest?.key && latestSavedIntent.key !== savedRequest.key)),
        );
        const legacyKey = previousIntent
          ? storedIntentIdempotencyKey(previousIntent)
          : undefined;
        requestKey =
          savedRequest?.key ??
          intentIdempotencyKey(intent, {
            supersedes: previousIntent,
          });
        isLegacyRetry = legacyKey !== undefined && legacyKey === requestKey;
        snapshotToken = isLegacyRetry
          ? null
          : (savedRequest?.choiceSnapshot ??
            intentIdempotencySnapshot(
              intent,
              requestKey,
              choiceForRequest.snapshot_token,
            ));
        if (!isLegacyRetry && !preservesOtherSavedIntent) {
          saveCoverIntent({
            actor: intent.actor,
            actorId: String(expectedActorId),
            key: requestKey,
            prompt: trimmedPrompt,
            generationPrompt,
            choice: choiceForRequest,
            choiceSnapshot: snapshotToken as string,
          });
        } else if (savedRequest && savedRequest.key !== requestKey) {
          saveCoverIntent({ ...savedRequest, key: requestKey });
        }
      });
      const activeRequestKey = requestKey;
      if (
        !activeRequestKey ||
        !ownsPreflight() ||
        $currentUser?.id !== expectedActorId
      )
        return;

      const response = await apiFetch(`${apiBase}/api/openai/image`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": activeRequestKey,
          "X-Expected-Actor": String(expectedActorId),
          ...(isLegacyRetry ? { "X-Require-Existing-Receipt": "true" } : {}),
        },
        body: JSON.stringify({
          prompt: generationPrompt,
          size: "1536x1024",
          ...(isLegacyRetry
            ? {}
            : {
                choice: choiceForRequest.id,
                choice_snapshot: snapshotToken,
              }),
        }),
      });

      if (!response.ok) {
        const funds =
          response.status === 402
            ? await insufficientFundsFromResponse(response)
            : null;
        if (funds) {
          await retirePaidIntent(
            intent,
            previousIntent,
            operationNotice,
            activeRequestKey,
            preservesOtherSavedIntent,
          );
          if (operationNotice.isCurrent()) insufficientFunds = funds;
          return;
        }
        let responseBody: any = null;
        try {
          responseBody = await response.json();
        } catch {
          // Keep the status-specific fallback below.
        }
        if (
          response.status === 409 &&
          responseBody?.code === "provider_outcome_unknown"
        ) {
          if (operationNotice.isCurrent())
            unknownOutcomeIntent = {
              intent,
              previousIntent,
              key: activeRequestKey,
            };
        }
        if (
          response.status === 409 &&
          responseBody?.code === "legacy_replay_unavailable"
        ) {
          await retirePaidIntent(
            intent,
            previousIntent,
            operationNotice,
            activeRequestKey,
            preservesOtherSavedIntent,
          );
          if (operationNotice.isCurrent()) acceptedTerms = false;
        }
        if (
          response.status === 409 &&
          responseBody?.detail === "This image model is no longer available."
        ) {
          // The server rejects this before provider I/O and releases the claim.
          await retirePaidIntent(
            intent,
            previousIntent,
            operationNotice,
            activeRequestKey,
            preservesOtherSavedIntent,
          );
        }
        if (responseBody?.key_resolved === true) {
          await retirePaidIntent(
            intent,
            previousIntent,
            operationNotice,
            activeRequestKey,
            preservesOtherSavedIntent,
          );
          if (operationNotice.isCurrent()) acceptedTerms = false;
        }
        const message = await responseError(response, responseBody);
        if (operationNotice.isCurrent()) error = message;
        return;
      }

      const result = await response.json();
      const imagePath = generatedImageUrl(result);
      if (!imagePath) {
        throw new Error(
          $t(
            "editor.aiCoverMissingImage",
            "The image was generated, but its preview was unavailable. Look for it in Your Cloud.",
          ),
        );
      }

      // A lost preview or changed session must keep this paid generation
      // replayable, so retrying the same prompt cannot debit it again.
      if (!operationNotice.isCurrent()) return;
      if (
        result &&
        typeof result === "object" &&
        typeof result.provider === "string" &&
        typeof result.model === "string"
      ) {
        generatedAttribution = {
          provider: result.provider,
          model: result.model,
        };
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
      if (!operationNotice.isCurrent()) return;
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
      await retirePaidIntent(
        intent,
        previousIntent,
        operationNotice,
        activeRequestKey,
        preservesOtherSavedIntent,
      );
    } catch (caught: any) {
      if (!operationNotice.isCurrent()) return;
      if (isIdempotencyStorageUnavailable(caught)) {
        error = $t(
          "payments.storageUnavailable",
          "Browser storage is unavailable. Restore it and check any previous payment before retrying. This attempt was not sent.",
        );
        return;
      }
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

  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
    clearInterval(availabilityTimer);
    revokePreviewUrl();
  });

  async function retirePaidIntent(
    identity: Parameters<typeof clearIntentIdempotencyKey>[0],
    supersedes: NonNullable<
      Parameters<typeof clearIntentIdempotencyKey>[1]
    >["supersedes"],
    notice: ReturnType<typeof captureAccountToast>,
    expectedKey: string,
    preservesOtherSavedIntent: boolean,
  ) {
    try {
      const lockManager = (navigator as Navigator & { locks?: LockManager })
        .locks;
      if (!lockManager) return;
      await lockManager.request(coverIntentLockName(identity.actor), () => {
        clearIntentIdempotencyKey(identity, {
          supersedes,
          expectedKey,
        });
        // The recovery slot owns its own key. Another tab may already have
        // cleared the generic key while this tab recovered its receipt.
        // Compare-and-delete the exact recovery key independently.
        if (!preservesOtherSavedIntent)
          clearSavedCoverIntent(identity.actor, expectedKey);
        // A different tab may already have retired shared storage. This tab
        // has now recovered its own response and can forget its local retry.
        if (
          savedCoverIntent?.actor === identity.actor &&
          savedCoverIntent.key === expectedKey
        )
          savedCoverIntent = null;
      });
    } catch (error) {
      if (!isIdempotencyStorageCleanupFailure(error)) throw error;
      notice.error(
        $t(
          "payments.storageCleanup",
          "Browser storage could not save this outcome. Check the request's outcome before retrying.",
        ),
      );
    }
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
  {#if paymentError}
    <p
      role="alert"
      data-testid="payment-outcome-error"
      class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
    >
      {paymentError.message}
    </p>
  {/if}
  <div class="space-y-2">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm font-medium text-foreground">
        {$t("editor.aiCoverPromptLabel", "Describe your cover image")}
      </p>
      <div class="flex items-center gap-1.5">
        <Badge variant="secondary" class="gap-1.5">
          <Sparkles class="h-3.5 w-3.5" />
          {$t("editor.aiAttribution", "Free2Z AI")}
        </Badge>
      </div>
    </div>

    {#if selectedModel}
      <label class="block space-y-1.5 text-sm" for="ai-cover-model">
        <span class="font-medium"
          >{$t("editor.aiModelChoice", "Image model")}</span
        >
        <select
          id="ai-cover-model"
          class="w-full rounded-md border bg-background px-3 py-2"
          value={selectedChoice}
          onchange={(event) => {
            selectedChoice = event.currentTarget.value;
            hasChosenChoice = true;
            acceptedTerms = false;
          }}
          disabled={generating || choices.length < 2}
        >
          {#each choices as choice (choice.id)}
            <option value={choice.id}
              >{choice.display_name} · {choice.provider}</option
            >
          {/each}
        </select>
      </label>
      <div
        class="space-y-1 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground"
        aria-live="polite"
      >
        <p>
          {$t("editor.aiDestination", "Prompt sent to {destination}").replace(
            "{destination}",
            selectedModel.destination,
          )} · {selectedModel.provider} / {selectedModel.model}
        </p>
        <p>
          {$t("editor.aiCoverExactPrice", "Free2Z charge: {price} 2Z").replace(
            "{price}",
            String(selectedModel.price_2z),
          )} · {$t(
            "editor.aiNoAutomaticFallback",
            "No automatic model switching",
          )}
        </p>
        <p>
          {$t("editor.aiAvailability", "Availability: {availability}").replace(
            "{availability}",
            selectedModel.availability,
          )}
        </p>
        <p>{selectedModel.queue}</p>
        <p>
          {$t(
            "editor.aiRetentionDisclosure",
            "Provider retention follows its published policy; Free2Z does not control the provider’s retention settings.",
          )}
          <a
            class="underline"
            href={selectedModel.privacy_policy_url}
            target="_blank"
            rel="noreferrer"
            >{$t("editor.aiProviderPolicy", "Provider policy")}</a
          >
          ·
          <a class="underline" href="/docs/legal/privacy-policy/"
            >{$t("editor.aiFree2zPolicy", "Free2Z privacy policy")}</a
          >
        </p>
      </div>
      <label class="flex items-start gap-2 text-sm">
        <input type="checkbox" bind:checked={acceptedTerms} class="mt-1" />
        <span
          >{$t(
            "editor.aiAcceptTerms",
            "I understand this prompt will be sent to {destination} and agree to the displayed charge and provider policy.",
          ).replace("{destination}", selectedModel.destination)}</span
        >
      </label>
    {:else if choices.length > 0}
      <label class="block space-y-1.5 text-sm" for="ai-cover-model">
        <span class="font-medium"
          >{$t("editor.aiModelChoice", "Image model")}</span
        >
        <select
          id="ai-cover-model"
          class="w-full rounded-md border bg-background px-3 py-2"
          value={selectedChoice}
          onchange={(event) => {
            selectedChoice = event.currentTarget.value;
            hasChosenChoice = true;
            acceptedTerms = false;
          }}
        >
          <option value="" disabled
            >{$t("editor.aiChooseModel", "Choose a model")}</option
          >
          {#each choices as choice (choice.id)}
            <option value={choice.id}
              >{choice.display_name} · {choice.provider}</option
            >
          {/each}
        </select>
      </label>
      <p class="text-sm text-muted-foreground" role="status">
        {$t(
          "editor.aiModelChanged",
          "The previous model is no longer available. Choose a model to continue.",
        )}
      </p>
    {:else if choicesLoaded}
      <p
        class="rounded-md border px-3 py-2 text-sm text-muted-foreground"
        role="status"
      >
        {$t(
          "editor.aiNoCoverModels",
          "Image generation is currently unavailable. No prompt was sent.",
        )}
      </p>
    {:else}
      <p class="text-sm text-muted-foreground" role="status">
        {$t("editor.aiLoadingChoices", "Checking available models…")}
      </p>
    {/if}

    <Textarea
      bind:value={prompt}
      oninput={() => (acceptedTerms = false)}
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
        "Key subjects are kept well inside the frame so the whole image reads at any size. You can still adjust the framing afterwards.",
      )}
    </p>
  </div>

  {#if insufficientFunds}
    <InsufficientFunds funds={insufficientFunds} />
  {:else if error}
    <div
      class="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      role="alert"
    >
      {error}
      {#if unknownOutcomeIntent}
        <Button
          type="button"
          class="mt-3"
          variant="outline"
          onclick={async () => {
            const acknowledged = unknownOutcomeIntent;
            if (!acknowledged) return;
            try {
              const lockManager = navigator.locks;
              if (!lockManager)
                throw new Error(
                  "This browser cannot safely coordinate paid AI requests across tabs. Update your browser before continuing.",
                );
              await lockManager.request(
                coverIntentLockName(acknowledged.intent.actor),
                () => {
                  archiveUnknownIntentIdempotencyKey(acknowledged.intent, {
                    supersedes: acknowledged.previousIntent,
                    expectedKey: acknowledged.key,
                  });
                  clearSavedCoverIntent(
                    acknowledged.intent.actor,
                    acknowledged.key,
                  );
                  if (unknownOutcomeIntent?.key === acknowledged.key)
                    unknownOutcomeIntent = null;
                },
              );
              if (unknownOutcomeIntent === null) {
                acceptedTerms = false;
                error = $t(
                  "editor.aiCoverNewAttemptDisclosure",
                  "The unresolved key is preserved. Review the provider disclosure and price again before starting a new paid attempt.",
                );
              }
            } catch {
              if (unknownOutcomeIntent?.key === acknowledged.key)
                error = $t(
                  "payments.storageCleanup",
                  "Browser storage could not preserve the unresolved request. Restore storage before trying again.",
                );
            }
          }}
        >
          {$t(
            "editor.aiCoverNewAttempt",
            "I reviewed my balance; allow a new paid attempt",
          )}
        </Button>
      {/if}
    </div>
  {/if}

  {#if generatedPreviewUrl}
    <div class="space-y-3">
      {#if generatedAttribution}
        <p class="text-xs text-muted-foreground" role="status">
          {$t("editor.aiGeneratedWith", "Generated with {provider} / {model}")
            .replace("{provider}", generatedAttribution.provider)
            .replace("{model}", generatedAttribution.model)}
        </p>
      {/if}
      <div class="overflow-hidden rounded-xl border bg-muted">
        <img
          src={generatedPreviewUrl}
          alt={$t("editor.aiCoverPreviewAlt", "Generated cover preview")}
          class="block w-full"
        />
      </div>
      <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          onclick={() => void generateImage()}
          disabled={generating ||
            !prompt.trim() ||
            !selectedModel ||
            !acceptedTerms}
        >
          {#if generating}
            <Loader2 class="h-4 w-4 animate-spin" />
          {:else}
            <Sparkles class="h-4 w-4" />
          {/if}
          {$t("editor.aiCoverGenerateAgain", "Generate Again")}
        </Button>
        <Button type="button" onclick={() => void chooseGeneratedImage()}>
          <Check class="h-4 w-4" />
          {$t("editor.aiCoverUse", "Use This Image")}
        </Button>
      </div>
    </div>
  {:else}
    <Button
      type="button"
      class="self-end"
      onclick={() => void generateImage()}
      disabled={generating ||
        !prompt.trim() ||
        !selectedModel ||
        !acceptedTerms}
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
