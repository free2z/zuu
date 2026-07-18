<script lang="ts">
  import { tStore as t } from "$lib/i18n";
  import { Input } from "$lib/components/ui/input";
  import EditorCoverField from "./EditorCoverField.svelte";
  import EditorContentField from "./EditorContentField.svelte";
  import EditorTitleField from "./EditorTitleField.svelte";
  import type { EditorValidationErrors } from "./types";

  interface Props {
    title: string;
    description: string;
    coverImage: string;
    coverImageId: number | null;
    content: string;
    showCover: boolean;
    showSubtitle: boolean;
    validationErrors?: EditorValidationErrors;
    onTitleChange?: () => void;
    onDescriptionChange?: () => void;
    onCoverImageChange?: () => void;
    onContentChange?: () => void;
  }

  let {
    title = $bindable(),
    description = $bindable(),
    coverImage = $bindable(),
    coverImageId = $bindable(),
    content = $bindable(),
    showCover = $bindable(),
    showSubtitle = $bindable(),
    validationErrors = {},
    onTitleChange,
    onDescriptionChange,
    onCoverImageChange,
    onContentChange,
  }: Props = $props();

  let contentFieldRef = $state<{ focusEditor: () => void } | null>(null);
</script>

<div class="flex w-full flex-1 flex-col">
  <EditorCoverField
    {title}
    bind:coverImage
    bind:coverImageId
    bind:showCover
    {onCoverImageChange}
  />

  <div
    class="writing-area mx-auto flex w-full max-w-[900px] flex-1 flex-col gap-5 px-6 pb-8 md:px-12 md:pb-16"
  >
    <div
      class={showCover && coverImage
        ? "relative z-10 -mt-8 md:-mt-10"
        : "pt-2 md:pt-3"}
    >
      <EditorTitleField
        bind:value={title}
        error={validationErrors.title}
        onChange={onTitleChange}
        onSubmit={() => contentFieldRef?.focusEditor()}
      />
    </div>

    {#if showSubtitle}
      <Input
        type="text"
        bind:value={description}
        placeholder={$t("editor.subtitle", "Article subtitle or description...")}
        oninput={() => onDescriptionChange?.()}
      />
    {/if}

    <EditorContentField
      bind:this={contentFieldRef}
      bind:value={content}
      onChange={onContentChange}
    />
  </div>
</div>
