import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useBlocker, useLocation, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  Check,
  ChevronDown,
  CloudUpload,
  FileClock,
  Loader2,
  Lock,
  PenLine,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/common/EmptyState";
import { Markdown } from "@/components/common/Markdown";
import { PageHeader } from "@/components/common/PageHeader";
import { ArticlePublishedHydrationError, articles } from "@/lib/api/free2z";
import { useSession } from "@/store/session";
import { cn } from "@/lib/utils";
import {
  confirmUnsavedTransition,
  registerUnsavedTransitionGuard,
} from "@/lib/unsaved-transition";
import { articleHref, readingMinutes, wordCount } from "../lib";
import {
  articleDraftLabel,
  discardArticleDraft,
  hasArticleDraftConflict,
  isArticleDraftId,
  isArticleDraftStorageKey,
  listArticleDrafts,
  loadArticleDraft,
  newArticleDraftId,
  saveArticleDraft,
  type ArticleDraftFields,
  type StoredArticleDraft,
} from "../article-drafts";
import { ArticleTagInput } from "../components/ArticleTagInput";

const CATEGORIES = ["Zcash", "Technology", "Community", "Education"];

const PLACEHOLDER = `# Your headline

Write in **Markdown**. Use headings, _emphasis_, lists, and > quotes.

- Point one
- Point two

Share what you're building on Zcash.`;

const EMPTY_DRAFT: ArticleDraftFields = {
  title: "",
  subtitle: "",
  category: "",
  tags: [],
  content: "",
};
const AUTOSAVE_DELAY_MS = 750;
const AUTOSAVE_MAX_WAIT_MS = 5_000;

type LocalSaveStatus = "idle" | "pending" | "saved" | "error" | "conflict";

export function Author() {
  const user = useSession((s) => s.user);

  if (!user) {
    return (
      <div className="animate-slide-up">
        <PageHeader title="Write an article" />
        <EmptyState
          icon={Lock}
          title="Log in to publish"
          description="Authoring is free. Choose your login method to continue."
          action={
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <Button asChild>
                <Link to="/login">Log in</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/articles">Back to articles</Link>
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  return <AuthenticatedAuthor key={user.username} username={user.username} />;
}

function AuthenticatedAuthor({ username }: { username: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const requestedId = new URLSearchParams(location.search).get("draft");
  const initialRef = useRef<{
    id: string;
    draft: StoredArticleDraft | null;
    drafts: StoredArticleDraft[];
  } | null>(null);
  if (!initialRef.current) {
    const drafts = listArticleDrafts(username);
    const exact = isArticleDraftId(requestedId)
      ? loadArticleDraft(username, requestedId)
      : null;
    const draft = exact ?? (!requestedId ? drafts[0] ?? null : null);
    initialRef.current = {
      id:
        (isArticleDraftId(requestedId) ? requestedId : null) ??
        draft?.id ??
        newArticleDraftId(),
      draft,
      drafts,
    };
  }
  const initial = initialRef.current;
  const draftId = initial.id;
  const [fields, setFields] = useState<ArticleDraftFields>(() =>
    initial.draft
      ? {
          title: initial.draft.title,
          subtitle: initial.draft.subtitle,
          category: initial.draft.category,
          tags: initial.draft.tags,
          content: initial.draft.content,
        }
      : { ...EMPTY_DRAFT },
  );
  const [drafts, setDrafts] = useState(initial.drafts);
  const [saveStatus, setSaveStatus] = useState<LocalSaveStatus>(
    initial.draft ? "saved" : "idle",
  );
  const [savedAt, setSavedAt] = useState<number | null>(
    initial.draft?.updatedAt ?? null,
  );
  const [publishing, setPublishing] = useState(false);
  const fieldsRef = useRef(fields);
  const revisionRef = useRef(initial.draft?.revision ?? 0);
  const dirtyRef = useRef(false);
  const firstDirtyAtRef = useRef<number | null>(null);
  const saveFailureRef = useRef<"error" | "conflict" | null>(null);
  const conflictRescueRef = useRef<string | null>(null);
  const publishingRef = useRef(false);
  const mountedRef = useRef(true);
  const persistRef = useRef<() => boolean>(() => true);

  const { title, subtitle, category, tags, content } = fields;
  const words = useMemo(() => wordCount(content), [content]);
  const canPublish =
    title.trim().length > 0 &&
    content.trim().length > 0 &&
    saveStatus !== "conflict";

  useEffect(() => {
    if (requestedId === draftId) return;
    navigate(`/articles/new?draft=${encodeURIComponent(draftId)}`, {
      replace: true,
    });
  }, [draftId, navigate, requestedId]);

  const persist = useCallback(() => {
    if (!dirtyRef.current) return true;
    try {
      const result = saveArticleDraft(
        username,
        draftId,
        fieldsRef.current,
        revisionRef.current,
      );
      if (result.status === "conflict") {
        saveFailureRef.current = "conflict";
        conflictRescueRef.current = result.rescue?.id ?? null;
        if (result.rescue) {
          dirtyRef.current = false;
          firstDirtyAtRef.current = null;
        }
        if (mountedRef.current) {
          setSaveStatus("conflict");
          setDrafts(listArticleDrafts(username));
        }
        return false;
      }
      revisionRef.current = result.draft.revision;
      dirtyRef.current = false;
      firstDirtyAtRef.current = null;
      saveFailureRef.current = null;
      conflictRescueRef.current = null;
      if (mountedRef.current) {
        setSaveStatus("saved");
        setSavedAt(result.draft.updatedAt);
        setDrafts(listArticleDrafts(username));
      }
      return true;
    } catch {
      saveFailureRef.current = "error";
      if (mountedRef.current) setSaveStatus("error");
      return false;
    }
  }, [draftId, username]);
  persistRef.current = persist;

  const blocker = useBlocker(useCallback(() => !persistRef.current(), []));

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (confirmUnsavedTransition()) {
      blocker.proceed();
    } else {
      blocker.reset();
    }
  }, [blocker]);

  useEffect(
    () => registerUnsavedTransitionGuard(() => persistRef.current()),
    [],
  );

  useEffect(() => {
    if (!dirtyRef.current) return;
    const now = Date.now();
    const firstDirtyAt = firstDirtyAtRef.current ?? now;
    firstDirtyAtRef.current = firstDirtyAt;
    const maxWaitRemaining = Math.max(
      0,
      firstDirtyAt + AUTOSAVE_MAX_WAIT_MS - now,
    );
    const timer = window.setTimeout(
      () => persist(),
      Math.min(AUTOSAVE_DELAY_MS, maxWaitRemaining),
    );
    return () => window.clearTimeout(timer);
  }, [fields, persist]);

  useEffect(() => {
    mountedRef.current = true;
    const flush = () => persistRef.current();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (flush()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const pageHide = () => {
      flush();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", pageHide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mountedRef.current = false;
      persistRef.current();
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", pageHide);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (!isArticleDraftStorageKey(event.key)) return;
      setDrafts(listArticleDrafts(username));
      const current = loadArticleDraft(username, draftId);
      if (
        (current && current.revision !== revisionRef.current) ||
        (!current && revisionRef.current !== 0) ||
        hasArticleDraftConflict(username, draftId)
      ) {
        saveFailureRef.current = "conflict";
        setSaveStatus("conflict");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [draftId, username]);

  function updateFields(patch: Partial<ArticleDraftFields>) {
    if (publishingRef.current) return;
    const next = { ...fieldsRef.current, ...patch };
    fieldsRef.current = next;
    if (!dirtyRef.current) firstDirtyAtRef.current = Date.now();
    dirtyRef.current = true;
    conflictRescueRef.current = null;
    if (saveFailureRef.current !== "conflict") {
      saveFailureRef.current = null;
    }
    setFields(next);
    setSaveStatus(saveFailureRef.current === "conflict" ? "conflict" : "pending");
  }

  function clearPublishedDraft(expectedRevision: number | null) {
    dirtyRef.current = false;
    firstDirtyAtRef.current = null;
    if (expectedRevision === null) {
      toast.warning("Published, but the local draft could not be verified or cleared.");
      return;
    }
    try {
      const result = discardArticleDraft(username, draftId, expectedRevision);
      if (result === "conflict") {
        toast.warning("Published. A newer local draft revision was preserved.");
      }
    } catch {
      toast.warning("Published, but the local draft could not be cleared.");
    }
  }

  async function publish() {
    if (publishingRef.current) return;
    if (!canPublish) {
      toast.error(
        saveStatus === "conflict"
          ? "This draft changed in another window. Start a new draft or reload before publishing."
          : "A title and some content are required.",
      );
      return;
    }
    const saved = persist();
    if (saveFailureRef.current === "conflict") {
      toast.error(
        "This draft changed in another window. Start a new draft or reload before publishing.",
      );
      return;
    }
    const submitted: ArticleDraftFields = {
      ...fieldsRef.current,
      tags: [...fieldsRef.current.tags],
    };
    const submittedRevision = saved ? revisionRef.current : null;
    publishingRef.current = true;
    setPublishing(true);
    try {
      const created = await articles.publish({
        title: submitted.title.trim(),
        subtitle: submitted.subtitle.trim() || undefined,
        content: submitted.content.trim(),
        category: submitted.category || undefined,
        tags: submitted.tags,
      });
      clearPublishedDraft(submittedRevision);
      toast.success("Published");
      navigate(articleHref(created));
    } catch (error) {
      if (error instanceof ArticlePublishedHydrationError) {
        clearPublishedDraft(submittedRevision);
        toast.success("Published");
        navigate(articleHref({ id: error.articleId, slug: undefined }));
        return;
      }
      toast.error("Couldn't publish. Please try again.");
      publishingRef.current = false;
      setPublishing(false);
    }
  }

  function startNewDraft() {
    if (publishingRef.current) return;
    const saved = persist();
    if (
      saveFailureRef.current === "conflict" &&
      dirtyRef.current &&
      !conflictRescueRef.current
    ) {
      const rescuedId = newArticleDraftId();
      try {
        const rescue = saveArticleDraft(username, rescuedId, fieldsRef.current, 0);
        if (rescue.status !== "saved") throw new Error("rescue conflict");
        dirtyRef.current = false;
        firstDirtyAtRef.current = null;
        toast.info("Your version was preserved as a separate local draft.");
      } catch {
        toast.error("This draft could not be preserved locally.");
        return;
      }
    } else if (!saved && saveFailureRef.current !== "conflict") {
      toast.error("This draft could not be saved locally.");
      return;
    } else if (conflictRescueRef.current) {
      toast.info("Your version was preserved as a separate local draft.");
    }
    navigate(`/articles/new?draft=${encodeURIComponent(newArticleDraftId())}`);
  }

  function discardCurrentDraft() {
    if (publishingRef.current) return;
    if (!window.confirm("Discard this local draft? This cannot be undone.")) return;
    try {
      const result = discardArticleDraft(
        username,
        draftId,
        revisionRef.current,
      );
      if (result === "conflict") {
        saveFailureRef.current = "conflict";
        setSaveStatus("conflict");
        toast.error("A newer draft revision was preserved. Reload before discarding.");
        return;
      }
      dirtyRef.current = false;
      navigate("/articles", { replace: true });
    } catch {
      toast.error("Couldn't discard this local draft.");
    }
  }

  return (
    <div className="animate-slide-up">
      <PageHeader
        title="Write an article"
        description="Compose in Markdown on the left; preview live on the right."
        actions={
          <div className="flex items-center gap-2">
            {drafts.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    aria-label="Choose a local draft"
                    disabled={publishing}
                  >
                    <FileClock className="h-4 w-4" aria-hidden />
                    <span className="hidden sm:inline">Drafts</span>
                    <span className="bidi-number tabular-nums">{drafts.length}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-w-[min(20rem,calc(100vw-2rem))]">
                  {drafts.map((draft) => (
                    <DropdownMenuItem
                      key={draft.id}
                      className="whitespace-normal"
                      onSelect={() =>
                        navigate(
                          `/articles/new?draft=${encodeURIComponent(draft.id)}`,
                        )
                      }
                    >
                      <span className="min-w-0 break-words">
                        {articleDraftLabel(draft)}
                      </span>
                      {draft.id === draftId ? (
                        <Check className="ms-2 h-4 w-4 shrink-0 text-primary" aria-hidden />
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <Button
              variant="outline"
              size="icon"
              onClick={startNewDraft}
              aria-label="Start a new draft"
              disabled={publishing}
            >
              <Plus className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={discardCurrentDraft}
              aria-label="Discard this draft"
              disabled={publishing}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
            <Button onClick={publish} disabled={!canPublish || publishing}>
              {publishing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  <span className="sr-only sm:not-sr-only">Publishing</span>
                </>
              ) : (
                <>
                  <PenLine className="h-4 w-4" aria-hidden />
                  <span className="sr-only sm:not-sr-only">Publish</span>
                </>
              )}
            </Button>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="bidi-number tabular-nums">
          {words} {words === 1 ? "word" : "words"} · {readingMinutes(words)} min read
        </span>
        <span
          className={cn(
            "flex items-center gap-1.5",
            saveStatus === "error" || saveStatus === "conflict"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
          role="status"
          aria-live="polite"
        >
          {saveStatus === "pending" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : saveStatus === "saved" ? (
            <Check className="h-3.5 w-3.5 text-success" aria-hidden />
          ) : saveStatus === "error" || saveStatus === "conflict" ? (
            <AlertCircle className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <CloudUpload className="h-3.5 w-3.5" aria-hidden />
          )}
          {saveStatus === "pending"
            ? "Saving locally…"
            : saveStatus === "saved"
              ? `Saved locally${
                  savedAt
                    ? ` at ${new Date(savedAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}`
                    : ""
                }`
              : saveStatus === "error"
                ? "Autosave unavailable — copy your work before leaving"
                : saveStatus === "conflict"
                  ? "This draft changed in another window"
                  : "Autosave on"}
        </span>
      </div>

      {initial.draft ? (
        <Callout
          tone="info"
          icon={FileClock}
          title="Local draft restored"
          className="mb-5"
        >
          <p className="text-muted-foreground">
            Your work from this device is ready to continue. Publishing or
            discarding clears this draft only.
          </p>
        </Callout>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Composer */}
        <Card className="space-y-4 rounded-xl border-border/60 bg-card/60 p-5">
          <div className="space-y-2">
            <Label htmlFor="art-title">Title</Label>
            <Input
              id="art-title"
              value={title}
              onChange={(e) => updateFields({ title: e.target.value })}
              disabled={publishing}
              placeholder="A clear, compelling headline"
              className="text-base"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="art-subtitle">Subtitle</Label>
            <Input
              id="art-subtitle"
              value={subtitle}
              onChange={(e) => updateFields({ subtitle: e.target.value })}
              disabled={publishing}
              placeholder="An optional one-line hook"
            />
          </div>

          <div className="space-y-2">
            <Label>Category</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full justify-between font-normal"
                  aria-label="Choose a category"
                  disabled={publishing}
                >
                  <span className={cn(!category && "text-muted-foreground")}>
                    {category || "Select a category"}
                  </span>
                  <ChevronDown className="h-4 w-4 opacity-60" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-[--radix-dropdown-menu-trigger-width]">
                {CATEGORIES.map((cat) => (
                  <DropdownMenuItem
                    key={cat}
                    onSelect={() => updateFields({ category: cat })}
                    className="justify-between"
                  >
                    {cat}
                    {category === cat ? (
                      <Check className="h-4 w-4 text-primary" aria-hidden />
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <ArticleTagInput
            value={tags}
            onChange={(nextTags) => updateFields({ tags: nextTags })}
            disabled={publishing}
          />

          <div className="space-y-2">
            <Label htmlFor="art-content">Content (Markdown)</Label>
            <Textarea
              id="art-content"
              value={content}
              onChange={(e) => updateFields({ content: e.target.value })}
              disabled={publishing}
              placeholder={PLACEHOLDER}
              className="min-h-[420px] resize-y font-mono text-sm leading-relaxed"
            />
          </div>
        </Card>

        {/* Live preview */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          <div className="mb-2 eyebrow text-muted-foreground">
            Preview
          </div>
          <Card className="min-h-[420px] rounded-xl border-border/60 bg-card/40 p-6">
            {title || content ? (
              <div className="space-y-4">
                {title ? (
                  <h1 className="text-3xl font-bold leading-tight tracking-tight">
                    {title}
                  </h1>
                ) : null}
                {subtitle ? (
                  <p className="text-lg text-muted-foreground">{subtitle}</p>
                ) : null}
                {tags.length > 0 ? (
                  <div
                    className="flex flex-wrap gap-2"
                    aria-label="Article tags preview"
                  >
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="max-w-full break-words rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                {content ? (
                  <Markdown>{content}</Markdown>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Start writing to see your article take shape.
                  </p>
                )}
              </div>
            ) : (
              <div className="flex h-full min-h-[360px] items-center justify-center text-center">
                <p className="max-w-xs text-sm text-muted-foreground">
                  Your live preview appears here as you write.
                </p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
