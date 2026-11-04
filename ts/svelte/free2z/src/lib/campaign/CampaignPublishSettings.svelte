<script lang="ts">
  import { Plus, Trash2 } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import * as Select from "$lib/components/ui/select";
  import { randomHex, type Campaign } from "./demo";

  let { campaign = $bindable() }: { campaign: Campaign } = $props();
  const visibilityLabels = {
    threshold: "Privada · prueba de metas",
    public: "Pública · auditoría de aportes",
    hidden: "Oculta · sin verificación",
  };
  function addPhase() {
    if (campaign.phases.length < 5)
      campaign.phases.push({
        id: randomHex(),
        title: "",
        target: campaign.goal,
        benefit: "",
      });
  }
</script>

<section
  class="min-w-0 space-y-4 border-t border-border/60 pt-5"
  aria-labelledby="campaign-heading"
>
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0 space-y-1">
      <Label
        id="campaign-heading"
        for="campaign-enabled"
        class="cursor-pointer text-sm font-semibold">Añadir una campaña</Label
      >
      <p class="text-xs text-muted-foreground">
        Tu publicación, con metas y etapas opcionales.
      </p>
    </div>
    <Switch
      id="campaign-enabled"
      bind:checked={campaign.enabled}
      aria-labelledby="campaign-heading"
    />
  </div>

  {#if campaign.enabled}
    <div class="grid min-w-0 gap-4 sm:grid-cols-2">
      <div class="min-w-0 space-y-2">
        <Label for="campaign-goal">Meta final (ZEC)</Label>
        <Input
          id="campaign-goal"
          bind:value={campaign.goal}
          maxlength={32}
          inputmode="decimal"
        />
      </div>
      <div class="min-w-0 space-y-2">
        <Label for="campaign-author">Nombre del creador local</Label>
        <Input
          id="campaign-author"
          bind:value={campaign.author}
          maxlength={80}
        />
      </div>
      <div class="min-w-0 space-y-2 sm:col-span-2">
        <Label for="campaign-visibility">Visibilidad de los aportes</Label>
        <Select.Root type="single" bind:value={campaign.visibility}>
          <Select.Trigger
            id="campaign-visibility"
            class="h-auto min-h-9 w-full min-w-0 text-left whitespace-normal"
          >
            <span class="min-w-0 wrap-anywhere whitespace-normal"
              >{visibilityLabels[campaign.visibility]}</span
            >
          </Select.Trigger>
          <Select.Content class="max-w-[calc(100vw-2rem)]">
            <Select.Item value="threshold" label={visibilityLabels.threshold}
              >{visibilityLabels.threshold}</Select.Item
            >
            <Select.Item value="public" label={visibilityLabels.public}
              >{visibilityLabels.public}</Select.Item
            >
            <Select.Item value="hidden" label={visibilityLabels.hidden}
              >{visibilityLabels.hidden}</Select.Item
            >
          </Select.Content>
        </Select.Root>
        <p class="text-xs leading-relaxed text-muted-foreground">
          {campaign.visibility === "threshold"
            ? "Pruebas criptográficas sobre aportes ficticios: verifica cada meta sin mostrar el total."
            : campaign.visibility === "public"
              ? "El lector puede ver los aportes ficticios acumulados y los gastos."
              : "El lector no verá el total ni una verificación de las metas."}
        </p>
      </div>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-sm font-semibold">Etapas · metas acumuladas</h3>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={campaign.phases.length >= 5}
        onclick={addPhase}><Plus class="size-4" /> Añadir etapa</Button
      >
    </div>
    {#each campaign.phases as phase, i (phase.id)}
      <fieldset
        class="min-w-0 space-y-3 rounded-md border border-border/60 p-3"
      >
        <legend class="px-1 text-xs text-muted-foreground">Etapa {i + 1}</legend
        >
        <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3">
          <div class="min-w-0 space-y-2">
            <Label for={`phase-${phase.id}-title`}>Nombre</Label>
            <Input
              id={`phase-${phase.id}-title`}
              bind:value={phase.title}
              maxlength={80}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Eliminar etapa ${i + 1}`}
            disabled={campaign.phases.length === 1}
            onclick={() =>
              (campaign.phases = campaign.phases.filter(
                (p) => p.id !== phase.id,
              ))}
            class="self-end"><Trash2 class="size-4" /></Button
          >
          <div class="col-span-2 min-w-0 space-y-2">
            <Label for={`phase-${phase.id}-target`}>Meta (ZEC)</Label>
            <Input
              id={`phase-${phase.id}-target`}
              bind:value={phase.target}
              maxlength={32}
              inputmode="decimal"
            />
          </div>
          <div class="col-span-2 min-w-0 space-y-2">
            <Label for={`phase-${phase.id}-benefit`}>Beneficio o entrega</Label>
            <Input
              id={`phase-${phase.id}-benefit`}
              bind:value={phase.benefit}
              maxlength={200}
            />
          </div>
        </div>
      </fieldset>
    {/each}
    <p class="text-xs leading-relaxed text-muted-foreground">
      Cada meta desbloquea una etapa. Las entregas las declara el creador por
      separado. Publicar de nuevo reinicia los aportes y entregas ficticios.
    </p>
  {/if}
</section>
