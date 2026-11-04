<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    mobileDrawer = false,
    showStatus,
    backing,
    status,
    tools,
    publish,
  }: {
    mobileDrawer?: boolean;
    showStatus: boolean;
    backing: Snippet;
    status: Snippet;
    tools: Snippet;
    publish: Snippet;
  } = $props();
</script>

<div
  class="mt-3 flex flex-wrap items-center justify-between gap-2"
  class:drawer-footer={mobileDrawer}
>
  <div class="footer-tools flex flex-wrap items-center gap-2">
    {@render tools()}
  </div>
  <div class="footer-backing flex items-center gap-2">
    {@render backing()}
  </div>
  <div
    class="footer-status ml-auto flex items-center gap-2"
    class:status-hidden={!showStatus}
  >
    {@render status()}
  </div>
  <div class="footer-publish flex">
    {@render publish()}
  </div>
</div>

<style>
  @media (width < 640px) {
    .drawer-footer {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: end;
      justify-content: stretch;
      gap: 4px;
    }

    .drawer-footer .footer-backing {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      grid-column: 1;
      grid-row: 2;
      width: 88px;
      gap: 2px;
    }

    .drawer-footer .footer-publish {
      display: flex;
      grid-column: 3;
      grid-row: 2;
    }

    .drawer-footer .footer-tools {
      display: flex;
      align-items: center;
      gap: 4px;
      grid-column: 1 / -1;
      grid-row: 1;
    }

    .drawer-footer .footer-status {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      grid-column: 1 / -1;
      grid-row: 3;
    }

    .drawer-footer .status-hidden {
      display: flex;
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }
</style>
