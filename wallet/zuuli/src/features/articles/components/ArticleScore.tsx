import { ArrowUp } from "lucide-react";

interface ArticleScoreProps {
  score: number;
}

/** Displays the server-provided article score without implying it is editable. */
export function ArticleScore({ score }: ArticleScoreProps) {
  return (
    <div
      className="inline-flex items-center gap-2 text-sm text-muted-foreground"
      aria-label={`Article score: ${score}`}
    >
      <ArrowUp className="h-4 w-4" aria-hidden />
      <span>Score</span>
      <span className="tabular-nums text-foreground">{score}</span>
    </div>
  );
}
