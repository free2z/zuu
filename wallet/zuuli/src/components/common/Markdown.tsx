import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Themed markdown renderer used by Articles and AI chat. Styled inline (no
 * tailwind-typography dependency) so it always matches the ZUULI dark theme.
 */
export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "space-y-4 text-[15px] leading-relaxed text-foreground/90",
        "[&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:tracking-tight",
        "[&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold",
        "[&_h3]:mt-4 [&_h3]:text-lg [&_h3]:font-semibold",
        "[&_p]:leading-relaxed",
        "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4",
        "[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6",
        "[&_li]:my-1",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-primary [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-muted-foreground",
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px]",
        "[&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_img]:rounded-lg [&_img]:border [&_img]:border-border",
        "[&_hr]:my-6 [&_hr]:border-border",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
