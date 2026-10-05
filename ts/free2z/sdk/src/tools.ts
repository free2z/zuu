import { SdkError, failure } from "./error.js";
import type { Client } from "./client.js";
import type {
  Charge,
  ChatOptions,
  ChatRequest,
  ChatStream,
  Message,
  Session,
  ToolCall,
  ToolCallDelta,
} from "./types.js";

/** The `tool` message answering `call` with `content` (usually JSON text). */
export function toolResult(call: ToolCall, content: string): Message {
  return {
    role: "tool",
    tool_call_id: call.id,
    content: [{ type: "text", text: content }],
  };
}

/** A reply as an `assistant` message for the next request's history. */
export function assistantMessage(text: string, toolCalls: ToolCall[]): Message {
  const message: Message = { role: "assistant" };
  if (text) message.content = [{ type: "text", text }];
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

/** A tool call still arriving. `arguments` is usually not yet valid JSON. */
export interface PartialToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

/**
 * Assembles `tool_call_delta` fragments by `index`, to show a call taking
 * shape. Display only: run a tool from the complete `tool_call` event.
 */
export class ToolCallAccumulator {
  readonly #calls = new Map<number, PartialToolCall>();
  push(fragment: ToolCallDelta): PartialToolCall {
    let call = this.#calls.get(fragment.index);
    if (!call) {
      call = { arguments: "" };
      this.#calls.set(fragment.index, call);
    }
    if (fragment.id !== undefined) call.id = fragment.id;
    if (fragment.name !== undefined) call.name = fragment.name;
    call.arguments += fragment.arguments;
    return call;
  }
  /** Every call seen so far, in index order. */
  get calls(): PartialToolCall[] {
    return [...this.#calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);
  }
}

/** One call of a {@link runTools} loop: what it said, asked for and cost. */
export interface ToolRound {
  callId: string | undefined;
  text: string;
  toolCalls: ToolCall[];
  /** The `done` event's reason; `"error"` when the stream ended in `error`. */
  finishReason: string;
  /** What this call cost — also for one that failed after output. */
  charge: Charge;
  /** The `error` event's code, when the call failed; its output is partial. */
  error?: string;
}

/**
 * The session a {@link runTools} run is bound to, handed to each tool
 * handler. A handler that acts on account data should act as THIS session
 * (e.g. pass `sessionGeneration` to its own calls) rather than as whatever
 * session is current: the SDK checks the session before each handler, but
 * a sign-in can land between that check and the handler's own work.
 */
export interface ToolContext {
  sessionGeneration: string;
  subject: string | null;
}

/**
 * Read a stream to its end. A stream that ends in an `error` event is
 * returned, not thrown — with `error` set to its code, the partial output,
 * and what it cost (`charge`), so a failed call's charge is never lost; a
 * `replay` (an idempotency key that was already used) throws `replayed`.
 */
export async function collectChat(stream: ChatStream): Promise<ToolRound> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for await (const event of stream) {
    switch (event.type) {
      case "delta":
        text += event.text;
        break;
      case "tool_call":
        toolCalls.push({
          id: event.id,
          name: event.name,
          arguments: event.arguments,
        });
        break;
      case "done":
        return {
          callId: stream.callId,
          text,
          toolCalls,
          finishReason: event.finish_reason,
          charge: event.charge,
        };
      case "error":
        return {
          callId: stream.callId,
          text,
          toolCalls,
          finishReason: "error",
          charge: event.charge,
          error: event.code,
        };
      case "replay":
        throw new SdkError("replayed", { record: event.record });
      default:
        break;
    }
  }
  failure("stream_interrupted");
}

export interface RunToolsOptions {
  /** At most this many calls in all (default 4). Each is paid for. */
  maxRounds?: number;
  /**
   * The keys of round `round` (from 0). Create and PERSIST them before
   * returning: each round is a new billable operation, and this SDK never
   * invents an operation or idempotency key.
   */
  operation(round: number): ChatOptions | Promise<ChatOptions>;
}

export interface ToolRun {
  /** Every call that completed, in order, each with its own charge. */
  rounds: ToolRound[];
  /**
   * The conversation so far: the request's messages, then each completed
   * round's assistant turn and the results of the tools that ran.
   */
  messages: Message[];
  /** The options of each round attempted (one more than `rounds` when the last failed). */
  operations: ChatOptions[];
  /**
   * Why the run stopped early, if it did: the round after the last in
   * `rounds` failed (its key is the last of `operations`, for recovery), a
   * handler threw, or the round's `signal` was aborted between tools. The
   * run is still returned so no paid round or tool result is lost; resume
   * from `messages` and do not re-run tools whose results are already there.
   */
  error?: unknown;
  /**
   * False: the run stopped early (`error`), or tool calls are pending in the
   * last round and were NOT run — `maxRounds` ran out, or that turn was cut
   * off (`finishReason` `length`, `content_filter`, …) so its arguments may
   * be truncated.
   */
  finished: boolean;
}

/**
 * The tool-call round trip: call the model; while it asks for tools, run
 * each with `handler`, append its result as a `tool` message, and call
 * again. `handler` returns the text the model reads (usually JSON); report
 * a tool's own failure in that text so the model can respond to it.
 *
 * Calls run only from a turn that finished normally (`tool_calls`/`stop`); a
 * turn cut off at `length` ends the run with its calls unrun. A round's
 * `signal`, once aborted, stops the run before the next handler.
 *
 * The run is bound to the session it started in: if the user signs out or
 * switches account (a new `session().generation`), it stops with
 * `error.code` `"signed_out"` (or, from the native plugin's registration
 * check, `"session_changed"`) before the next tool runs or the next call is
 * sent, never carrying one user's history (or charge) to another.
 *
 * A failure never throws away earlier rounds: the run is returned with
 * `error` set (only an invalid `maxRounds` throws).
 *
 * A forcing `tool_choice` (`"required"`, or a named function) applies to the
 * first round only; later rounds send `"auto"`, or the model would be forced
 * to call a tool every round.
 */
export async function runTools(
  client: Client,
  request: ChatRequest,
  handler: (call: ToolCall, context: ToolContext) => string | Promise<string>,
  options: RunToolsOptions,
): Promise<ToolRun> {
  const maxRounds = options.maxRounds ?? 4;
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1)
    failure("invalid_request");
  const messages = [...request.messages];
  const rounds: ToolRound[] = [];
  const operations: ChatOptions[] = [];
  const stopped = (error: unknown): ToolRun => ({
    rounds,
    messages,
    operations,
    error,
    finished: false,
  });
  let start: Session;
  try {
    start = await client.session();
  } catch (error) {
    return stopped(error);
  }
  if (!start.signedIn) return stopped(new SdkError("signed_out"));
  const sameUser = async (): Promise<boolean> => {
    const now = await client.session();
    return (
      now.signedIn &&
      now.generation === start.generation &&
      now.subject === start.subject
    );
  };
  let previous: ChatOptions | undefined;
  for (let round = 0; round < maxRounds; round++) {
    // A cancel during the last handler of the previous round stops the run
    // here, whatever signal the next round's options would carry.
    if (previous?.signal?.aborted) return stopped(new SdkError("cancelled"));
    let toolChoice = request.tool_choice;
    if (
      round > 0 &&
      toolChoice !== undefined &&
      toolChoice !== "auto" &&
      toolChoice !== "none"
    )
      toolChoice = "auto";
    const next: ChatRequest = { ...request, messages: [...messages] };
    if (toolChoice !== undefined) next.tool_choice = toolChoice;
    let operation: ChatOptions, result: ToolRound;
    try {
      operation = await options.operation(round);
      operations.push(operation);
      previous = operation;
      // Pinned: the transport refuses at the moment it takes credentials if
      // the session is no longer the one the run started in.
      result = await collectChat(
        await client.chat(next, {
          ...operation,
          sessionGeneration: start.generation,
        }),
      );
    } catch (error) {
      return stopped(error);
    }
    rounds.push(result);
    if (result.error !== undefined)
      // Kept in `rounds` with its charge; its partial output is not history.
      return stopped(
        new SdkError(result.error, {
          ...(result.callId === undefined ? {} : { callId: result.callId }),
        }),
      );
    messages.push(assistantMessage(result.text, result.toolCalls));
    // Only a turn that finished normally runs its calls: at `length` the
    // last call's arguments can be cut off. (A forced tool_choice can end
    // a complete call turn with `stop`.)
    const runnable =
      result.finishReason === "tool_calls" || result.finishReason === "stop";
    if (result.toolCalls.length === 0 || !runnable || round + 1 === maxRounds)
      break;
    for (const call of result.toolCalls) {
      try {
        if (!(await sameUser())) return stopped(new SdkError("signed_out"));
        // After the await: a cancel that landed during it must still stop
        // the handler.
        if (operation.signal?.aborted)
          return stopped(new SdkError("cancelled"));
        messages.push(
          toolResult(
            call,
            await handler(call, {
              sessionGeneration: start.generation,
              subject: start.subject,
            }),
          ),
        );
      } catch (error) {
        return stopped(error);
      }
    }
  }
  const last = rounds[rounds.length - 1];
  return {
    rounds,
    messages,
    operations,
    finished: last !== undefined && last.toolCalls.length === 0,
  };
}
