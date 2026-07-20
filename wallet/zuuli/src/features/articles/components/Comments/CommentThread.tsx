import { useCallback, useEffect, useState } from "react";
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
  // Bumped whenever a reply is posted under this comment, to refetch children.
  const [reload, setReload] = useState(0);

  return (
    <div className="min-w-0 space-y-3">
      <CommentCard
        comment={comment}
        onReplied={() => setReload((n) => n + 1)}
      />
      <CommentReplies
        parentUuid={comment.uuid}
        contentType={contentType}
        reload={reload}
        depth={depth + 1}
      />
    </div>
  );
}

interface CommentRepliesProps {
  parentUuid: string;
  contentType: CommentContentType;
  reload: number;
  depth: number;
}

function CommentReplies({
  parentUuid,
  contentType,
  reload,
  depth,
}: CommentRepliesProps) {
  const [replies, setReplies] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const acc: Comment[] = [];
      let page: number | null = 1;
      while (page) {
        const res = await commentsApi.listReplies(parentUuid, { page });
        acc.push(...res.items);
        page = res.next;
      }
      setReplies(acc);
    } catch {
      // A failed reply fetch shouldn't tear down the whole thread; leave the
      // existing replies in place.
    } finally {
      setLoading(false);
    }
  }, [parentUuid]);

  useEffect(() => {
    void load();
  }, [load, reload]);

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
