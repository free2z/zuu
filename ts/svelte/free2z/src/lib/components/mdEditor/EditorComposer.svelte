<script lang="ts">
  import { tStore as t } from "$lib/i18n";
  import { Input } from "$lib/components/ui/input";
  import { contentDirectionAttribute } from "$lib/zpage-language.js";
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
    /**
     * `zPage.is_subscriber_only`. The body and the cover need OPPOSITE things
     * from it — see `$lib/components/media/mediaAccess.ts` — so only the
     * content field takes it. The cover is served to anonymous readers even
     * when the body is redacted, so its rule (public, always) does not depend
     * on this at all.
     */
    subscriberOnly?: boolean;
    /**
     * The content language of the variant OPEN IN THE EDITOR — `/edit`'s
     * `openLanguage`, not the creator's UI locale.
     *
     * It is here for one reason: the writing surface has to run the way the
     * language being written runs. A creator reviewing a purchased
     * Arabic translation was typing into a left-to-right textarea with the
     * caret jumping to the wrong end of every line, and the editor toolbar and
     * slash menu — which are product UI — must NOT follow it.
     *
     * `""`/undefined is a real state, not a missing value: a brand-new draft has
     * no language yet. It resolves to `dir="auto"`, which is the browser reading
     * the first strong character of what has actually been typed, live.
     */
    language?: string | null;
    validationErrors?: EditorValidationErrors;
    onTitleChange?: () => void;
    onDescriptionChange?: () => void;
    onCoverImageChange?: () => void;
    onContentChange?: () => void;
    /**
     * "The editor page itself is going away", forwarded from `/edit` and read
     * LIVE at the moment an answer arrives.
     *
     * It has to come from the page because this composer is not a reliable
     * proxy for it: `/edit` mounts it under
     * `{#if mode === "write" || mode === "split"}`, so switching to Preview
     * DESTROYS it while the creator is still very much on the page. An
     * in-flight inline upload must survive that — see `EditorContentField`'s
     * own `resolveUploadToken`, which already has a branch for resolving into
     * the bound prop when the textarea is unmounted.
     */
    isAbandoned?: () => boolean;
  }

  let {
    title = $bindable(),
    description = $bindable(),
    coverImage = $bindable(),
    coverImageId = $bindable(),
    content = $bindable(),
    showCover = $bindable(),
    showSubtitle = $bindable(),
    subscriberOnly = false,
    language = null,
    validationErrors = {},
    onTitleChange,
    onDescriptionChange,
    onCoverImageChange,
    onContentChange,
    isAbandoned,
  }: Props = $props();

  let contentFieldRef = $state<{ focusEditor: () => void } | null>(null);

  /** `rtl` / `ltr` when the language is known, `auto` while it is not. */
  const writingDirection = $derived(contentDirectionAttribute(language));
  /** `undefined`, not `""`, so no `lang` attribute is emitted for a draft. */
  const writingLanguage = $derived(language || undefined);
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
        direction={writingDirection}
        language={writingLanguage}
        onChange={onTitleChange}
        onSubmit={() => contentFieldRef?.focusEditor()}
      />
    </div>

    {#if showSubtitle}
      <!-- The subtitle is the article's text too, so it runs the article's
           way. `dir` on the input, not on the row: the label and the
           placeholder are product UI. -->
      <Input
        type="text"
        bind:value={description}
        dir={writingDirection}
        lang={writingLanguage}
        placeholder={$t(
          "editor.subtitle",
          "Article subtitle or description...",
        )}
        oninput={() => onDescriptionChange?.()}
      />
    {/if}

    <EditorContentField
      bind:this={contentFieldRef}
      bind:value={content}
      onChange={onContentChange}
      direction={writingDirection}
      language={writingLanguage}
      {subscriberOnly}
      {isAbandoned}
    />
  </div>
</div>
