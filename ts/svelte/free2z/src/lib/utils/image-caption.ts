/** A captioned image is a standalone Markdown image line followed by a
 * `::caption[<JSON string>]` line. JSON preserves newlines and punctuation;
 * older Markdown readers still render the image and show the directive as text.
 * The image's alt and optional title remain ordinary Markdown semantics.
 */
export type CaptionedImage = { image: string; caption: string };

export function serializeCaptionedImage(
  image: string,
  caption: string,
): string {
  if (!caption) return image;
  return `${image}\n::caption[${JSON.stringify(caption)}]`;
}

export function parseCaptionedImage(source: string): CaptionedImage | null {
  const match =
    /^( {0,3}!\[[^\n]+)\n {0,3}::caption\[("(?:[^"\\\n]|\\.)*")\][ \t]*(?:\n|$)/.exec(
      source,
    );
  if (!match) return null;
  try {
    const caption: unknown = JSON.parse(match[2]);
    if (typeof caption !== "string" || !caption) return null;
    return { image: match[1].trim(), caption };
  } catch {
    return null;
  }
}

/** Replace or remove a caption without altering the original image Markdown. */
export function updateImageCaption(source: string, caption: string): string {
  const parsed = parseCaptionedImage(source);
  if (!parsed) return serializeCaptionedImage(source, caption);
  const match = /^(?:[^\n]+\n)[^\n]*(?:\n|$)/.exec(source)!;
  return (
    serializeCaptionedImage(parsed.image, caption) +
    (match[0].endsWith("\n") ? "\n" : "") +
    source.slice(match[0].length)
  );
}
