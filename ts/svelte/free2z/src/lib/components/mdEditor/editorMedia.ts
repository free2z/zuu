import {
  SUPPORTED_UPLOAD_MIME_TYPES,
  DECLARED_TYPE_ALIASES,
  NEUTRAL_DECLARED_TYPES,
  normalizeDeclaredType,
  mediaKind,
  fileExtension,
  type MediaKind,
} from "../media/supportedUploadTypes";

export type EditorMediaKind = Exclude<MediaKind, "image">;
export const mediaMimeTypes = (kind: EditorMediaKind) =>
  SUPPORTED_UPLOAD_MIME_TYPES.filter((mime) => mediaKind(mime) === kind);
export const mediaAccept = (kind: EditorMediaKind) =>
  [
    ...mediaMimeTypes(kind),
    ...Object.keys(DECLARED_TYPE_ALIASES).filter((alias) =>
      mediaMimeTypes(kind).includes(DECLARED_TYPE_ALIASES[alias]),
    ),
  ].join(",");

/** Unknown browser associations defer to byte validation on the server. */
export function acceptsEditorMedia(
  kind: EditorMediaKind,
  mime: string,
  name: string,
) {
  const type = normalizeDeclaredType(mime);
  if (NEUTRAL_DECLARED_TYPES.has(type)) {
    if (kind === "document")
      return mediaMimeTypes(kind).some(
        (mime) => mime.split("/")[1] === fileExtension(name),
      );
    return mediaKind("", name) === kind;
  }
  return mediaMimeTypes(kind).includes(DECLARED_TYPE_ALIASES[type] || type);
}
