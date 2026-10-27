<script>
  /**
   * The live-photo step: a camera capture, with a file upload that is always
   * available beside it.
   *
   * SSR notes, because this is the one step that can take the whole page down:
   *
   *  * `navigator.mediaDevices` does not exist in Node. Nothing here touches it
   *    at module scope or during render — `cameraSupported()` runs inside
   *    `onMount`, which does not execute during SSR at all, and `canUseCamera`
   *    starts false so the server renders the fallback.
   *  * The upload fallback is not a consolation prize. A desktop with no camera
   *    and a browser where the applicant clicked "Block" are both ordinary, and
   *    on both of them uploading a photo is the *only* way through this step.
   *    It is therefore rendered first and unconditionally.
   *  * The stream is stopped on capture, on cancel and on destroy. A camera
   *    light left on after the applicant has moved to the next step is, quite
   *    reasonably, alarming.
   */
  import { createEventDispatcher, onDestroy, onMount, tick } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import {
    Camera,
    CameraOff,
    Loader2,
    RefreshCw,
    Trash2,
  } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import {
    CAPTURE_QUALITY,
    LIVE_PHOTO_CONSTRAINTS,
    blobToLivePhotoFile,
    cameraProblemKey,
    cameraSupported,
    classifyCameraError,
    stopStream,
  } from "$lib/kyc/camera.js";
  import {
    IDENTITY_PHOTO_ACCEPT,
    IDENTITY_PHOTO_EXTENSIONS,
    preflightUpload,
  } from "$lib/kyc/uploads.js";
  import {
    deleteIdentityDocument,
    uploadIdentityDocument,
    KycRequestError,
  } from "$lib/kyc/client.js";

  export let present = false;
  /** @type {string|null} */
  export let previewUrl = null;
  export let editable = true;

  const dispatch = createEventDispatcher();

  // False on the server and until onMount proves otherwise. Never invert this
  // default: a truthy start would render a camera UI into the SSR HTML that
  // cannot possibly work.
  let canUseCamera = false;
  let cameraOpen = false;
  let busy = false;
  let errorMessage = "";
  /** @type {MediaStream|null} */
  let stream = null;
  /** @type {HTMLVideoElement|null} */
  let video = null;
  /** @type {HTMLInputElement|null} */
  let fileInput = null;

  onMount(() => {
    canUseCamera = cameraSupported();
  });

  onDestroy(() => {
    stopStream(stream);
    stream = null;
  });

  async function openCamera() {
    errorMessage = "";
    busy = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia(
        LIVE_PHOTO_CONSTRAINTS,
      );
      cameraOpen = true;
      // The <video> only exists once `cameraOpen` has rendered.
      await tick();
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {
          // Autoplay refusal is survivable: the frame is still live, the
          // applicant may just need to interact first.
        });
      }
      // Send focus where the applicant now has to act, so a keyboard user is
      // not left on a button that has just disappeared.
      document.getElementById("kyc-capture-button")?.focus();
    } catch (err) {
      const problem = classifyCameraError(err);
      errorMessage = $t(
        cameraProblemKey(problem),
        "We could not open your camera. You can upload a photo instead.",
      );
      stopStream(stream);
      stream = null;
      cameraOpen = false;
    } finally {
      busy = false;
    }
  }

  function closeCamera() {
    stopStream(stream);
    stream = null;
    cameraOpen = false;
  }

  async function capture() {
    if (!video) return;
    busy = true;
    errorMessage = "";

    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      /** @type {Blob|null} */
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", CAPTURE_QUALITY),
      );
      if (!blob) throw new Error("empty capture");

      // Stop the camera the moment we have the frame, not after the upload
      // finishes — the applicant should not be filmed while a request is in
      // flight.
      closeCamera();

      const documents = await uploadIdentityDocument(
        "live_photo",
        blobToLivePhotoFile(blob),
      );
      dispatch("change", documents);
    } catch (err) {
      errorMessage =
        err instanceof KycRequestError && err.detail
          ? err.detail
          : $t(
              "dashboard.kyc.errors.captureFailed",
              "We could not save that photo. Please try again, or upload one instead.",
            );
    } finally {
      busy = false;
    }
  }

  /** @param {Event & {currentTarget: EventTarget & HTMLInputElement}} event */
  async function handleFile(event) {
    const file = event.currentTarget?.files?.[0];
    if (!file) return;

    const problem = preflightUpload(file, IDENTITY_PHOTO_EXTENSIONS);
    if (problem) {
      errorMessage = $t(problem.key, problem.fallback, problem.params);
      if (fileInput) fileInput.value = "";
      return;
    }

    errorMessage = "";
    busy = true;
    try {
      const documents = await uploadIdentityDocument("live_photo", file);
      dispatch("change", documents);
    } catch (err) {
      errorMessage =
        err instanceof KycRequestError && err.detail
          ? err.detail
          : $t(
              "dashboard.kyc.errors.uploadFailed",
              "We could not save that file. Please try again.",
            );
    } finally {
      busy = false;
      if (fileInput) fileInput.value = "";
    }
  }

  async function removePhoto() {
    busy = true;
    errorMessage = "";
    try {
      const documents = await deleteIdentityDocument("live_photo");
      dispatch("change", documents);
    } catch (err) {
      errorMessage =
        err instanceof KycRequestError && err.detail
          ? err.detail
          : $t(
              "dashboard.kyc.errors.removeFailed",
              "We could not remove that file. Please try again.",
            );
    } finally {
      busy = false;
    }
  }
</script>

<div class="rounded-lg border border-border p-4">
  {#if present}
    <div class="flex flex-col items-start gap-3">
      {#if previewUrl}
        <!-- Client-fetched URL: never part of the server-rendered payload. -->
        <img
          src={previewUrl}
          alt={$t("dashboard.kyc.livePhoto.savedAlt", "The photo you saved")}
          class="max-h-56 rounded-md border border-border object-contain"
        />
      {/if}
      <p class="text-sm text-muted-foreground">
        {$t("dashboard.kyc.livePhoto.saved", "Your photo is saved.")}
      </p>
      {#if editable}
        <Button variant="ghost" size="sm" disabled={busy} onclick={removePhoto}>
          <Trash2 class="mr-2 h-4 w-4" aria-hidden="true" />
          {$t("dashboard.kyc.livePhoto.retake", "Remove and take another")}
        </Button>
      {/if}
    </div>
  {:else if editable}
    {#if cameraOpen}
      <div class="flex flex-col items-start gap-3">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          bind:this={video}
          class="max-h-72 w-full max-w-sm rounded-md border border-border bg-black"
          playsinline
          muted
          autoplay
          aria-label={$t(
            "dashboard.kyc.livePhoto.videoLabel",
            "Live camera preview",
          )}
        ></video>
        <div class="flex flex-wrap gap-2">
          <Button id="kyc-capture-button" disabled={busy} onclick={capture}>
            {#if busy}
              <Loader2 class="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            {:else}
              <Camera class="mr-2 h-4 w-4" aria-hidden="true" />
            {/if}
            {$t("dashboard.kyc.livePhoto.capture", "Take the photo")}
          </Button>
          <Button variant="ghost" disabled={busy} onclick={closeCamera}>
            <CameraOff class="mr-2 h-4 w-4" aria-hidden="true" />
            {$t("dashboard.kyc.livePhoto.stop", "Turn the camera off")}
          </Button>
        </div>
      </div>
    {:else}
      <div class="flex flex-col items-start gap-3">
        <input
          bind:this={fileInput}
          id="kyc-live-photo-file"
          class="sr-only"
          type="file"
          accept={IDENTITY_PHOTO_ACCEPT}
          disabled={busy}
          on:change={handleFile}
        />
        <div class="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onclick={() => fileInput?.click()}
          >
            {$t("dashboard.kyc.livePhoto.upload", "Upload a photo")}
          </Button>
          {#if canUseCamera}
            <Button variant="outline" disabled={busy} onclick={openCamera}>
              {#if busy}
                <Loader2 class="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              {:else}
                <Camera class="mr-2 h-4 w-4" aria-hidden="true" />
              {/if}
              {$t("dashboard.kyc.livePhoto.open", "Use my camera")}
            </Button>
          {/if}
          {#if errorMessage}
            <Button variant="ghost" disabled={busy} onclick={openCamera}>
              <RefreshCw class="mr-2 h-4 w-4" aria-hidden="true" />
              {$t("dashboard.kyc.livePhoto.retry", "Try the camera again")}
            </Button>
          {/if}
        </div>
        <p class="text-sm text-muted-foreground">
          {#if canUseCamera}
            {$t(
              "dashboard.kyc.livePhoto.hint",
              "Take a photo of your face in good light, or upload one you already have. It is compared against your ID.",
            )}
          {:else}
            {$t(
              "dashboard.kyc.livePhoto.noCameraHint",
              "No camera is available in this browser, so upload a recent photo of your face instead. It is compared against your ID.",
            )}
          {/if}
        </p>
      </div>
    {/if}
  {/if}

  {#if errorMessage}
    <p class="mt-3 text-sm text-destructive" role="alert">{errorMessage}</p>
  {/if}
</div>
