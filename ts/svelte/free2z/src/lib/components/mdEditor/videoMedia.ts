/** Formats supported by the native Markdown video renderer. */
export const VIDEO_ACCEPT =
  "video/mp4,video/webm,video/quicktime,video/x-m4v,.mp4,.m4v,.webm,.mov,.qt";
const videoExtension = /\.(mp4|m4v|webm|mov|qt)$/i;
export function supportedVideo(mime: string | undefined, path: string) {
  return Boolean(
    mime?.startsWith("video/") && videoExtension.test(path.split(/[?#]/, 1)[0]),
  );
}
/** Browser MIME associations can be absent; the server validates the bytes. */
export function supportedVideoFile(mime: string, name: string) {
  return (
    (mime.startsWith("video/") ||
      mime === "" ||
      mime === "application/octet-stream") &&
    videoExtension.test(name)
  );
}
