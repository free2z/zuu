<script lang="ts">
  import { onMount } from "svelte";
  import {
    CheckCircle2,
    Eye,
    FileText,
    HeartHandshake,
    LockKeyhole,
    PenLine,
    ShieldCheck,
  } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import EditorTitleField from "$lib/components/mdEditor/EditorTitleField.svelte";
  import EditorPreview from "$lib/components/mdEditor/EditorPreview.svelte";
  import PublishSheet from "$lib/components/mdEditor/PublishSheet.svelte";
  import CampaignPublishSettings from "$lib/campaign/CampaignPublishSettings.svelte";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import TableOfContents from "$lib/components/TableOfContents.svelte";
  import { processMarkdown } from "$lib/utils/markdown";
  import {
    blankCampaign,
    contribute,
    deliver,
    emptySimulation,
    fromZatoshis,
    sampleCampaign,
    spend,
    STORAGE_KEY,
    validateCampaign,
    zatoshis,
    type Campaign,
    type Simulation,
  } from "$lib/campaign/demo";
  import {
    exportProofs,
    importProofs,
    provePhase,
    readerDocument,
    readerView,
    verifyPhase,
    type ReaderDocument,
  } from "$lib/campaign/proof";

  import {
    restoreCreator,
    restoreReader,
    saveCreator,
  } from "$lib/campaign/storage";

  let ready = $state(false);
  let draft = $state<Campaign | null>(null);
  let post = $state<ReaderDocument | null>(null);
  let simulation = $state<Simulation | null>(null);
  let screen = $state<"edit" | "read" | "lab">("edit");
  let readerOnly = $state(false);
  let preserveStoredCreator = $state(false);
  let mode = $state<"write" | "preview">("write");
  let publishSheetOpen = $state(false);
  let verified = $state<(boolean | null)[]>([]);
  let busy = $state(false);
  let status = $state("");
  let error = $state("");
  let notice = $state("");
  let amount = $state("2");
  let spendAmount = $state("1");
  let proofText = $state("");
  let operation = 0;
  let bodyField = $state<HTMLTextAreaElement>();
  let articleElement = $state<HTMLElement>();
  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const renderedDraft = $derived(draft ? processMarkdown(draft.content) : "");
  const renderedPost = $derived(
    post ? processMarkdown(post.campaign.content) : "",
  );
  const view = $derived(post ? readerView(post, verified) : null);
  const fundingLabel = $derived(
    view?.funding === "closed"
      ? "Campaña cerrada"
      : view?.funding === "paused"
        ? "Aportes en pausa"
        : view?.goalReached === true
          ? "Meta alcanzada · sigue recibiendo"
          : "Recibiendo aportes",
  );
  // Format the exact decimal string, not a Number: 64-bit zatoshi totals exceed
  // double precision, and the display must match the value that was proved.
  // Engines without exact string formatting fall back to Number coercion.
  const money = (value: string) =>
    new Intl.NumberFormat("es", { maximumFractionDigits: 8 }).format(
      value as Intl.StringNumericLiteral,
    );
  const fieldClass =
    "w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

  onMount(() => {
    readerOnly = new URL(location.href).searchParams.get("reader") === "1";
    if (!readerOnly) draft = blankCampaign();
    try {
      if (readerOnly) {
        const publicData = localStorage.getItem(`${STORAGE_KEY}-reader`);
        if (publicData) {
          post = restoreReader(publicData);
          screen = "read";
        }
      } else {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const value = restoreCreator(saved);
          draft = value.draft;
          post = value.post;
          simulation = value.simulation;
          if (post) screen = "read";
        }
      }
    } catch {
      preserveStoredCreator = !readerOnly;
      draft = readerOnly ? null : blankCampaign();
      post = null;
      simulation = null;
      notice =
        "No pudimos recuperar los datos locales. El registro original se conserva sin sobrescribirlo. Puedes empezar una publicación nueva o publicar este borrador para reemplazarlo.";
    }
    ready = true;
    if (post?.campaign.enabled && post.campaign.visibility === "threshold")
      void verifyPublished();
  });
  $effect(() => {
    if (!ready || readerOnly || !draft || preserveStoredCreator) return;
    try {
      saveCreator(localStorage, { version: 1, draft, post, simulation });
    } catch {
      notice =
        "El navegador no pudo guardar este borrador. La última copia guardada se conserva; revisa los límites de los campos y el almacenamiento disponible.";
    }
  });
  function resizeBody() {
    if (bodyField) {
      bodyField.style.height = "auto";
      bodyField.style.height = `${Math.max(280, bodyField.scrollHeight)}px`;
    }
  }
  function edit() {
    operation++;
    busy = false;
    status = "";
    error = "";
    screen = "edit";
  }
  function newPost() {
    edit();
    publishSheetOpen = false;
    preserveStoredCreator = false;
    draft = blankCampaign();
    post = null;
    simulation = null;
    verified = [];
    proofText = "";
    notice = "Nueva publicación local. No se enviará a Free2Z.";
  }
  function example() {
    edit();
    draft = sampleCampaign();
    notice =
      "Datos de ejemplo cargados. Puedes cambiarlos antes de publicar localmente.";
  }
  async function generate(
    document: ReaderDocument,
    state: Simulation,
    token: number,
  ) {
    try {
      const proofs = [];
      for (let i = 0; i < document.campaign.phases.length; i++) {
        status = `Generando prueba ${i + 1} de ${document.campaign.phases.length}…`;
        const proof = await provePhase(document.campaign, state, i);
        if (token !== operation) return;
        proofs.push(proof);
      }
      document.commitment = proofs[0].publicSignals[0];
      if (
        proofs.some((proof) => proof.publicSignals[0] !== document.commitment)
      )
        throw new Error(
          "Las pruebas no comparten el mismo compromiso de aportes.",
        );
      document.proofs = proofs;
      status = "Verificando las pruebas como lector…";
      const results: (boolean | null)[] = [];
      for (let i = 0; i < proofs.length; i++)
        results.push(await verifyPhase(document, i, proofs[i]));
      if (token !== operation) return;
      if (results.some((result) => result === null))
        throw new Error("La verificación criptográfica falló.");
      post = document;
      verified = results;
      proofText = exportProofs(document);
      status = "Pruebas criptográficas verificadas localmente.";
    } catch (cause) {
      if (token !== operation) return;
      error =
        cause instanceof Error
          ? cause.message
          : "No se pudo generar la prueba local.";
      status = "Sin verificación. Las metas permanecen desconocidas.";
    } finally {
      if (token === operation) busy = false;
    }
  }
  async function publish(): Promise<boolean> {
    if (!draft) return false;
    error =
      draft.description.trim().length > 250
        ? "La descripción puede tener como máximo 250 caracteres al publicar. Tu texto sigue guardado completo."
        : validateCampaign(draft);
    if (error) return false;
    publishSheetOpen = false;
    preserveStoredCreator = false;
    const token = ++operation;
    const campaign = clone(draft);
    const state = emptySimulation(campaign.phases.length);
    const document = readerDocument(campaign, state);
    post = document;
    simulation = state;
    verified = [];
    proofText = "";
    screen = "read";
    status = "";
    notice =
      "Publicado solo en este navegador. Los aportes y las entregas empiezan desde cero.";
    if (campaign.enabled && campaign.visibility === "threshold") {
      busy = true;
      await generate(document, state, token);
    }
    return true;
  }
  async function updateReceipts(action: "add" | "spend" | "goal") {
    if (!post || !simulation || busy) return;
    error = "";
    try {
      const next =
        action === "spend"
          ? spend(simulation, spendAmount)
          : contribute(
              simulation,
              action === "goal"
                ? fromZatoshis(
                    zatoshis(post.campaign.goal) > zatoshis(simulation.received)
                      ? zatoshis(post.campaign.goal) -
                          zatoshis(simulation.received)
                      : 0n,
                  )
                : amount,
            );
      if (next === simulation) {
        error =
          "La operación no cambió los datos: revisa el monto y si la campaña acepta aportes.";
        return;
      }
      simulation = next;
      if (action === "spend") {
        if (post.campaign.visibility === "public")
          post.publicReceipts = { received: next.received, spent: next.spent };
        notice =
          "Gasto ficticio registrado. Las metas siguen usando los aportes acumulados.";
        return;
      }
      const token = ++operation;
      const document = readerDocument(post.campaign, next);
      post = document;
      verified = [];
      proofText = "";
      status = "";
      notice = "Aporte ficticio registrado. No hubo transferencia de Zcash.";
      if (document.campaign.visibility === "threshold") {
        busy = true;
        await generate(document, clone(next), token);
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Monto inválido.";
    }
  }
  async function verifyPublished(imported = false) {
    if (!post || busy) return;
    const token = ++operation;
    busy = true;
    verified = [];
    error = "";
    status = "Verificando con el circuito y el contexto de esta publicación…";
    const expected = clone(post);
    try {
      const proofs = imported ? importProofs(proofText) : expected.proofs;
      const results: (boolean | null)[] = [];
      for (let i = 0; i < expected.campaign.phases.length; i++)
        results.push(
          await verifyPhase(
            expected,
            i,
            proofs.find(
              (proof) => proof.phaseId === expected.campaign.phases[i].id,
            ),
          ),
        );
      if (token !== operation) return;
      verified = results;
      status = results.every((r) => r !== null)
        ? "Pruebas criptográficas verificadas localmente."
        : "Prueba ausente, alterada o de otra versión: meta sin verificación.";
      if (results.some((r) => r === null))
        error = "El paquete no demuestra todas las etapas de esta publicación.";
    } catch (cause) {
      if (token === operation) {
        error = cause instanceof Error ? cause.message : "Paquete inválido.";
        status = "Paquete rechazado. Las metas quedan sin verificar.";
      }
    } finally {
      if (token === operation) busy = false;
    }
  }
  async function retryProofs() {
    if (!post || !simulation || busy) return;
    const token = ++operation;
    busy = true;
    verified = [];
    error = "";
    const document = readerDocument(post.campaign, simulation);
    post = document;
    await generate(document, clone(simulation), token);
  }
  function changeFunding(value: Simulation["funding"]) {
    if (simulation && post) {
      simulation.funding = value;
      post.funding = value;
    }
  }
  function markDelivered(index: number) {
    if (simulation && post) {
      simulation = deliver(simulation, post.campaign, index);
      post.delivered = [...simulation.delivered];
    }
  }
</script>

<svelte:head
  ><title>Publicación con campaña local · Free2Z</title><meta
    name="robots"
    content="noindex,nofollow"
  /></svelte:head
>

<main class="min-w-0 flex-1 bg-background text-foreground" lang="es">
  <div
    class="border-b border-border/60 bg-muted/20 px-4 py-2 text-center text-xs text-muted-foreground"
  >
    Prueba local · datos ficticios · sin pagos ni publicación en Free2Z
  </div>
  {#if notice}<p
      class="mx-auto max-w-[900px] px-6 pt-3 text-sm text-muted-foreground"
      role="status"
    >
      {notice}
    </p>{/if}
  {#if !ready}<p class="p-8 text-center text-muted-foreground">
      Abriendo borrador local…
    </p>
  {:else if readerOnly && !post}<p
      class="p-8 text-center text-muted-foreground"
    >
      Todavía no hay una publicación local. Crea una primero desde el editor de
      este navegador.
    </p>
  {:else if screen === "edit" && draft}
    <div>
      <header
        class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6"
      >
        <div class="flex items-center gap-2 text-sm font-medium">
          <FileText class="size-4 text-muted-foreground" /> Borrador local
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={mode === "write" ? "secondary" : "ghost"}
            size="sm"
            onclick={() => (mode = "write")}
            ><PenLine class="size-4" /> Escribir</Button
          >
          <Button
            type="button"
            variant={mode === "preview" ? "secondary" : "ghost"}
            size="sm"
            onclick={() => (mode = "preview")}
            ><Eye class="size-4" /> Vista previa</Button
          >
          <Button
            type="button"
            disabled={busy}
            onclick={() => {
              error = "";
              publishSheetOpen = true;
            }}
            class="h-auto min-h-9 min-w-0 whitespace-normal">Publicar</Button
          >
        </div>
      </header>
      {#if mode === "write"}
        <div
          class="writing-area mx-auto flex w-full max-w-[900px] flex-col gap-5 px-6 py-10 md:px-12 md:py-16"
        >
          <EditorTitleField
            bind:value={draft.title}
            maxlength={200}
            language="es"
            direction="ltr"
          />
          <label class="sr-only" for="post-description">Descripción breve</label
          >
          <input
            id="post-description"
            bind:value={draft.description}
            maxlength="500"
            placeholder="Añade una descripción breve (opcional)"
            class="w-full border-0 bg-transparent text-lg text-muted-foreground outline-none"
          />
          <label class="sr-only" for="post-content"
            >Contenido de la publicación</label
          >
          <textarea
            id="post-content"
            bind:this={bodyField}
            bind:value={draft.content}
            oninput={resizeBody}
            maxlength="30000"
            placeholder="Empieza a escribir tu publicación… Puedes usar Markdown."
            class="min-h-70 w-full resize-y border-0 bg-transparent text-lg leading-relaxed outline-none"
          ></textarea>
        </div>
      {:else}
        <EditorPreview
          title={draft.title}
          description={draft.description}
          content={draft.content}
          showCover={false}
          coverImage=""
          showSubtitle={true}
          renderedHtml={renderedDraft}
          mode="preview"
          language="es"
        />
      {/if}
    </div>
    <PublishSheet
      bind:open={publishSheetOpen}
      localOnly
      currentUser={{ username: "local" }}
      canSchedule={false}
      isPublished={false}
      isSaving={busy}
      bind:description={draft.description}
      canonicalUrl=""
      vanity=""
      tags={[]}
      bind:zcashAddress={draft.wallet}
      content={draft.content}
      isSubscriberOnly={false}
      publishAt=""
      resetKey={draft.id}
      localError={error}
      onPublish={publish}
      onPublishNow={publish}
      onSaveSettings={publish}
      onCancelSchedule={async () => false}
      onUnpublish={async () => false}
    >
      {#snippet campaignSettings()}
        {#if draft}<CampaignPublishSettings bind:campaign={draft} />{/if}
        <div class="flex flex-wrap gap-2 border-t border-border/60 pt-4">
          {#if preserveStoredCreator}
            <Button type="button" variant="outline" onclick={newPost}
              >Empezar publicación nueva</Button
            >
          {/if}
          <Button type="button" variant="outline" onclick={example}
            >Cargar datos ficticios</Button
          >
          {#if post}
            <Button
              type="button"
              variant="ghost"
              onclick={() => {
                publishSheetOpen = false;
                screen = "read";
              }}>Volver a la publicación local</Button
            >
          {/if}
        </div>
      {/snippet}
    </PublishSheet>
  {:else if post && view && screen === "read"}
    <div
      class="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 pt-4 sm:px-6 lg:px-8"
    >
      <span class="text-xs text-muted-foreground">Publicación local</span
      >{#if !readerOnly}<div class="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" onclick={edit}
            ><PenLine class="size-4" /> Editar</Button
          ><Button variant="ghost" size="sm" onclick={newPost}
            >Nueva publicación</Button
          >{#if post.campaign.enabled}<Button
              variant="ghost"
              size="sm"
              onclick={() => (screen = "lab")}>Laboratorio del creador</Button
            >{/if}<a
            href="?lang=es&reader=1"
            target="_blank"
            rel="noopener"
            class="inline-flex min-h-9 items-center px-2 text-xs font-medium text-primary"
            >Abrir lector independiente ↗</a
          >
        </div>{/if}
    </div>
    <header class="mx-auto w-full max-w-5xl px-4 pt-10 pb-8 sm:px-6 lg:px-8">
      <h1
        class="text-3xl leading-[1.15] font-bold tracking-tight text-balance wrap-anywhere sm:text-4xl"
      >
        {post.campaign.title}
      </h1>
      {#if post.campaign.description}<p
          class="mt-3 max-w-2xl text-base leading-relaxed text-pretty wrap-anywhere text-muted-foreground sm:text-lg"
        >
          {post.campaign.description}
        </p>{/if}
      <div class="mt-6 flex items-center gap-3">
        <div
          class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground"
        >
          {post.campaign.author.charAt(0).toUpperCase()}
        </div>
        <div class="min-w-0">
          <p class="text-sm font-semibold wrap-anywhere">
            {post.campaign.author}
          </p>
          <p class="text-xs text-muted-foreground">
            Guardada en este navegador · {Math.max(
              1,
              Math.ceil(post.campaign.content.split(/\s+/).length / 200),
            )} min de lectura
          </p>
        </div>
      </div>
    </header>
    <div class="mx-auto w-full max-w-5xl px-4 pb-16 sm:px-6 lg:px-8">
      <TableOfContents target={articleElement} />
      <article
        bind:this={articleElement}
        class="mx-auto prose prose-lg max-w-[65ch] wrap-anywhere prose-zinc dark:prose-invert prose-h1:text-3xl prose-h1:tracking-tight prose-a:text-primary prose-a:no-underline prose-a:hover:underline"
      >
        <MarkdownContent html={renderedPost} />
      </article>
      {#if post.campaign.enabled}
        <section
          id="campaign"
          class="mx-auto mt-10 max-w-[65ch] rounded-lg border border-border bg-card p-5 text-lg sm:p-6"
          aria-labelledby="campaign-heading"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2
                id="campaign-heading"
                class="flex items-center gap-2 text-lg font-semibold"
              >
                <HeartHandshake class="size-5 text-primary" /> Apoya esta publicación
              </h2>
              <p class="mt-1 text-sm text-muted-foreground">{fundingLabel}</p>
              {#if view.allDelivered}<p class="mt-1 text-xs text-primary">
                  Todas las entregas declaradas por el creador
                </p>{/if}
            </div>
            <span
              class="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
              >{post.campaign.visibility === "threshold"
                ? "Total privado"
                : post.campaign.visibility === "public"
                  ? "Auditoría pública local"
                  : "Financiación oculta"}</span
            >
          </div>
          {#if post.campaign.visibility === "public"}
            <p class="mt-5 text-2xl font-semibold tracking-tight wrap-anywhere">
              {money(view.received!)}
              <span class="text-sm font-normal text-muted-foreground"
                >de {money(post.campaign.goal)} ZEC ficticios</span
              >
            </p>
            <div
              class="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="Financiación ficticia acumulada"
              aria-valuenow={view.percentage}
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div
                class="h-full bg-primary"
                style:width={`${view.percentage}%`}
              ></div>
            </div>
            <p class="mt-2 text-xs text-muted-foreground">
              Aportes confirmados ficticios acumulados. Gastar no reduce lo ya
              alcanzado.
            </p>
          {:else if post.campaign.visibility === "threshold"}
            <p class="mt-5 flex items-start gap-2 text-sm">
              <ShieldCheck class="mt-0.5 size-4 shrink-0 text-primary" /><span
                >Meta final: {money(post.campaign.goal)} ZEC. {view.goalReached ===
                true
                  ? "Alcanzada según una prueba verificada."
                  : view.goalReached === false
                    ? "Todavía no alcanzada según una prueba verificada."
                    : "Sin prueba verificada todavía."}<span
                  class="mt-1 block text-xs text-muted-foreground"
                  >La prueba oculta el total ficticio. No demuestra fondos
                  reales de Zcash.</span
                ></span
              >
            </p>
          {:else}<p class="mt-5 flex gap-2 text-sm text-muted-foreground">
              <LockKeyhole class="size-4 shrink-0" /> El creador no muestra la financiación.
              Ninguna meta se presenta como verificada.
            </p>{/if}
          <ol class="mt-5 divide-y divide-border border-y border-border">
            {#each view.phases as phase, i (phase.id)}
              <li class="flex min-w-0 gap-3 py-4">
                <div
                  class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground"
                >
                  {#if phase.reached === true}<CheckCircle2
                      class="size-4 text-primary"
                    />{:else}{i + 1}{/if}
                </div>
                <div class="min-w-0 flex-1">
                  <div
                    class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
                  >
                    <h3 class="text-sm font-semibold wrap-anywhere">
                      {phase.title}
                    </h3>
                    <span class="text-xs text-muted-foreground"
                      >{money(phase.target)} ZEC</span
                    >
                  </div>
                  <p class="mt-1 text-sm wrap-anywhere text-muted-foreground">
                    {phase.benefit}
                  </p>
                  <p class="mt-2 text-xs">
                    <span
                      class:text-primary={phase.reached === true}
                      class:text-muted-foreground={phase.reached !== true}
                      >{phase.reached === true
                        ? "Financiación alcanzada"
                        : phase.reached === false
                          ? "Financiación pendiente"
                          : "Financiación sin verificar"}</span
                    ><span class="text-muted-foreground">
                      {" · "}{phase.delivered
                        ? "Entrega declarada por el creador"
                        : "Entrega pendiente"}</span
                    >
                  </p>
                </div>
              </li>
            {/each}
          </ol>
          {#if !readerOnly}<div class="mt-5 flex flex-wrap items-end gap-3">
              <label class="field min-w-0 flex-1"
                >Aporte ficticio (ZEC)<input
                  class={fieldClass}
                  bind:value={amount}
                  inputmode="decimal"
                  aria-label="Aporte ficticio en ZEC"
                /></label
              ><Button
                class="h-auto min-h-10 min-w-0 whitespace-normal"
                disabled={busy || view.funding !== "open"}
                onclick={() => updateReceipts("add")}>Probar un aporte</Button
              >
            </div>
            <p class="mt-2 text-xs text-muted-foreground">
              Solo añade datos al prototipo. No se envía Zcash ni se usa la
              billetera configurada.
            </p>{:else}<p class="mt-5 text-sm text-muted-foreground">
              Aportes reales no habilitados en esta prueba local.
            </p>{/if}
          {#if busy}<p
              role="status"
              aria-live="polite"
              class="mt-4 text-sm text-muted-foreground"
            >
              {status} La primera prueba puede tardar unos segundos.
            </p>{:else if status}<p
              role="status"
              class="mt-4 text-xs text-muted-foreground"
            >
              {status}
            </p>{/if}
          {#if error}<p
              role="alert"
              class="mt-3 text-sm wrap-anywhere text-destructive"
            >
              {error}
            </p>{/if}
          {#if post.campaign.visibility === "public"}<details
              class="mt-5 text-sm"
            >
              <summary class="cursor-pointer font-medium"
                >Auditar los datos ficticios</summary
              >
              <dl class="mt-3 grid grid-cols-2 gap-2 text-sm">
                <dt class="text-muted-foreground">Recibido acumulado</dt>
                <dd class="text-right wrap-anywhere">
                  {money(view.received!)} ZEC
                </dd>
                <dt class="text-muted-foreground">Gastado</dt>
                <dd class="text-right wrap-anywhere">
                  {money(view.spent!)} ZEC
                </dd>
                <dt class="text-muted-foreground">Saldo disponible</dt>
                <dd class="text-right wrap-anywhere">
                  {money(view.balance!)} ZEC
                </dd>
              </dl>
            </details>{/if}
          <details
            class="mt-5 border-t border-border pt-4 text-sm text-muted-foreground"
          >
            <summary class="cursor-pointer font-medium text-foreground"
              >Qué demuestra esta prueba local</summary
            >
            <p class="mt-3 leading-relaxed">
              Las pruebas PLONK demuestran si un total ficticio, comprometido
              con un secreto aleatorio, alcanza cada meta. Todas las etapas usan
              el mismo compromiso. El lector verifica el circuito, esta
              publicación, su configuración y la versión de los aportes. No se
              demuestra el control de una dirección ni la existencia de
              transacciones o fondos reales.
            </p>
            <p class="mt-3 leading-relaxed">
              Con fondos reales, la auditoría necesitaría una cuenta dedicada y
              una clave de visualización completa de solo lectura. Una dirección
              receptora por sí sola no revela un saldo protegido. Nunca se
              necesita una clave de gasto. La versión privada necesitaría además
              evidencia auténtica de los aportes de Zcash y su propio sistema de
              prueba.
            </p>
          </details>
        </section>
      {/if}
    </div>
  {:else if !readerOnly && post && view && simulation && screen === "lab" && post.campaign.enabled}
    <section class="mx-auto max-w-[900px] px-6 py-10 md:px-12">
      <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 class="text-xl font-semibold">Laboratorio local del creador</h1>
        <Button variant="outline" onclick={() => (screen = "read")}
          >Volver al lector</Button
        >
      </div>
      <p class="mt-3 text-xs leading-relaxed text-muted-foreground">
        Los datos privados de este laboratorio viven en este navegador del
        creador. El paquete de pruebas del lector excluye el total y el secreto.
        Es una maqueta local, sin cuentas ni permisos reales.
      </p>
      <p class="mt-4 text-sm wrap-anywhere">
        Total ficticio del creador: <strong
          >{money(simulation.received)} ZEC</strong
        >
        · gastado: {money(simulation.spent)} ZEC
      </p>
      <div class="mt-4 flex flex-wrap items-end gap-2">
        <label class="field min-w-0 flex-1"
          >Aporte ficticio (ZEC)<input
            class={fieldClass}
            bind:value={amount}
            inputmode="decimal"
          /></label
        ><Button
          disabled={busy || view.funding !== "open"}
          onclick={() => updateReceipts("add")}>Añadir aporte ficticio</Button
        >
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy ||
            view.funding !== "open" ||
            zatoshis(simulation.received) >= zatoshis(post.campaign.goal)}
          onclick={() => updateReceipts("goal")}
          >Alcanzar la meta ficticia</Button
        ><Button
          variant="outline"
          size="sm"
          disabled={busy}
          onclick={() =>
            changeFunding(view?.funding === "open" ? "paused" : "open")}
          >{view.funding === "open"
            ? "Pausar aportes"
            : "Reabrir aportes"}</Button
        ><Button
          variant="outline"
          size="sm"
          disabled={busy || view.funding === "closed"}
          onclick={() => changeFunding("closed")}>Cerrar campaña</Button
        >
      </div>
      <div class="mt-4 flex flex-wrap items-end gap-2">
        <label class="field min-w-0 flex-1"
          >Gasto ficticio (ZEC)<input
            class={fieldClass}
            bind:value={spendAmount}
            inputmode="decimal"
          /></label
        ><Button
          variant="outline"
          disabled={busy}
          onclick={() => updateReceipts("spend")}>Registrar gasto</Button
        >
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        {#each post.campaign.phases as phase, i (phase.id)}<Button
            class="h-auto min-h-9 min-w-0 wrap-anywhere whitespace-normal"
            variant="outline"
            size="sm"
            disabled={busy ||
              simulation.delivered[i] ||
              zatoshis(simulation.received) < zatoshis(phase.target)}
            onclick={() => markDelivered(i)}>Declarar entrega {i + 1}</Button
          >{/each}
      </div>
      {#if post.campaign.visibility === "threshold"}<div
          class="mt-6 border-t border-border pt-4"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h3 class="font-semibold">Verificador independiente del lector</h3>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onclick={retryProofs}>Regenerar pruebas</Button
            >
          </div>
          <p class="mt-2 text-xs leading-relaxed text-muted-foreground">
            Copia las pruebas, altera un campo y vuelve a verificar. Solo se
            aceptan las que corresponden a esta publicación y al compromiso
            actual. El paquete no puede reemplazar su contexto ni la clave del
            verificador.
          </p>
          <label class="field mt-3"
            >Paquete público de pruebas<textarea
              class={`${fieldClass} font-mono text-xs`}
              rows="7"
              bind:value={proofText}
              maxlength="60000"
              placeholder="Aquí aparecerán las pruebas, sin el monto privado ni su secreto."
            ></textarea></label
          >
          <div class="mt-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy || !post.commitment}
              onclick={() => post && (proofText = exportProofs(post))}
              >Copiar paquete al campo</Button
            ><Button
              disabled={busy || !post.commitment}
              onclick={() => verifyPublished(true)}>Verificar paquete</Button
            ><Button
              variant="ghost"
              disabled={busy || !post.commitment}
              onclick={() => verifyPublished()}>Verificar originales</Button
            >
          </div>
        </div>{/if}
      <p class="mt-4 text-xs wrap-anywhere text-muted-foreground">
        Billetera configurada: {post.campaign.wallet || "Sin dirección"} · no se usa
        para realizar pagos.
      </p>
      {#if status}<p class="mt-4 text-sm text-muted-foreground" role="status">
          {status}
        </p>{/if}{#if error}<p
          class="mt-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>{/if}
    </section>
  {/if}
</main>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  .writing-area textarea,
  .writing-area input {
    border-radius: 0;
  }
  summary {
    min-height: 1.5rem;
  }
</style>
