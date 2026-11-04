<script lang="ts">
  /**
   * Rendered form of a `::qrcode[value]` markdown directive.
   *
   * The QR image alone is useless to anyone without a scanner, so the encoded
   * value is shown in full underneath (wrapping, monospace, never truncated)
   * and both the image and the text copy the exact value on click.
   */
  import QRCode from "qrcode";
  import { onDestroy } from "svelte";
  import { copyToClipboard } from "$lib/utils/clipboard";
  import CopyableValue from "./CopyableValue.svelte";
  import { tStore as t } from "$lib/i18n";

  interface Props {
    value: string;
  }

  let { value }: Props = $props();

  let dataUrl = $state<string | null>(null);
  let failed = $state(false);
  let copied = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const current = value;
    let cancelled = false;

    failed = false;
    dataUrl = null;

    QRCode.toDataURL(current, {
      margin: 1,
      width: 256,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((url: string) => {
        if (cancelled) return;
        dataUrl = url;
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("Error rendering QR code:", error);
        failed = true;
      });

    return () => {
      cancelled = true;
    };
  });

  function flagCopied(succeeded: boolean) {
    clearTimeout(resetTimer);
    copied = succeeded;
    resetTimer = setTimeout(() => (copied = false), 2000);
  }

  async function copyValue() {
    flagCopied(await copyToClipboard(value));
  }

  onDestroy(() => clearTimeout(resetTimer));
</script>

<div class="markdown-qrcode not-prose">
  <div class="markdown-qrcode-inner">
    {#if dataUrl}
      <button
        type="button"
        class="markdown-qrcode-button"
        onclick={copyValue}
        aria-label={$t(
          "common.copyQrValue",
          "Copy the value encoded in this QR code",
        )}
        title={$t(
          "common.copyQrValue",
          "Copy the value encoded in this QR code",
        )}
      >
        <img
          src={dataUrl}
          alt={$t("common.qrCodeAlt", "QR code")}
          loading="lazy"
          decoding="async"
        />
      </button>
    {:else if failed}
      <p class="markdown-qrcode-error">
        {$t("common.qrCodeFailed", "Failed to generate QR code")}
      </p>
    {:else}
      <div class="markdown-qrcode-placeholder" aria-hidden="true"></div>
    {/if}

    <CopyableValue
      {value}
      label={$t("common.copyQrValue", "Copy the value encoded in this QR code")}
      oncopied={flagCopied}
    />

    <p class="markdown-qrcode-hint" role="status" aria-live="polite">
      {#if copied}
        {$t("common.copied", "Copied!")}
      {:else}
        {$t("common.qrCodeHint", "Click the QR code or the text to copy it")}
      {/if}
    </p>
  </div>
</div>

<style>
  .markdown-qrcode {
    display: flex;
    justify-content: center;
    margin: 1.5rem 0;
  }

  .markdown-qrcode-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.65rem;
    width: 100%;
    max-width: 22rem;
    min-width: 0;
  }

  .markdown-qrcode-button {
    display: block;
    padding: 0.75rem;
    background: #ffffff;
    border: 1px solid var(--border);
    border-radius: 0.65rem;
    cursor: pointer;
    outline: none;
    transition: border-color 120ms ease;
  }

  .markdown-qrcode-button:hover {
    border-color: var(--primary);
  }

  .markdown-qrcode-button:focus-visible {
    border-color: var(--ring);
  }

  .markdown-qrcode-button img {
    display: block;
    width: 256px;
    max-width: 100%;
    height: auto;
  }

  .markdown-qrcode-placeholder {
    width: 256px;
    max-width: 100%;
    aspect-ratio: 1;
    border-radius: 0.65rem;
    background: color-mix(in srgb, var(--muted), transparent 40%);
  }

  .markdown-qrcode-error {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--destructive);
  }

  .markdown-qrcode-hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--muted-foreground);
    text-align: center;
  }
</style>
