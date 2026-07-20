import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { comments as commentsApi } from "@/lib/api/free2z";
import type { Comment, CommentContentType } from "@/lib/api/types";
import { CommentCard } from "./CommentCard";

/** How deep to keep indenting before flattening, so deep threads never push
 *  content off-screen on a phone. */
const MAX_INDENT_DEPTH = 4;

interface CommentThreadProps {
  comment: Comment;
  contentType: CommentContentType;
  depth?: number;
}

/** One comment plus its (recursively threaded) replies. */
export function CommentThread({ comment, contentType, depth = 0 }: CommentThreadProps) {
  // Track the direct-child count locally so posting a reply immediately (a)
  // reveals the reply and (b) updates the count badge (F5) — both without a
  // full section reload.
  const [numChildren, setNumChildren] = useState(comment.num_children);
  // Replies posted from THIS session, appended locally so we never re-pull the
  // whole reply set just to show a comment we already have in hand (F7).
  const [extraReplies, setExtraReplies] = useState<Comment[]>([]);

  return (
    <div className="min-w-0 space-y-3">
      <CommentCard
        comment={comment}
        numChildren={numChildren}
        onReplied={(reply) => {
          setExtraReplies((prev) => [...prev, reply]);
          setNumChildren((n) => n + 1);
        }}
      />
      <CommentReplies
        parentUuid={comment.uuid}
        contentType={contentType}
        // Fetch only when the SERVER says this node has direct children. Leaves
        // (num_children === 0) make ZERO network requests (F2 — no per-node
        // waterfall); locally-posted replies come in via `extraReplies`.
        serverChildCount={comment.num_children}
        extraReplies={extraReplies}
        depth={depth + 1}
      />
    </div>
  );
}

interface CommentRepliesProps {
  parentUuid: string;
  contentType: CommentContentType;
  serverChildCount: number;
  extraReplies: Comment[];
  depth: number;
}

function CommentReplies({
  parentUuid,
  contentType,
  serverChildCount,
  extraReplies,
  depth,
}: CommentRepliesProps) {
  const [fetched, setFetched] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // F2: skip the /replies/ GET entirely for leaves. Only nodes the server
    // reports as having children pay for a fetch.
    if (serverChildCount <= 0) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const acc: Comment[] = [];
        let page: number | null = 1;
        while (page) {
          const res = await commentsApi.listReplies(parentUuid, { page });
          acc.push(...res.items);
          page = res.next;
        }
        if (!cancelled) setFetched(acc);
      } catch {
        // A failed reply fetch shouldn't tear down the whole thread; leave the
        // existing replies in place.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally not keyed on `extraReplies`: a new local reply is merged in
    // below without re-hitting the network (F7).
  }, [parentUuid, serverChildCount]);

  // Merge server replies with locally-posted ones, deduped by uuid so a reply
  // that later also arrives from the server can't render twice.
  const replies = useMemo(() => {
    if (!extraReplies.length) return fetched;
    const seen = new Set(fetched.map((r) => r.uuid));
    return [...fetched, ...extraReplies.filter((r) => !seen.has(r.uuid))];
  }, [fetched, extraReplies]);

  if (!replies.length) {
    return loading ? (
      <div className="pl-3">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
      </div>
    ) : null;
  }

  // The thread tree: indent replies with a left border, but stop indenting past
  // a max depth so long chains never cause horizontal overflow on mobile.
  const indent = depth <= MAX_INDENT_DEPTH;

  return (
    <div
      className={
        indent
          ? "space-y-3 border-l border-border pl-3 sm:pl-4"
          : "space-y-3"
      }
    >
      {replies.map((reply) => (
        <CommentThread
          key={reply.uuid}
          comment={reply}
          contentType={contentType}
          depth={depth}
        />
      ))}
    </div>
  );
}
