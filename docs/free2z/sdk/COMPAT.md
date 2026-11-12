# OpenAI-compatible clients

The signed catalogue does not include model creation times. The compatibility
models projection therefore uses `created: 0` as a deterministic unknown
sentinel; it does not represent the model or catalogue creation time.

Use the AI gateway base URL `https://ai.free2z.cash/v1` and an access token
with `ai:invoke`. For JavaScript applications signed in with `@free2z/sdk`,
use `client.compatFetch()` as the client's custom fetch so that the SDK injects
and refreshes the short-lived token. It only sends tokens to the configured AI
base URL.

```ts
import OpenAI from "openai";
const openai = new OpenAI({
  baseURL: "https://ai.free2z.cash/v1",
  apiKey: "injected-by-compat-fetch",
  fetch: client.compatFetch(),
  maxRetries: 0,
});
// Save this key with the logical operation and reuse it on any retry.
const key = crypto.randomUUID();
const stream = await openai.chat.completions.create({
  model: "your-catalogue-model", messages: [{ role: "user", content: "Hello" }], stream: true,
}, { headers: { "Idempotency-Key": key } });
```

The Vercel AI SDK's `createOpenAI` and LangChain's `ChatOpenAI` also accept a
custom fetch in their configuration; supply the same base URL and fetch. Set
an idempotency key for each logical call and reuse it for retries. A completed
replay returns 410 with the call record rather than a retained completion.
Prefer streaming: after the hold, failures arrive inside the stream. For
non-streaming calls disable automatic retries unless the client reliably
reuses the same idempotency key.

Python applications can use `OpenAI(base_url="https://ai.free2z.cash/v1",
api_key=access_token, max_retries=0)` with a freshly obtained access token.
A long-running application should provide an `httpx.Auth` implementation that
obtains and refreshes its own access token; do not embed a long-lived token in
source code.

For Vercel AI SDK and LangChain, the equivalent configuration is:

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { ChatOpenAI } from "@langchain/openai";
import { streamText } from "ai";
// Construct per logical call, retaining the key if the operation is retried.
const key = crypto.randomUUID();
const provider = createOpenAI({ baseURL: "https://ai.free2z.cash/v1", apiKey: "injected", fetch: client.compatFetch(), headers: { "Idempotency-Key": key } });
const result = streamText({ model: provider.chat("your-catalogue-model"), prompt: "Hello", maxRetries: 0 });
// A different logical call gets its own key.
const langchainKey = crypto.randomUUID();
const langchain = new ChatOpenAI({ model: "your-catalogue-model", apiKey: "injected", maxRetries: 0,
  configuration: { baseURL: "https://ai.free2z.cash/v1", fetch: client.compatFetch(), defaultHeaders: { "Idempotency-Key": langchainKey } } });
const output = await langchain.invoke("Hello");
```

A Python token source can be connected through `httpx.Auth`. The function
below must obtain a current token from the application's own secure session;
it must refresh expired tokens before returning them:

```python
import httpx
from openai import OpenAI

class Free2ZAuth(httpx.Auth):
    def auth_flow(self, request):
        request.headers["Authorization"] = f"Bearer {current_access_token()}"
        yield request

http = httpx.Client(auth=Free2ZAuth())
client = OpenAI(base_url="https://ai.free2z.cash/v1", api_key="injected",
                http_client=http, max_retries=0)
# Persist key with this logical operation and reuse it for retries.
key = "your-stable-operation-key"
response = client.chat.completions.create(
    model="your-catalogue-model", messages=[{"role": "user", "content": "Hello"}],
    stream=True, extra_headers={"Idempotency-Key": key})
```

The current unified protocol has no `developer` role, file content part, or
image `detail` member. These are refused by this encoding until the native S2
and S5 protocol and provider translations exist; mapping them to a different
role or silently dropping detail would change the request. `name` on a message,
legacy functions, hosted tools, audio, prediction, and remote image URLs are
also refused. The gateway's current privacy baseline refuses caller metadata;
`user`, `safety_identifier`, and `prompt_cache_key` are therefore refused
rather than retained or forwarded. `store: false` and `n: 1` are accepted.

The request feature record does not yet identify the compatibility encoding:
`features.api` requires the versioned ledger feature schema from S11
([#1159](https://github.com/free2z/zuu/issues/1159)). The existing ledger
validator accepts the current fixed feature members, as described in
`rs/crates/f2z-ai/src/features.rs`; emitting `api` to it would reject claims.
Developer role support belongs to S2 ([#1149](https://github.com/free2z/zuu/issues/1149)),
and file parts and image detail belong to S5
([#1155](https://github.com/free2z/zuu/issues/1155)).
