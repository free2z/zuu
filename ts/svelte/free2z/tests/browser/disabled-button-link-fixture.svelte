<script lang="ts">
  import Button from "$lib/components/ui/button/button.svelte";
</script>

<main>
  <div
    role="button"
    tabindex="0"
    data-testid="disabled-link-ancestor"
    onclick={() => {
      document.body.dataset.disabledLinkAncestorActivations = String(
        Number(document.body.dataset.disabledLinkAncestorActivations ?? 0) + 1,
      );
    }}
    onkeydown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        document.body.dataset.disabledLinkAncestorActivations = String(
          Number(document.body.dataset.disabledLinkAncestorActivations ?? 0) +
            1,
        );
      }
    }}
  >
    <Button
      href="#disabled-link"
      disabled
      data-testid="button-disabled-link"
      onclick={() => {
        document.body.dataset.disabledLinkCallbacks = String(
          Number(document.body.dataset.disabledLinkCallbacks ?? 0) + 1,
        );
      }}
      onkeydown={() => {
        document.body.dataset.disabledLinkKeyCallbacks = String(
          Number(document.body.dataset.disabledLinkKeyCallbacks ?? 0) + 1,
        );
      }}
    >
      <span data-testid="disabled-link-descendant">Unavailable link</span>
    </Button>
  </div>
  <Button
    href="#enabled-link"
    data-testid="button-enabled-link"
    onclick={() => {
      document.body.dataset.enabledLinkCallbacks = String(
        Number(document.body.dataset.enabledLinkCallbacks ?? 0) + 1,
      );
    }}
  >
    Enabled link
  </Button>
</main>
