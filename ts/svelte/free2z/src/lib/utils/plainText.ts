import { parseCaptionedImage } from "./image-caption.ts";

/**
 * Remove standalone media/embed directives from summaries. Keep this line
 * aware so directive-shaped text in fenced code and ordinary prose survives.
 * The trailing ellipsis is accepted because public article payloads can
 * truncate a directive at the end of its line after the closing bracket.
 */
export function stripMediaDirectivesFromSummary(
  value: string,
  captionText: (caption: string) => string = (caption) => caption,
): string {
  const lines = value.split(/(?<=\n)/);
  let fence: { marker: "`" | "~"; length: number } | null = null;

  return lines
    .map((line, index) => {
      const content = line.replace(/\r?\n$/, "");
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(content);

      if (fence) {
        if (
          fenceMatch &&
          fenceMatch[1][0] === fence.marker &&
          fenceMatch[1].length >= fence.length &&
          /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(content)
        ) {
          fence = null;
        }
        return line;
      }

      if (
        fenceMatch &&
        (fenceMatch[1][0] !== "`" ||
          !content.slice(fenceMatch[0].length).includes("`"))
      ) {
        fence = {
          marker: fenceMatch[1][0] as "`" | "~",
          length: fenceMatch[1].length,
        };
        return line;
      }

      const previous = lines[index - 1] ?? "";
      if (/^ {0,3}!\[/.test(previous)) {
        // Public list payloads append an ellipsis after a bounded body slice.
        // Decode only a complete canonical caption; omit a cut directive.
        const excerpt = /(?:\.\.\.|…)[ \t]*(?:\r?\n)?$/.test(line);
        const captionLine = excerpt
          ? line.replace(/(?:\.\.\.|…)([ \t]*(?:\r?\n)?)$/, "$1")
          : line;
        const image = parseCaptionedImage(previous + captionLine);
        if (image)
          return captionText(image.caption) + (line.endsWith("\n") ? "\n" : "");
        if (excerpt && /^ {0,3}::caption\[/.test(line)) return " ";
      }

      return /^ {0,3}::(?:embed|iframe|qrcode)\[[^\]\n]+(?:\](?:\.{3}|…)?|\.{3}|…)[ \t]*\r?(?:\n)?$/i.test(
        line,
      )
        ? line.replace(/[^\r\n]/g, " ")
        : line;
    })
    .join("");
}

/** Protect literal captions while a caller processes the surrounding Markdown. */
export function protectSummaryCaptions(value: string) {
  // Inventory fixed-shape markers in one pass. Repeated article text must
  // never grow a placeholder or the restoration regular expression.
  const occupied = new Set(
    Array.from(value.matchAll(/F2ZCAPTIONTOKEN(\d+)SEP/g), (match) => match[1]),
  );
  let candidate = 0;
  while (occupied.has(String(candidate))) candidate += 1;
  const marker = `F2ZCAPTIONTOKEN${candidate}SEP`;
  const captions: string[] = [];
  const text = stripMediaDirectivesFromSummary(value, (caption) => {
    const index = captions.push(caption) - 1;
    return `${marker}${index}END`;
  });
  return {
    text,
    restore: (plain: string) =>
      plain.replace(
        new RegExp(`${marker}(\\d+)END`, "g"),
        (_, index) => captions[Number(index)],
      ),
  };
}

export function markdownToPlainText(value: string, maxLength = 200) {
  const captions = protectSummaryCaptions(value);
  const plain = captions
    .restore(
      captions.text
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/^\s{0,3}(#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
        .replace(/[~*_]/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'"),
    )
    .replace(/\s+/g, " ")
    .trim();

  if (plain.length <= maxLength) return plain;
  const cut = plain.slice(0, maxLength + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut.slice(0, maxLength)).trim()}…`;
}
