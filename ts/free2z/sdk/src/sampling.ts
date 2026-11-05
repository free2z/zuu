import type { ChatRequest } from "./types.js";
import { sampling } from "./json.js";

/** Optional generation controls. Omitted fields retain the provider default. */
export type SamplingControls = Pick<
  ChatRequest,
  | "temperature"
  | "top_p"
  | "top_k"
  | "stop"
  | "seed"
  | "logprobs"
  | "top_logprobs"
  | "frequency_penalty"
  | "presence_penalty"
  | "n"
>;

/** Build a request with validated sampling shape. The gateway checks model support. */
export function withSampling(
  request: ChatRequest,
  controls: SamplingControls,
): ChatRequest {
  return sampling({ ...request, ...controls });
}
