import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowUp,
  Coins,
  Cpu,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/common/Markdown";
import { ai } from "@/lib/api/free2z";
import { ApiError } from "@/lib/api/http";
import type { AIModel, Personality } from "@/lib/api/types";
import { formatTuzis, initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/session";
import { ModelPicker } from "./ModelPicker";
import { PersonalityManager } from "./PersonalityManager";
import { PersonalityPicker } from "./PersonalityPicker";
import { pricePerMessage, providerMeta } from "./providers";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Assistant placeholder awaiting a response. */
  pending?: boolean;
  /** Assistant reply failed (non-abort error). */
  error?: boolean;
  /** Generation was stopped by the user. */
  aborted?: boolean;
  modelName?: string;
  personalityName?: string;
  tuzisCharged?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * The real conversation endpoint (see `ai.conversations` below) enforces a
 * 100-2Z minimum balance before it will start a turn — a reserve requirement
 * the old flat `/api/openai/prompt` endpoint didn't have. Mirrored here so
 * the composer disables itself before the backend would reject the call.
 */
const MIN_TUZIS_TO_CHAT = 100;

const EXAMPLE_PROMPTS = [
  "Explain zero-knowledge proofs like I'm five.",
  "Draft a warm reply politely declining a meeting.",
  "Summarize the core ideas behind the Zcash protocol.",
  "Write a haiku about financial privacy.",
];

let idCounter = 0;
const nextId = () => `m-${Date.now()}-${idCounter++}`;

/**
 * Races a promise against an AbortController so cancellation works even in
 * mock mode (whose fixtures ignore the signal they're handed).
 */
function withAbort<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    run()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === "AbortError"
    : (err as { name?: string })?.name === "AbortError";
}

/** Key identifying which (model, personality) pair a live conversation belongs to. */
function conversationKey(model: AIModel, personality: Personality | null): string {
  return `${model.id}:${personality?.id ?? "default"}`;
}

export default function AiFeature() {
  const user = useSession((s) => s.user);
  const tuzis = useSession((s) => s.tuzis);
  const adjustTuzis = useSession((s) => s.adjustTuzis);
  const refreshSession = useSession((s) => s.refresh);

  const [models, setModels] = useState<AIModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [modelsError, setModelsError] = useState(false);
  const [selected, setSelected] = useState<AIModel | null>(null);

  const [personalities, setPersonalities] = useState<Personality[]>([]);
  const [personality, setPersonality] = useState<Personality | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sessionCost, setSessionCost] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  // Which live backend conversation (if any) the next turn continues — pinned
  // to a single (model, personality) pair for its lifetime.
  const conversationRef = useRef<{ id: string; key: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const lowBalance = tuzis < MIN_TUZIS_TO_CHAT;
  const canSend =
    !!selected && !isSending && !lowBalance && input.trim().length > 0;

  // Load models + personalities once; default to the highest-`order` GA
  // model (the API already returns them sorted by `-order`, so this is the
  // first GA entry — the one most likely to actually work).
  useEffect(() => {
    let active = true;
    ai
      .models()
      .then((list) => {
        if (!active) return;
        const sorted = [...list].sort((a, b) => b.order - a.order);
        setModels(sorted);
        setSelected(sorted.find((m) => m.is_ga) ?? sorted[0] ?? null);
      })
      .catch(() => active && setModelsError(true))
      .finally(() => active && setLoadingModels(false));
    ai.personalities
      .list()
      .then((list) => active && setPersonalities(list))
      .catch(() => {
        /* personalities are optional — chat still works with the default persona */
      });
    return () => {
      active = false;
    };
  }, []);

  // Keep the latest message in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  // Abort any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const startNewChat = useCallback(() => {
    conversationRef.current = null;
    setMessages([]);
    setSessionCost(0);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || !selected || isSending || tuzis < MIN_TUZIS_TO_CHAT) return;

      const model = selected;
      const pers = personality;
      const placeholderId = nextId();
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", content: prompt },
        {
          id: placeholderId,
          role: "assistant",
          content: "",
          pending: true,
          modelName: model.display_name,
          personalityName: pers?.display_name,
        },
      ]);
      setInput("");
      setIsSending(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // A conversation is pinned to one (model, personality) pair for its
        // lifetime — start a new one whenever that pair changes.
        const key = conversationKey(model, pers);
        if (!conversationRef.current || conversationRef.current.key !== key) {
          const convo = await ai.conversations.create({
            displayName: prompt.slice(0, 60) || "New chat",
            model,
            personality: pers,
          });
          conversationRef.current = { id: convo.id, key };
        }

        const beforeTuzis = useSession.getState().tuzis;
        const res = await withAbort(
          () =>
            ai.conversations.sendMessage({
              conversationId: conversationRef.current!.id,
              userInput: prompt,
              model,
              personality: pers,
              signal: controller.signal,
            }),
          controller.signal,
        );

        let tuzisCharged = res.tuzis_charged;
        if (tuzisCharged != null) {
          // Mock mode (and any endpoint that returns it directly): apply
          // optimistically.
          adjustTuzis(-tuzisCharged);
        } else {
          // The real conversation endpoint doesn't return a per-message cost
          // breakdown, so sync the authoritative balance from the account
          // and derive the exact charge from the delta.
          await refreshSession();
          tuzisCharged = Math.max(0, beforeTuzis - useSession.getState().tuzis);
        }

        setMessages((prev) =>
          prev.map((m) =>
            m.id === placeholderId
              ? {
                  ...m,
                  pending: false,
                  content: res.response,
                  modelName: res.model ?? model.display_name,
                  personalityName: res.personality ?? pers?.display_name,
                  tuzisCharged,
                  inputTokens: res.input_tokens,
                  outputTokens: res.output_tokens,
                }
              : m,
          ),
        );
        if (tuzisCharged) {
          setSessionCost((c) => c + (tuzisCharged ?? 0));
        }
      } catch (err) {
        const aborted = isAbortError(err);
        const genericMessage =
          "Sorry — the model could not be reached. Please try again.";
        const detail =
          err instanceof ApiError &&
          err.body &&
          typeof (err.body as { detail?: unknown }).detail === "string"
            ? (err.body as { detail: string }).detail
            : undefined;
        const errorMessage = detail ?? genericMessage;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === placeholderId
              ? {
                  ...m,
                  pending: false,
                  aborted,
                  error: !aborted,
                  content: aborted ? "_Generation stopped._" : errorMessage,
                }
              : m,
          ),
        );
        if (!aborted) toast.error(detail ?? "The model could not be reached.");
      } finally {
        abortRef.current = null;
        setIsSending(false);
      }
    },
    [selected, personality, isSending, tuzis, adjustTuzis, refreshSession],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const prefill = (text: string) => {
    setInput(text);
    inputRef.current?.focus();
  };

  const localModel = models.find((m) => m.provider === "local");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Header rail ─────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-border/60 bg-background/85 px-4 py-3 backdrop-blur md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
              <Sparkles className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold leading-tight">AI Studio</h1>
              <p className="truncate text-xs text-muted-foreground">
                Anonymous, multi-provider — metered in 2Zs
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {loadingModels ? (
              <Skeleton className="h-10 w-52" />
            ) : modelsError ? (
              <span className="text-sm text-destructive">
                Couldn&rsquo;t load models
              </span>
            ) : (
              <ModelPicker
                models={models}
                value={selected}
                onChange={setSelected}
                disabled={isSending}
              />
            )}
            <PersonalityPicker
              personalities={personalities}
              value={personality}
              onChange={setPersonality}
              onManage={() => setManagerOpen(true)}
              ownUsername={user?.username}
              disabled={isSending}
            />
            {messages.length > 0 ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 shrink-0 text-muted-foreground"
                aria-label="Start a new chat"
                onClick={startNewChat}
                disabled={isSending}
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
            ) : null}
          </div>

          {/* Cost meters */}
          <div className="flex items-center gap-2 sm:ml-auto">
            <Meter
              icon={Coins}
              label="This session"
              value={formatTuzis(sessionCost)}
              accent="text-primary"
            />
            <Meter
              icon={Wallet}
              label="Balance"
              value={formatTuzis(tuzis)}
              accent={lowBalance ? "text-destructive" : "text-foreground"}
            />
          </div>
        </div>

        {lowBalance ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <span className="text-foreground">
              You need at least {formatTuzis(MIN_TUZIS_TO_CHAT)} to start
              chatting. Top up to continue.
            </span>
            <Button asChild size="sm" className="ml-auto">
              <Link to="/buy">Buy 2Zs</Link>
            </Button>
          </div>
        ) : null}
      </div>

      {/* ── Thread ──────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
        {messages.length === 0 ? (
          <EmptyHero
            selected={selected}
            localModel={localModel}
            onSelectLocal={localModel ? () => setSelected(localModel) : undefined}
            onPrefill={prefill}
          />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            {messages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                userLabel={user?.display_name ?? user?.username ?? "You"}
              />
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* ── Composer ────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-border/60 bg-background/85 px-4 pb-3 pt-3 backdrop-blur md:px-8">
        <div className="mx-auto max-w-3xl">
          <div className="relative rounded-xl border border-border bg-card/60 shadow-sm focus-within:border-primary/60 focus-within:shadow-glow">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={lowBalance}
              rows={1}
              aria-label="Message"
              placeholder={
                lowBalance
                  ? "Buy 2Zs to start chatting…"
                  : `Message ${selected?.display_name ?? "the model"}…`
              }
              className="max-h-48 min-h-[52px] resize-none border-0 bg-transparent py-3.5 pl-4 pr-14 text-[15px] focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <div className="absolute bottom-2.5 right-2.5">
              {isSending ? (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={() => abortRef.current?.abort()}
                  aria-label="Stop generating"
                  className="h-9 w-9"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </Button>
              ) : (
                <Button
                  type="button"
                  size="icon"
                  onClick={() => void send(input)}
                  disabled={!canSend}
                  aria-label="Send message"
                  className="h-9 w-9"
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
          <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-muted-foreground">
            <span className="hidden sm:inline">
              Enter to send · Shift+Enter for a new line
            </span>
            {selected ? (
              <span className="tabular-nums">
                {selected.display_name}
                {personality ? ` · ${personality.display_name}` : ""} · ~
                {pricePerMessage(selected)}
              </span>
            ) : (
              <span />
            )}
          </div>
        </div>
      </div>

      <PersonalityManager
        open={managerOpen}
        onOpenChange={setManagerOpen}
        personalities={personalities}
        ownUsername={user?.username}
        isAuthed={!!user}
        onChanged={(change) => {
          if (change.created) {
            setPersonalities((prev) => [...prev, change.created!]);
            setPersonality(change.created);
          } else if (change.updated) {
            setPersonalities((prev) =>
              prev.map((p) => (p.id === change.updated!.id ? change.updated! : p)),
            );
            setPersonality((cur) =>
              cur?.id === change.updated!.id ? change.updated! : cur,
            );
          } else if (change.deletedId) {
            setPersonalities((prev) =>
              prev.filter((p) => p.id !== change.deletedId),
            );
            setPersonality((cur) => (cur?.id === change.deletedId ? null : cur));
          }
        }}
      />
    </div>
  );
}

function Meter({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof Coins;
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/50 px-3 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" aria-hidden />
        {label}
      </div>
      <div className={cn("text-sm font-semibold tabular-nums", accent)}>
        {value}
      </div>
    </div>
  );
}

function MessageRow({
  message,
  userLabel,
}: {
  message: ChatMessage;
  userLabel: string;
}) {
  if (message.role === "user") {
    return (
      <div className="flex animate-slide-up justify-end gap-3">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm border border-primary/30 bg-primary/15 px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
          <span className="whitespace-pre-wrap break-words">{message.content}</span>
        </div>
        <Avatar className="h-8 w-8 border border-border">
          <AvatarFallback className="bg-primary/20 text-xs text-primary">
            {initials(userLabel)}
          </AvatarFallback>
        </Avatar>
      </div>
    );
  }

  return (
    <div className="flex animate-slide-up justify-start gap-3">
      <AssistantGlyph />
      <div className="min-w-0 max-w-[85%]">
        <div className="rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3">
          {message.pending ? (
            <ThinkingDots />
          ) : (
            <Markdown className="space-y-3 text-[15px]">{message.content}</Markdown>
          )}
        </div>
        {!message.pending && !message.aborted && !message.error ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-[11px] tabular-nums text-muted-foreground">
            {message.modelName ? (
              <span className="text-foreground/70">{message.modelName}</span>
            ) : null}
            {message.personalityName ? (
              <>
                <span aria-hidden>·</span>
                <span className="text-foreground/70">
                  as {message.personalityName}
                </span>
              </>
            ) : null}
            {message.tuzisCharged != null ? (
              <>
                <span aria-hidden>·</span>
                <span className="text-primary">
                  {formatTuzis(message.tuzisCharged)} charged
                </span>
              </>
            ) : null}
            {message.inputTokens != null && message.outputTokens != null ? (
              <>
                <span aria-hidden>·</span>
                <span>
                  {message.inputTokens.toLocaleString()} in /{" "}
                  {message.outputTokens.toLocaleString()} out
                </span>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssistantGlyph() {
  return (
    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border bg-secondary">
      <Sparkles className="h-4 w-4 text-primary" aria-hidden />
    </div>
  );
}

function ThinkingDots() {
  return (
    <div
      className="flex items-center gap-1 py-1"
      role="status"
      aria-label="Assistant is thinking"
    >
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-2 w-2 animate-bounce rounded-full bg-primary/70"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}

function EmptyHero({
  selected,
  localModel,
  onSelectLocal,
  onPrefill,
}: {
  selected: AIModel | null;
  localModel?: AIModel;
  onSelectLocal?: () => void;
  onPrefill: (text: string) => void;
}) {
  const isLocalSelected = !!selected && selected.provider === "local";
  const LocalIcon = localModel ? providerMeta(localModel).icon : Cpu;

  return (
    <div className="mx-auto flex max-w-2xl animate-slide-up flex-col items-center gap-6 py-6 text-center">
      <div className="zuuli-hero-glow grid h-16 w-16 place-items-center rounded-2xl border border-border bg-card">
        <Sparkles className="h-7 w-7 text-primary" aria-hidden />
      </div>

      <div className="space-y-2">
        <h2 className="text-2xl font-bold tracking-tight">
          Pick a model. Pay only for what you use.
        </h2>
        <p className="mx-auto max-w-lg text-sm leading-relaxed text-muted-foreground">
          Every token is billed at cost plus a thin margin, rounded up to whole
          2Zs. The provider never sees you — only free2z relays the prompt.
        </p>
      </div>

      {/* Local / open-source anonymity callout */}
      {localModel ? (
        <div className="flex w-full items-center gap-3 rounded-xl border border-primary/30 bg-primary/[0.06] px-4 py-3 text-left">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
            <LocalIcon className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{localModel.display_name}</span>
              <Badge variant="default" className="gap-1 px-1.5 py-0 text-[10px]">
                <ShieldCheck className="h-3 w-3" aria-hidden />
                private
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Open-source, run on 2Z hardware — nothing leaves our walls. From{" "}
              <span className="tabular-nums">{pricePerMessage(localModel)}</span>.
            </p>
          </div>
          {onSelectLocal ? (
            <Button
              size="sm"
              variant={isLocalSelected ? "secondary" : "default"}
              onClick={onSelectLocal}
              disabled={isLocalSelected}
              className="shrink-0"
            >
              {isLocalSelected ? "Selected" : "Use it"}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap justify-center gap-2">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onPrefill(prompt)}
            className="rounded-full border border-border bg-card/60 px-3.5 py-1.5 text-xs text-foreground/80 transition-colors hover:border-primary/50 hover:bg-secondary hover:text-foreground"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}
