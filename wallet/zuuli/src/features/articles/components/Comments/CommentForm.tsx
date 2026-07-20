import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Eye, EyeOff, Loader2, LogIn, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/common/Markdown";
import { formatTuzis } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/session";
import type { Comment, CommentInput } from "@/lib/api/types";

const HEADLINE_MAX = 100;
const CONTENT_MAX = 1000;

interface CommentFormProps {
  /** Performs the POST (root create vs. reply create is decided by the caller). */
  submit: (body: CommentInput) => Promise<Comment>;
  /** Called with the freshly-created comment after a successful post. */
  onPosted: (comment: Comment) => void;
  /** Reply forms render a cancel affordance and start focused. */
  onCancel?: () => void;
  compact?: boolean;
  autoFocus?: boolean;
}

export function CommentForm({
  submit,
  onPosted,
  onCancel,
  compact,
  autoFocus,
}: CommentFormProps) {
  const navigate = useNavigate();
  const user = useSession((s) => s.user);
  const balance = useSession((s) => s.tuzis);
  const adjustTuzis = useSession((s) => s.adjustTuzis);

  const [headline, setHeadline] = useState("");
  const [content, setContent] = useState("");
  const [tuzis, setTuzis] = useState(1);
  const [preview, setPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Login gate — comments cost 2Zs, which requires an account.
  if (!user) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/30 px-4 py-6 text-center">
        <p className="text-sm text-muted-foreground">
          Log in to join the conversation — comments are titled and cost 2Zs.
        </p>
        <Button
          className="mt-3"
          variant="outline"
          onClick={() => navigate("/login")}
        >
          <LogIn className="h-4 w-4" aria-hidden />
          Log in to comment
        </Button>
      </div>
    );
  }

  const headlineOk = headline.trim().length > 0 && headline.length <= HEADLINE_MAX;
  const contentOk = content.trim().length > 0 && content.length <= CONTENT_MAX;
  const weightOk = tuzis >= 1;
  const enough = tuzis <= balance;
  const canPost = headlineOk && contentOk && weightOk && enough && !submitting;

  async function post() {
    if (!canPost) return;
    setSubmitting(true);
    try {
      const created = await submit({
        headline: headline.trim(),
        content: content.trim(),
        tuzis,
      });
      // Posting spends the weight from the local balance, like the tip flow.
      adjustTuzis(-tuzis);
      toast.success(`Posted — ${formatTuzis(tuzis)} weight`);
      setHeadline("");
      setContent("");
      setTuzis(1);
      setPreview(false);
      onPosted(created);
    } catch {
      toast.error("Could not post your comment. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={cn("space-y-3", compact && "space-y-2")}>
      <div className="space-y-1.5">
        <Label htmlFor="comment-headline" className="sr-only">
          Headline
        </Label>
        <Input
          id="comment-headline"
          placeholder="Headline"
          value={headline}
          maxLength={HEADLINE_MAX + 1}
          autoFocus={autoFocus}
          onChange={(e) => setHeadline(e.target.value)}
          aria-invalid={headline.length > HEADLINE_MAX}
        />
      </div>

      {preview ? (
        <div className="min-h-[6rem] w-full min-w-0 overflow-x-auto rounded-md border border-border bg-background/50 px-3 py-2">
          {content.trim() ? (
            // Preview with the same hardened variant the posted comment uses,
            // so what you see is what readers get.
            <Markdown variant="comment">{content}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>
          )}
        </div>
      ) : (
        <div className="space-y-1">
          <Label htmlFor="comment-body" className="sr-only">
            Comment
          </Label>
          <Textarea
            id="comment-body"
            placeholder="Share your thoughts… (markdown supported)"
            value={content}
            maxLength={CONTENT_MAX + 1}
            rows={compact ? 3 : 4}
            onChange={(e) => setContent(e.target.value)}
            aria-invalid={content.length > CONTENT_MAX}
          />
          <p
            className={cn(
              "text-right text-xs tabular-nums text-muted-foreground",
              content.length > CONTENT_MAX && "text-destructive",
            )}
          >
            {content.length}/{CONTENT_MAX}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="comment-weight" className="text-xs text-muted-foreground">
            Weight
          </Label>
          <Input
            id="comment-weight"
            type="number"
            min={1}
            inputMode="numeric"
            value={tuzis}
            onChange={(e) => setTuzis(Math.max(1, Number(e.target.value) || 1))}
            className="h-9 w-20 tabular-nums"
            aria-label="2Z weight to spend on this comment"
          />
          <span className="text-xs text-muted-foreground">2Z</span>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setPreview((p) => !p)}
        >
          {preview ? (
            <EyeOff className="h-4 w-4" aria-hidden />
          ) : (
            <Eye className="h-4 w-4" aria-hidden />
          )}
          {preview ? "Edit" : "Preview"}
        </Button>

        <div className="ml-auto flex items-center gap-2">
          {onCancel ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </Button>
          ) : null}
          {!enough ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigate("/buy")}
            >
              Not enough 2Z
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={post} disabled={!canPost}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Posting
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" aria-hidden />
                  Post
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
