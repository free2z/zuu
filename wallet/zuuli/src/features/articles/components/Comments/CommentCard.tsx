import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronUp, MessageSquare, Reply } from "lucide-react";
import { toast } from "sonner";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/common/Markdown";
import { comments as commentsApi } from "@/lib/api/free2z";
import { formatTuzis, initials, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/session";
import type { Comment, CommentInput } from "@/lib/api/types";
import { CommentForm } from "./CommentForm";

interface CommentCardProps {
  comment: Comment;
  /**
   * Live direct-reply count, tracked by the parent thread so a freshly-posted
   * reply bumps the badge immediately (F5). Falls back to the comment's own
   * `num_children` when the thread doesn't override it.
   */
  numChildren?: number;
  /** Called after a reply is posted so the thread can show it + bump its count. */
  onReplied: (reply: Comment) => void;
}

export function CommentCard({ comment, numChildren, onReplied }: CommentCardProps) {
  const user = useSession((s) => s.user);
  const balance = useSession((s) => s.tuzis);
  const adjustTuzis = useSession((s) => s.adjustTuzis);
  const [replying, setReplying] = useState(false);
  const [score, setScore] = useState(comment.tuzis);
  const [voted, setVoted] = useState<"up" | "down" | null>(null);
  const [voting, setVoting] = useState(false);

  const name = comment.author.username;
  const childCount = numChildren ?? comment.num_children;

  // Voting costs 1 2Z (POST /vote/). It requires an account AND a balance —
  // gate the rail so logged-out or broke users can't fire a request that
  // would just 401/402, and can't drive the optimistic balance negative.
  const canVote = !!user && balance >= 1;

  async function vote(dir: "up" | "down") {
    if (voting || voted === dir || !canVote) return;
    setVoting(true);
    // Optimistic: reflect the new score + spend 1 2Z immediately.
    const prevScore = score;
    const prevVoted = voted;
    // Capture the exact pre-debit balance so a failure restores it precisely.
    // (Blindly refunding +1 would MINT phantom 2Z whenever the debit had been
    // clamped at 0 — hence restore the delta, not a fixed +1.)
    const prevBalance = useSession.getState().tuzis;
    setScore((s) => s + (dir === "up" ? 1 : -1));
    setVoted(dir);
    adjustTuzis(-1);
    try {
      await commentsApi.vote(comment.uuid, dir);
    } catch {
      setScore(prevScore);
      setVoted(prevVoted);
      adjustTuzis(prevBalance - useSession.getState().tuzis);
      toast.error("Could not record your vote.");
    } finally {
      setVoting(false);
    }
  }

  async function submitReply(body: CommentInput) {
    return commentsApi.createReply(comment.uuid, body);
  }

  const voteHint = !user
    ? "Log in to vote"
    : balance < 1
      ? "You need 2Z to vote"
      : undefined;

  return (
    <div className="min-w-0 rounded-xl border border-border bg-card/60 p-4">
      <div className="flex items-start gap-3">
        {/* Vote rail */}
        <div className="flex shrink-0 flex-col items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 min-tap"
            aria-label="Upvote comment"
            aria-pressed={voted === "up"}
            disabled={voting || !canVote}
            title={voteHint}
            onClick={() => vote("up")}
          >
            <ChevronUp
              className={cn("h-4 w-4", voted === "up" && "text-primary")}
              aria-hidden
            />
          </Button>
          <span className="text-xs font-semibold tabular-nums text-muted-foreground">
            {score}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 min-tap"
            aria-label="Downvote comment"
            aria-pressed={voted === "down"}
            disabled={voting || !canVote}
            title={voteHint}
            onClick={() => vote("down")}
          >
            <ChevronDown
              className={cn("h-4 w-4", voted === "down" && "text-primary")}
              aria-hidden
            />
          </Button>
        </div>

        {/* Body */}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <Link
              to={`/creator/${name}`}
              className="flex items-center gap-2 font-medium text-foreground transition-colors hover:text-primary"
            >
              <Avatar className="h-6 w-6">
                {comment.author.avatar_image ? (
                  <AvatarImage src={comment.author.avatar_image} alt={name} />
                ) : null}
                <AvatarFallback className="text-[10px]">
                  {initials(name)}
                </AvatarFallback>
              </Avatar>
              {name}
            </Link>
            <span className="text-muted-foreground" aria-hidden>
              ·
            </span>
            <span className="text-xs text-muted-foreground">
              {timeAgo(comment.created_at)}
            </span>
            <span
              className="ml-auto inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground"
              title={`${formatTuzis(comment.tuzis)} weight`}
            >
              {formatTuzis(comment.tuzis)}
            </span>
          </div>

          <h4 className="break-words text-base font-semibold leading-snug">
            {comment.headline}
          </h4>

          <div className="min-w-0 max-w-full overflow-x-auto break-words text-sm text-muted-foreground">
            {/* Untrusted, unmoderated user content: comment variant degrades
                remote images/embeds/QRs to links/text and is wrapped in an
                error boundary so a malicious body can never crash the page. */}
            <Markdown variant="comment">{comment.content}</Markdown>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-muted-foreground"
              onClick={() => setReplying((r) => !r)}
              aria-expanded={replying}
            >
              <Reply className="h-4 w-4" aria-hidden />
              Reply
            </Button>
            {childCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                {childCount}
              </span>
            ) : null}
          </div>

          {replying ? (
            <div className="pt-2">
              <CommentForm
                compact
                autoFocus
                submit={submitReply}
                onCancel={() => setReplying(false)}
                onPosted={(reply) => {
                  setReplying(false);
                  onReplied(reply);
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
