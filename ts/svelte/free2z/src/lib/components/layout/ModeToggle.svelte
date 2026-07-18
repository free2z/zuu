<script lang="ts">
  import { Moon, Sun, Laptop } from "@lucide/svelte";
  import { resetMode, setMode, userPrefersMode } from "mode-watcher";
  import { Button } from "$lib/components/ui/button";
  import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
  } from "$lib/components/ui/dropdown-menu";
  const themePreference = $derived.by(
    () => (userPrefersMode.current || "system") as "light" | "dark" | "system"
  );
</script>

<DropdownMenu >
  <DropdownMenuTrigger>
    <Button variant="outline" size="icon" class="rounded-full">
      {#if themePreference === "light"}
        <Sun class="h-[1.2rem] w-[1.2rem]" />
      {:else if themePreference === "dark"}
        <Moon class="h-[1.2rem] w-[1.2rem]" />
      {:else}
        <Laptop class="h-[1.2rem] w-[1.2rem]" />
      {/if}
      <span class="sr-only">Toggle theme</span>
    </Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    <DropdownMenuItem onclick={() => setMode("light")}>
      <Sun class="mr-2 h-4 w-4" />
      Light
    </DropdownMenuItem>
    <DropdownMenuItem onclick={() => setMode("dark")}>
      <Moon class="mr-2 h-4 w-4" />
      Dark
    </DropdownMenuItem>
    <DropdownMenuItem onclick={() => resetMode()}>
      <Laptop class="mr-2 h-4 w-4" />
      System
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
