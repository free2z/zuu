import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Check, ChevronDown, Loader2, Lock, PenLine } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { articles } from "@/lib/api/free2z";
import { useSession } from "@/store/session";
import { cn } from "@/lib/utils";
import { articleHref, readingMinutes, wordCount } from "../lib";
import { ArticleTagInput } from "../components/ArticleTagInput";

const CATEGORIES = ["Zcash", "Technology", "Community", "Education"];

const PLACEHOLDER = `# Your headline

Write in **Markdown**. Use headings, _emphasis_, lists, and > quotes.

- Point one
- Point two

Share what you're building on Zcash.`;

export function Author() {
  const user = useSession((s) => s.user);
  const navigate = useNavigate();

  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [category, setCategory] = useState<string>("");
  const [tags, setTags] = useState<string[]>([]);
  const [content, setContent] = useState("");
  const [publishing, setPublishing] = useState(false);

  const words = useMemo(() => wordCount(content), [content]);
  const canPublish = title.trim().length > 0 && content.trim().length > 0;

  async function publish() {
    if (!canPublish) {
      toast.error("A title and some content are required.");
      return;
    }
    setPublishing(true);
    try {
      const created = await articles.publish({
        title: title.trim(),
        subtitle: subtitle.trim() || undefined,
        content: content.trim(),
        category: category || undefined,
        tags,
      });
      toast.success("Published");
      navigate(articleHref(created));
    } catch {
      toast.error("Couldn't publish. Please try again.");
      setPublishing(false);
    }
  }

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

  return (
    <div className="animate-slide-up">
      <PageHeader
        title="Write an article"
        description="Compose in Markdown on the left; preview live on the right."
        actions={
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground tabular-nums sm:inline">
              {words} {words === 1 ? "word" : "words"} · {readingMinutes(words)}{" "}
              min read
            </span>
            <Button onClick={publish} disabled={!canPublish || publishing}>
              {publishing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Publishing
                </>
              ) : (
                <>
                  <PenLine className="h-4 w-4" aria-hidden />
                  Publish
                </>
              )}
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Composer */}
        <Card className="space-y-4 rounded-xl border-border/60 bg-card/60 p-5">
          <div className="space-y-2">
            <Label htmlFor="art-title">Title</Label>
            <Input
              id="art-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="A clear, compelling headline"
              className="text-base"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="art-subtitle">Subtitle</Label>
            <Input
              id="art-subtitle"
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
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
                    onSelect={() => setCategory(cat)}
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
            onChange={setTags}
            disabled={publishing}
          />

          <div className="space-y-2">
            <Label htmlFor="art-content">Content (Markdown)</Label>
            <Textarea
              id="art-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
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
