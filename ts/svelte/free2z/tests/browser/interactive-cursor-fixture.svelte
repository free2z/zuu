<script lang="ts">
  import Button from "$lib/components/ui/button/button.svelte";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import * as Command from "$lib/components/ui/command/index.js";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import * as Select from "$lib/components/ui/select/index.js";

  let checkboxChecked = $state(false);
  let radioValue = $state("first");
  let selectOpen = $state(false);
  let selectValue = $state("item-1");
</script>

<main>
  <Button data-testid="button-enabled">Enabled button</Button>
  <Button data-testid="button-disabled" disabled>Disabled button</Button>
  <!-- A label that wraps the shared Checkbox/Switch (a role=checkbox|switch
       button) activates it, so it gets the pointer; disabled ones do not. -->
  <label data-testid="label-wraps-checkbox-enabled">
    <Checkbox /> Enabled wrapped checkbox
  </label>
  <label data-testid="label-wraps-checkbox-disabled">
    <Checkbox disabled /> Disabled wrapped checkbox
  </label>
  <label data-testid="label-wraps-switch-enabled">
    <Switch /> Enabled wrapped switch
  </label>
  <label data-testid="label-wraps-switch-disabled">
    <Switch disabled /> Disabled wrapped switch
  </label>

  <Command.Root shouldFilter={false}>
    <Command.List>
      <Command.Item data-testid="command-item-enabled" value="enabled">
        Enabled command item
      </Command.Item>
      <Command.Item
        data-testid="command-item-disabled"
        value="disabled"
        disabled
      >
        Disabled command item
      </Command.Item>
      <Command.LinkItem
        data-testid="command-link-item-enabled"
        value="link-enabled"
        href="/cursor-link"
      >
        Enabled command link item
      </Command.LinkItem>
      <Command.LinkItem
        data-testid="command-link-item-disabled"
        value="link-disabled"
        href="/cursor-disabled-link"
        disabled
      >
        Disabled command link item
      </Command.LinkItem>
    </Command.List>
  </Command.Root>

  <DropdownMenu.Root>
    <DropdownMenu.Trigger data-testid="dropdown-trigger">
      Open dropdown
    </DropdownMenu.Trigger>
    <DropdownMenu.Content>
      <DropdownMenu.Item data-testid="dropdown-item-enabled">
        Enabled dropdown item
      </DropdownMenu.Item>
      <DropdownMenu.Item data-testid="dropdown-item-disabled" disabled>
        Disabled dropdown item
      </DropdownMenu.Item>
      <DropdownMenu.CheckboxItem
        data-testid="dropdown-checkbox-enabled"
        bind:checked={checkboxChecked}
      >
        Enabled checkbox item
      </DropdownMenu.CheckboxItem>
      <DropdownMenu.CheckboxItem
        data-testid="dropdown-checkbox-disabled"
        bind:checked={checkboxChecked}
        disabled
      >
        Disabled checkbox item
      </DropdownMenu.CheckboxItem>
      <DropdownMenu.RadioGroup bind:value={radioValue}>
        <DropdownMenu.RadioItem
          data-testid="dropdown-radio-enabled"
          value="first"
        >
          Enabled radio item
        </DropdownMenu.RadioItem>
        <DropdownMenu.RadioItem
          data-testid="dropdown-radio-disabled"
          value="second"
          disabled
        >
          Disabled radio item
        </DropdownMenu.RadioItem>
      </DropdownMenu.RadioGroup>
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger data-testid="dropdown-sub-trigger-enabled">
          Enabled sub-trigger
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent>
          <DropdownMenu.Item>Submenu item</DropdownMenu.Item>
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger
          data-testid="dropdown-sub-trigger-disabled"
          disabled
        >
          Disabled sub-trigger
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent>
          <DropdownMenu.Item>Disabled submenu item</DropdownMenu.Item>
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  <Select.Root type="single" bind:open={selectOpen} bind:value={selectValue}>
    <Select.Trigger data-testid="select-trigger">
      <Select.Value />
    </Select.Trigger>
    <Select.Content class="h-48">
      {#each Array.from({ length: 20 }, (_, index) => index + 1) as item}
        <Select.Item
          data-testid={`select-item-${item}`}
          value={`item-${item}`}
          disabled={item === 20}
        >
          Select item {item}
        </Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
</main>
