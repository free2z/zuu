import { useCallback, useEffect, useRef, useState } from "react";
import { useModeration } from "@/store/moderation";
import { getTokenSnapshot } from "@/lib/api/http";
import { MessagesSquare } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { comments as commentsApi } from "@/lib/api/free2z";
import type {
  Comment,
  CommentContentType,
  CommentInput,
} from "@/lib/api/types";
import { CommentForm } from "./CommentForm";
import { CommentThread } from "./CommentThread";

interface CommentsSectionProps {
  /** The content object's uuid — for a zpage this is `article.free2zaddr`. */
  uuid: string;
  contentType?: CommentContentType;
}

type Status = "loading" | "ready" | "error";

/**
 * Threaded comments for a content object (a zpage in the Reader). Fetches the
 * top-level comments (following DRF pagination), renders a titled compose form
 * (login-gated), and a recursive thread tree. Newly-posted roots appear at the
 * top of the list without a full refetch.
 */
export function CommentsSection({
  uuid,
  contentType = "zpage",
}: CommentsSectionProps) {
  const [roots, setRoots] = useState<Comment[]>([]);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const owner = useModeration((s) => s.owner);
  const ownerKey = owner
    ? `${owner.username}:${owner.token.generation}`
    : "anonymous";
  const loadedOwner = useRef(ownerKey);
  const generation = useRef(0);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const reload = () => setRefresh((n) => n + 1);
    window.addEventListener("free2z-moderation-refresh", reload);
    return () =>
      window.removeEventListener("free2z-moderation-refresh", reload);
  }, []);

  const load = useCallback(async () => {
    const current = ++generation.current;
    const sameOwner = () => {
      const owner = useModeration.getState().owner;
      return (
        (owner
          ? `${owner.username}:${owner.token.generation}`
          : "anonymous") === ownerKey
      );
    };
    setStatus("loading");
    const acc: Comment[] = [];
    let page: number | null = 1;
    let total = 0;
    while (page) {
      const res = await commentsApi.list(contentType, uuid, {
        rootsOnly: true,
        page,
      });
      if (generation.current !== current || !sameOwner()) return;
      acc.push(...res.items);
      total = res.count;
      page = res.next;
    }
    if (generation.current !== current || !sameOwner()) return;
    setRoots(acc);
    setCount(total);
    setStatus("ready");
  }, [contentType, uuid, ownerKey]);

  useEffect(() => {
    loadedOwner.current = ownerKey;
    setRoots([]);
    if (getTokenSnapshot().token && !owner) {
      setStatus("loading");
      return () => {
        generation.current += 1;
      };
    }
    const pending = load();
    const current = generation.current;
    void pending.catch(() => {
      if (generation.current === current) setStatus("error");
    });
    return () => {
      generation.current += 1;
    };
  }, [load, ownerKey, refresh, owner]);

  async function submitRoot(body: CommentInput) {
    return commentsApi.create(contentType, uuid, body);
  }

  return (
    <section aria-labelledby="comments-heading" className="mt-14 min-w-0">
      <div className="mb-5 flex items-center gap-2">
        <MessagesSquare className="h-5 w-5 text-muted-foreground" aria-hidden />
        <h2 id="comments-heading" className="text-xl font-bold tracking-tight">
          Comments
          {status === "ready" &&
          loadedOwner.current === ownerKey &&
          !(getTokenSnapshot().token && !owner) &&
          count > 0 ? (
            <span className="ms-2 text-base font-normal bidi-number tabular-nums text-muted-foreground">
              {count}
            </span>
          ) : null}
        </h2>
      </div>

      <div className="mb-8 rounded-xl border border-border bg-card/40 p-4">
        <CommentForm
          submit={submitRoot}
          onPosted={(created) => {
            setRoots((prev) => [created, ...prev]);
            setCount((c) => c + 1);
          }}
        />
      </div>

      {status === "loading" ||
      loadedOwner.current !== ownerKey ||
      (getTokenSnapshot().token && !owner) ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border border-border bg-card/60 p-4"
            >
              <div className="flex gap-3">
                <Skeleton className="h-7 w-7 rounded-md" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : status === "error" ? (
        <EmptyState
          icon={MessagesSquare}
          title="Couldn’t load comments"
          description="Something went wrong fetching the discussion. Try again later."
        />
      ) : roots.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title="No comments yet"
          description="Be the first to weigh in — comments are titled and backed by 2Zs."
        />
      ) : (
        <div className="space-y-4">
          {roots.map((root) => (
            <CommentThread
              key={root.uuid}
              comment={root}
              contentType={contentType}
            />
          ))}
        </div>
      )}
    </section>
  );
}
