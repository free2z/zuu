<script lang="ts">
  import { toast } from "svelte-sonner";
</script>

<button
  onclick={() =>
    toast.success("Legacy stream remains active", { duration: Infinity })}
>
  Show legacy stream notice
</button>
