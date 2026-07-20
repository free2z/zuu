import { useCallback, useEffect, useState } from "react";
import { MessagesSquare } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { comments as commentsApi } from "@/lib/api/free2z";
import type { Comment, CommentContentType, CommentInput } from "@/lib/api/types";
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

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const acc: Comment[] = [];
      let page: number | null = 1;
      let total = 0;
      while (page) {
        const res = await commentsApi.list(contentType, uuid, {
          rootsOnly: true,
          page,
        });
        acc.push(...res.items);
        total = res.count;
        page = res.next;
      }
      setRoots(acc);
      setCount(total);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [contentType, uuid]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitRoot(body: CommentInput) {
    return commentsApi.create(contentType, uuid, body);
  }

  return (
    <section aria-labelledby="comments-heading" className="mt-14 min-w-0">
      <div className="mb-5 flex items-center gap-2">
        <MessagesSquare className="h-5 w-5 text-muted-foreground" aria-hidden />
        <h2 id="comments-heading" className="text-xl font-bold tracking-tight">
          Comments
          {status === "ready" && count > 0 ? (
            <span className="ml-2 text-base font-normal tabular-nums text-muted-foreground">
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

      {status === "loading" ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border bg-card/60 p-4">
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
