<script lang="ts">
  let { href }: { href: string } = $props();
</script>

<a
  {href}
  onclick={(event) => {
    event.preventDefault();
    event.currentTarget.setAttribute("data-portal-click-prevented", "true");
  }}
>
  Cancel delegated portal navigation
</a>
