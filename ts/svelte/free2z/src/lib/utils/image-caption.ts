/** A captioned image is a standalone Markdown image line followed by a
 * `::caption[<JSON string>]` line using JSON.stringify canonical encoding.
 * Captions allow tabs and line breaks, but no other ASCII control characters.
 * JSON preserves newlines and punctuation;
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
    /^( {0,3}!\[[^\r\n]+)\r?\n {0,3}::caption\[("(?:[^"\\\r\n]|\\.)*")\][ \t]*(?:\r?\n|$)/.exec(
      source,
    );
  if (!match) return null;
  try {
    const caption: unknown = JSON.parse(match[2]);
    if (typeof caption !== "string" || !caption) return null;
    // Match the editor serializer: alternate JSON escapes must not introduce
    // visible characters absent from the source inspected by content checks.
    if (JSON.stringify(caption) !== match[2]) return null;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(caption)) return null;
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
