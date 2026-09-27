import { SdkError, cancelled, failure } from "./error.js";
export interface Frame {
  event: string;
  data: string;
}
/** Lazy framing: at most one network chunk and one bounded event are retained. */
export async function* frames(
  response: Response,
  signal: AbortSignal,
  idleMs: number,
): AsyncGenerator<Frame> {
  const reader = response.body?.getReader();
  if (!reader) failure("stream_interrupted");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = "",
    data = "",
    event = "",
    cr = false,
    first = true,
    size = 0;
  let lastByte = performance.now(),
    emptyReads = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  function newline(): Frame | undefined {
    const current = line;
    line = "";
    if (current === "") {
      const frame =
        data === ""
          ? undefined
          : { event: event || "message", data: data.slice(0, -1) };
      data = "";
      event = "";
      size = 0;
      return frame;
    }
    if (current[0] === ":") return undefined;
    const colon = current.indexOf(":");
    const field = colon === -1 ? current : current.slice(0, colon);
    let value = colon === -1 ? "" : current.slice(colon + 1);
    if (value[0] === " ") value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") data += `${value}\n`;
    return undefined;
  }
  try {
    for (;;) {
      cancelled(signal);
      if (emptyReads === 0) lastByte = performance.now();
      if (performance.now() - lastByte >= idleMs) failure("stream_interrupted");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timed = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            abort();
            reject(new SdkError("stream_interrupted"));
          },
          Math.max(1, idleMs - (performance.now() - lastByte)),
        );
      });
      let item: ReadableStreamReadResult<Uint8Array<ArrayBufferLike>>;
      try {
        item = await Promise.race([reader.read(), timed]);
      } finally {
        clearTimeout(timer);
      }
      cancelled(signal);
      if (item.done) {
        decoder.decode();
        break;
      }
      if (item.value.byteLength === 0) {
        if (++emptyReads % 64 === 0)
          await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }
      emptyReads = 0;
      lastByte = performance.now();
      if (item.value.byteLength > 1024 * 1024) failure("response_too_large");
      let text = decoder.decode(item.value, { stream: true });
      if (first && text.length) {
        first = false;
        if (text[0] === "\uFEFF") text = text.slice(1);
      }
      for (const char of text) {
        cancelled(signal);
        if (cr && char === "\n") {
          cr = false;
          continue;
        }
        cr = false;
        if (char === "\r" || char === "\n") {
          cr = char === "\r";
          const frame = newline();
          if (frame) yield frame;
        } else {
          line += char;
          if (++size > 256 * 1024) failure("response_too_large");
        }
      }
    }
    // No dispatch of an unterminated trailing event: a cut body is ambiguous.
  } catch (error) {
    if (error instanceof SdkError) throw error;
    throw new SdkError(signal.aborted ? "cancelled" : "stream_interrupted");
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
