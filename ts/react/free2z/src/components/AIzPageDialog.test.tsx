import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import userEvent from "@testing-library/user-event";
import axios from "axios";
import AIzPageDialog from "./AIzPageDialog";

const mockSetLoading = jest.fn();
const mockSetSnackbar = jest.fn();
let keyCounter = 0;

function mockUseGlobalState(key: string) {
  const React = require("react");
  // This mock intentionally mirrors the custom hook's state per component.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [value, setValue] = React.useState(
    key === "loading"
      ? false
      : key === "creator"
      ? { id: 42, username: "alice" }
      : null
  );
  return [
    value,
    (next: unknown) => {
      if (key === "snackbar") mockSetSnackbar(next);
      if (key === "loading") mockSetLoading(next);
      setValue(next);
    },
  ];
}

jest.mock("axios");
jest.mock("../state/global", () => ({
  useGlobalState: mockUseGlobalState,
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const originalStorageSetItem = Storage.prototype.setItem;
const creatorOutputTokens = 4096;
const firstChoice = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "openai",
  model: "gpt-fixture-a",
  display_name: "GPT Fixture A",
  destination: "OpenAI",
  privacy_policy_url: "https://openai.com/policies/privacy-policy/",
  availability: "Configured; checked again at submission.",
  queue: "Processed synchronously; no queue position or SLA.",
};
const secondChoice = {
  ...firstChoice,
  id: "22222222-2222-4222-8222-222222222222",
  provider: "anthropic",
  model: "claude-fixture-b",
  display_name: "Claude Fixture B",
  destination: "Anthropic",
  privacy_policy_url: "https://www.anthropic.com/legal/privacy",
};
const choices = [firstChoice, secondChoice];
const editorState = {
  selectedText: "Summarize the selected paragraph",
  text: "A complete draft.",
  selection: { start: 10, end: 10 },
} as any;

function renderDialog(open = true, taOverride?: any) {
  const ta = taOverride ?? { replaceSelection: jest.fn() };
  const setOpen = jest.fn();
  const view = render(
    <AIzPageDialog state={editorState} ta={ta} open={open} setOpen={setOpen} />
  );
  return { ...view, ta, setOpen };
}

function quote(
  model: string,
  prompt: string,
  maxCharge: number,
  token: string
) {
  return {
    data: {
      model,
      max_output_tokens: creatorOutputTokens,
      requested_output_tokens: creatorOutputTokens,
      max_charge_2z: maxCharge,
      choice: choices.find((choice) => choice.id === model) ?? firstChoice,
      quote_token: token,
      availability: "Configured; checked again during generation.",
      queue: "Processed synchronously; no queue position or SLA.",
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  Storage.prototype.setItem = originalStorageSetItem;
  keyCounter = 0;
  window.localStorage.clear();
  let lockQueue = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      query: async () => ({ held: [], pending: [] }),
      request: (
        _name: string,
        optionsOrCallback: any,
        maybeCallback?: () => Promise<unknown>
      ) => {
        const callback =
          typeof optionsOrCallback === "function"
            ? optionsOrCallback
            : maybeCallback;
        const signal =
          typeof optionsOrCallback === "function"
            ? undefined
            : optionsOrCallback?.signal;
        const result = lockQueue.then(() => {
          if (signal?.aborted) throw new Error("lock request aborted");
          return callback();
        });
        lockQueue = result.then(
          () => undefined,
          () => undefined
        );
        return result;
      },
    },
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      randomUUID: () =>
        `33333333-3333-4333-8333-${String(++keyCounter).padStart(12, "0")}`,
    },
  });
  mockedAxios.get.mockImplementation(
    (url: string) =>
      Promise.resolve({
        data:
          url === "/api/auth/user/"
            ? { id: 42 }
            : { cover: [], completion: choices },
      }) as any
  );
});

test("an ambiguous text request reuses its exact key and body after remount", async () => {
  let generationCalls = 0;
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "stable-quote")
      ) as any;
    generationCalls += 1;
    if (generationCalls === 1)
      return Promise.reject(new TypeError("connection dropped")) as any;
    return Promise.resolve({
      data: {
        response: "The response that completed before the disconnect.",
        display_name: firstChoice.display_name,
        provider: firstChoice.provider,
        model: firstChoice.model,
        tuzis_charged: 5,
      },
    }) as any;
  });

  const { unmount } = renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await waitFor(() => expect(mockSetSnackbar).toHaveBeenCalled());

  const firstCall = mockedAxios.post.mock.calls.find(
    ([url]) => url === "/api/ai/prompt/"
  )!;
  const firstBody = firstCall[1];
  const firstHeaders = firstCall[2]?.headers;
  expect(window.localStorage.length).toBe(1);
  unmount();

  renderDialog();
  const retry = await screen.findByRole("button", {
    name: "Retry original request",
  });
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(retry);

  await waitFor(() => expect(generationCalls).toBe(2));
  const calls = mockedAxios.post.mock.calls.filter(
    ([url]) => url === "/api/ai/prompt/"
  );
  expect(calls[1][1]).toEqual(firstBody);
  expect(calls[1][2]?.headers).toEqual(firstHeaders);
  expect(window.localStorage.length).toBe(1);
  expect(
    JSON.parse(window.localStorage.getItem(window.localStorage.key(0)!)!)
      .completedAt
  ).toEqual(expect.any(Number));
});

test("a paid request is not dispatched after the signed-in account changes", async () => {
  mockedAxios.get.mockImplementation(
    (url: string) =>
      Promise.resolve({
        data:
          url === "/api/auth/user/"
            ? { id: 99 }
            : { cover: [], completion: choices },
      }) as any
  );
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "account-change-quote")
      ) as any;
    throw new TypeError("The saved provider request should not be dispatched");
  });

  renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(
    await screen.findByRole("checkbox", { name: /agree to send/ })
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Get AI Text" })).toBeEnabled()
  );
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));

  await waitFor(() =>
    expect(mockSetSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/account changed/i),
      })
    )
  );
  expect(
    mockedAxios.post.mock.calls.filter(([url]) => url === "/api/ai/prompt/")
  ).toHaveLength(0);
  expect(window.localStorage.length).toBe(1);
});

test("an expired session keeps the paid request key for recovery after sign-in", async () => {
  let authReads = 0;
  mockedAxios.get.mockImplementation((url: string) => {
    if (url === "/api/auth/user/") {
      authReads += 1;
      if (authReads > 1)
        return Promise.reject({
          response: { status: 401, data: { detail: "Sign in again." } },
        }) as any;
      return Promise.resolve({ data: { id: 42 } }) as any;
    }
    return Promise.resolve({ data: { cover: [], completion: choices } }) as any;
  });
  let generationCalls = 0;
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "saved-quote")
      ) as any;
    generationCalls += 1;
    return Promise.reject(new TypeError("connection dropped")) as any;
  });

  renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await waitFor(() => expect(generationCalls).toBe(1));
  expect(window.localStorage.length).toBe(1);

  await userEvent.click(
    screen.getByRole("button", { name: "Retry original request" })
  );
  await waitFor(() => expect(authReads).toBe(2));

  expect(generationCalls).toBe(1);
  expect(window.localStorage.length).toBe(1);
});

test("an empty visible completion reports the charge instead of silent success", async () => {
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 12, "empty-quote")
      ) as any;
    return Promise.resolve({
      data: {
        response: "   ",
        display_name: firstChoice.display_name,
        provider: firstChoice.provider,
        model: firstChoice.model,
        tuzis_charged: 4,
      },
    }) as any;
  });
  const { ta } = renderDialog();
  await screen.findByText(/Maximum hold: 12 2Z/);
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));

  await waitFor(() =>
    expect(mockSetSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/returned no visible text.*cost 4 2Z/i),
        severity: "warning",
      })
    )
  );
  expect(ta.replaceSelection).not.toHaveBeenCalled();
});

test("a saved request can be restored after its model leaves the catalogue", async () => {
  let generationCalls = 0;
  let modelAvailable = true;
  mockedAxios.get.mockImplementation(
    (url: string) =>
      Promise.resolve({
        data:
          url === "/api/auth/user/"
            ? { id: 42 }
            : { cover: [], completion: modelAvailable ? choices : [] },
      }) as any
  );
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/") {
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "stable-quote")
      ) as any;
    }
    generationCalls += 1;
    if (generationCalls === 1)
      return Promise.reject(new TypeError("connection dropped")) as any;
    return Promise.resolve({
      data: {
        response: "The original reply was recovered.",
        display_name: firstChoice.display_name,
        provider: firstChoice.provider,
        model: firstChoice.model,
        tuzis_charged: 5,
      },
    }) as any;
  });

  const { unmount } = renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await waitFor(() => expect(mockSetSnackbar).toHaveBeenCalled());
  const firstCall = mockedAxios.post.mock.calls.find(
    ([url]) => url === "/api/ai/prompt/"
  )!;
  const firstBody = firstCall[1];
  const firstHeaders = firstCall[2]?.headers;
  unmount();

  modelAvailable = false;
  renderDialog();
  await userEvent.click(
    await screen.findByRole("button", { name: "Restore original request" })
  );
  await screen.findByRole("button", { name: "Retry original request" });
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Retry original request" })
  );

  await waitFor(() => expect(generationCalls).toBe(2));
  const calls = mockedAxios.post.mock.calls.filter(
    ([url]) => url === "/api/ai/prompt/"
  );
  expect(calls[1][1]).toEqual(firstBody);
  expect(calls[1][2]?.headers).toEqual(firstHeaders);
  expect(window.localStorage.length).toBe(1);
});

test("a permanently pending transport releases its lock on unmount for exact-key recovery", async () => {
  let generationCalls = 0;
  let firstRequestConfig: any;
  mockedAxios.post.mockImplementation((url: string, body: any, config: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "stable-quote")
      ) as any;
    generationCalls += 1;
    if (generationCalls === 1) {
      firstRequestConfig = config;
      // Deliberately ignore AbortSignal: the component must release its Web
      // Lock even when a transport or test double never settles.
      return new Promise(() => {}) as any;
    }
    return Promise.resolve({
      data: {
        response: "One paid completion shared across tabs.",
        display_name: firstChoice.display_name,
        provider: firstChoice.provider,
        model: firstChoice.model,
        tuzis_charged: 5,
      },
    }) as any;
  });

  const { unmount } = renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await waitFor(() => expect(generationCalls).toBe(1));
  unmount();

  const { ta: retryEditor } = renderDialog();
  await screen.findByRole("button", { name: "Retry original request" });
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Retry original request" })
  );
  await waitFor(() => expect(generationCalls).toBe(2));
  expect(retryEditor.replaceSelection).toHaveBeenCalledWith(
    "One paid completion shared across tabs."
  );
  const calls = mockedAxios.post.mock.calls.filter(
    ([url]) => url === "/api/ai/prompt/"
  );
  expect(generationCalls).toBe(2);
  expect(calls).toHaveLength(2);
  expect(calls[1][1]).toEqual(calls[0][1]);
  expect(calls[1][2]?.headers).toEqual(calls[0][2]?.headers);
  expect(calls[1][2]?.signal).not.toBe(calls[0][2]?.signal);
  expect(firstRequestConfig.timeout).toBeGreaterThan(0);
  expect(firstRequestConfig.signal).toBeInstanceOf(AbortSignal);
  expect(firstRequestConfig.signal.aborted).toBe(true);
  expect(window.localStorage.length).toBe(1);
});

test("a generation timeout keeps the exact intent available for receipt recovery", async () => {
  const requestBodies: any[] = [];
  const requestKeys: string[] = [];
  let generationCalls = 0;
  mockedAxios.post.mockImplementation((url: string, body: any, config: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "stable-quote")
      ) as any;
    generationCalls += 1;
    requestBodies.push(body);
    requestKeys.push(config?.headers?.["Idempotency-Key"]);
    if (generationCalls === 1) return new Promise(() => {}) as any;
    return Promise.resolve({
      data: {
        response: "Recovered from the original paid request.",
        display_name: firstChoice.display_name,
        provider: firstChoice.provider,
        model: firstChoice.model,
        tuzis_charged: 5,
      },
    }) as any;
  });

  const { ta } = renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(screen.getByRole("checkbox"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Get AI Text" })).toBeEnabled()
  );
  jest.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
    await act(async () => {
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });
    expect(generationCalls).toBe(1);

    await act(async () => {
      jest.advanceTimersByTime(180_000);
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });
    expect(mockSetSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/timed out.*retry key was kept/i),
        severity: "error",
      })
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Retry original request" })
    );
    await act(async () => {
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });
    expect(generationCalls).toBe(2);
    expect(requestBodies[1]).toEqual(requestBodies[0]);
    expect(requestKeys[1]).toBe(requestKeys[0]);
    expect(ta.replaceSelection).toHaveBeenCalledWith(
      "Recovered from the original paid request."
    );
  } finally {
    jest.useRealTimers();
  }
});

test("an actor-verification timeout refuses paid dispatch and keeps the intent", async () => {
  let actorReads = 0;
  mockedAxios.get.mockImplementation((url: string) => {
    if (url === "/api/auth/user/") {
      actorReads += 1;
      return new Promise(() => {}) as any;
    }
    return Promise.resolve({ data: { cover: [], completion: choices } }) as any;
  });
  mockedAxios.post.mockImplementation(
    (url: string, body: any) =>
      Promise.resolve(quote(body.model, body.prompt, 7, "stable-quote")) as any
  );

  renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(screen.getByRole("checkbox"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Get AI Text" })).toBeEnabled()
  );
  jest.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
    await act(async () => {
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });
    expect(actorReads).toBe(1);
    expect(
      mockedAxios.post.mock.calls.filter(([url]) => url === "/api/ai/prompt/")
    ).toHaveLength(0);

    await act(async () => {
      jest.advanceTimersByTime(15_000);
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });
    expect(mockSetSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/account verification timed out/i),
        severity: "error",
      })
    );
    expect(
      mockedAxios.post.mock.calls.filter(([url]) => url === "/api/ai/prompt/")
    ).toHaveLength(0);
    expect(window.localStorage.length).toBe(1);
  } finally {
    jest.useRealTimers();
  }
});

test("a delayed retry replays a completion recorded after the retry was loaded", async () => {
  const requestKeys: string[] = [];
  const requestBodies: any[] = [];
  mockedAxios.post.mockImplementation((url: string, body: any, config: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "stable-quote")
      ) as any;
    requestKeys.push(config?.headers?.["Idempotency-Key"]);
    requestBodies.push(body);
    if (requestKeys.length === 1)
      return Promise.reject(new TypeError("connection dropped")) as any;
    return Promise.resolve({
      data: {
        response: "The original paid completion.",
        display_name: firstChoice.display_name,
        provider: firstChoice.provider,
        model: firstChoice.model,
        tuzis_charged: 5,
      },
    }) as any;
  });

  const { ta } = renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await waitFor(() => expect(requestKeys).toHaveLength(1));

  const storageName = window.localStorage.key(0)!;
  const completed = JSON.parse(window.localStorage.getItem(storageName)!);
  completed.completedAt = Date.now() - 10_000;
  completed.insertedAt = Date.now() - 5_000;
  delete completed.completedResponse;
  window.localStorage.setItem(storageName, JSON.stringify(completed));

  await userEvent.click(
    screen.getByRole("button", { name: "Retry original request" })
  );
  await waitFor(() => expect(requestKeys).toHaveLength(2));

  expect(requestKeys[1]).toBe(requestKeys[0]);
  expect(requestBodies[1]).toEqual(requestBodies[0]);
  expect(ta.replaceSelection).toHaveBeenCalledWith(
    "The original paid completion."
  );
});

test("unknown provider outcomes keep their key until the creator acknowledges a new attempt", async () => {
  let generationCalls = 0;
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "stable-quote")
      ) as any;
    generationCalls += 1;
    if (generationCalls === 1)
      return Promise.reject({
        response: {
          status: 409,
          data: {
            code: "provider_outcome_unknown",
            detail:
              "The original text request may have reached its provider. Review your balance before starting a new request.",
          },
        },
      }) as any;
    return Promise.resolve({
      data: {
        response: "The acknowledged new request completed.",
        display_name: firstChoice.display_name,
        provider: firstChoice.provider,
        model: firstChoice.model,
        tuzis_charged: 5,
      },
    }) as any;
  });

  renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  const acknowledgment = await screen.findByRole("button", {
    name: "I checked my balance; allow a new paid attempt",
  });
  const firstCall = mockedAxios.post.mock.calls.find(
    ([url]) => url === "/api/ai/prompt/"
  )!;
  const originalKey = firstCall[2]?.headers?.["Idempotency-Key"];
  await userEvent.click(acknowledgment);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", {
        name: "I checked my balance; allow a new paid attempt",
      })
    ).not.toBeInTheDocument()
  );
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));

  await waitFor(() => expect(generationCalls).toBe(2));
  const calls = mockedAxios.post.mock.calls.filter(
    ([url]) => url === "/api/ai/prompt/"
  );
  expect(calls[1][2]?.headers?.["Idempotency-Key"]).not.toBe(originalKey);
  const archived = Array.from({ length: window.localStorage.length }, (_, i) =>
    window.localStorage.getItem(window.localStorage.key(i)!)
  ).map((value) => JSON.parse(value || "{}"));
  const archive = archived.find((intent) => intent.key === originalKey);
  expect(archive).toBeDefined();
  expect(archive).toHaveProperty("archivedAt", expect.any(Number));
  expect(archive).not.toHaveProperty("body");
  const archiveName = Array.from({ length: window.localStorage.length }, (_, i) =>
    window.localStorage.key(i)!
  ).find((name) => name.includes(":unknown:") && name.endsWith(`:${originalKey}`));
  expect(archiveName).toBe(`f2z:creator-ai-prompt:v1:unknown:42:${originalKey}`);
});

test("a stale unknown-outcome acknowledgement cannot delete a newer paid request", async () => {
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "stable-quote")
      ) as any;
    return Promise.reject({
      response: {
        status: 409,
        data: {
          code: "provider_outcome_unknown",
          detail: "The provider outcome is unknown.",
        },
      },
    }) as any;
  });

  renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await screen.findByRole("button", {
    name: "I checked my balance; allow a new paid attempt",
  });
  const activeName = Array.from(
    { length: window.localStorage.length },
    (_, index) => window.localStorage.key(index)!
  ).find(
    (name) =>
      name.startsWith("f2z:creator-ai-prompt:v1:") &&
      !name.includes(":unknown:")
  )!;
  const newerIntent = JSON.parse(window.localStorage.getItem(activeName)!);
  const staleKey = newerIntent.key;
  newerIntent.key = "66666666-6666-4666-8666-666666666666";
  window.localStorage.setItem(activeName, JSON.stringify(newerIntent));

  const snackbarCallsBeforeAcknowledgement = mockSetSnackbar.mock.calls.length;
  await userEvent.click(
    screen.getByRole("button", {
      name: "I checked my balance; allow a new paid attempt",
    })
  );
  await waitFor(() =>
    expect(mockSetSnackbar).toHaveBeenCalledTimes(
      snackbarCallsBeforeAcknowledgement + 1
    )
  );
  expect(JSON.parse(window.localStorage.getItem(activeName)!).key).toBe(
    "66666666-6666-4666-8666-666666666666"
  );
  expect(staleKey).not.toBe("66666666-6666-4666-8666-666666666666");
});

test("a stale definite-refusal cleanup cannot delete a later retry of the same key", async () => {
  let lockRequest = 0;
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      query: async () => ({ held: [], pending: [] }),
      request: (
        _name: string,
        optionsOrCallback: any,
        maybeCallback?: () => Promise<unknown>
      ) => {
        lockRequest += 1;
        if (lockRequest === 2) {
          const activeName = Array.from(
            { length: window.localStorage.length },
            (_, index) => window.localStorage.key(index)!
          ).find(
            (name) =>
              name.startsWith("f2z:creator-ai-prompt:v1:") &&
              !name.includes(":unknown:")
          )!;
          const laterAttempt = JSON.parse(
            window.localStorage.getItem(activeName)!
          );
          laterAttempt.attemptId = "later-tab-attempt";
          window.localStorage.setItem(activeName, JSON.stringify(laterAttempt));
        }
        const callback =
          typeof optionsOrCallback === "function"
            ? optionsOrCallback
            : maybeCallback;
        return Promise.resolve().then(callback);
      },
    },
  });
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "stable-quote")
      ) as any;
    return Promise.reject({
      response: {
        status: 402,
        data: { detail: "There are not enough 2Z credits." },
      },
    }) as any;
  });

  renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));

  await waitFor(() => expect(lockRequest).toBe(2));
  const activeName = Array.from(
    { length: window.localStorage.length },
    (_, index) => window.localStorage.key(index)!
  ).find(
    (name) =>
      name.startsWith("f2z:creator-ai-prompt:v1:") &&
      !name.includes(":unknown:")
  )!;
  const activeIntent = JSON.parse(window.localStorage.getItem(activeName)!);
  expect(activeIntent.key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(activeIntent.attemptId).toBe("later-tab-attempt");
});

test("a completed reply is saved until insertion into the editor is acknowledged", async () => {
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "stable-quote")
      ) as any;
    return Promise.resolve({
      data: {
        response: "A paid reply survives an editor interruption.",
        display_name: firstChoice.display_name,
        provider: firstChoice.provider,
        model: firstChoice.model,
        tuzis_charged: 5,
      },
    }) as any;
  });

  const failingEditor = {
    replaceSelection: jest.fn(() => {
      throw new Error("editor update interrupted");
    }),
  };
  const { unmount } = renderDialog(true, failingEditor);
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await waitFor(() =>
    expect(failingEditor.replaceSelection).toHaveBeenCalled()
  );
  unmount();

  const recoveredEditor = { replaceSelection: jest.fn() };
  renderDialog(true, recoveredEditor);
  await userEvent.click(
    await screen.findByRole("button", {
      name: "Restore reply (may duplicate)",
    })
  );

  await waitFor(() =>
    expect(recoveredEditor.replaceSelection).toHaveBeenCalledWith(
      "A paid reply survives an editor interruption."
    )
  );
  const saved = JSON.parse(
    window.localStorage.getItem(window.localStorage.key(0)!)!
  );
  expect(saved.insertedAt).toEqual(expect.any(Number));
  expect(
    mockedAxios.post.mock.calls.filter(([url]) => url === "/api/ai/prompt/")
  ).toHaveLength(1);
});

test("an insertion-marker write failure warns before the reply can be restored again", async () => {
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "stable-quote")
      ) as any;
    return Promise.resolve({
      data: {
        response: "The reply was inserted before storage failed.",
        display_name: firstChoice.display_name,
        provider: firstChoice.provider,
        model: firstChoice.model,
        tuzis_charged: 5,
      },
    }) as any;
  });

  const editor = { replaceSelection: jest.fn() };
  const { unmount } = renderDialog(true, editor);
  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (name, value) {
    if (
      name.startsWith("f2z:creator-ai-prompt:v1:") &&
      JSON.parse(String(value)).insertedAt
    )
      throw new DOMException("Storage unavailable", "QuotaExceededError");
    return originalSetItem.call(this, name, value);
  };
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await waitFor(() =>
    expect(editor.replaceSelection).toHaveBeenCalledWith(
      "The reply was inserted before storage failed."
    )
  );
  await waitFor(() =>
    expect(mockSetSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("It may already be in the draft"),
        severity: "warning",
      })
    )
  );
  Storage.prototype.setItem = originalSetItem;
  unmount();

  renderDialog(true, { replaceSelection: jest.fn() });
  await screen.findByText(
    /The GPT Fixture A reply may already be in your draft/
  );
  expect(
    await screen.findByRole("button", {
      name: "Restore reply (may duplicate)",
    })
  ).toBeVisible();
});

test("a stale completed-reply banner cannot overwrite a newer paid request", async () => {
  const actor = "42";
  const prompt = "same saved prompt";
  const identity = `${firstChoice.id}\u0000${prompt}\u0000${creatorOutputTokens}`;
  const storageName = `f2z:creator-ai-prompt:v1:${encodeURIComponent(
    actor
  )}:${encodeURIComponent(identity)}`;
  const completedIntent = {
    key: "55555555-5555-4555-8555-555555555555",
    body: {
      model: firstChoice.id,
      prompt,
      max_output_tokens: creatorOutputTokens,
      quote_token: "saved-quote",
    },
    choice: firstChoice,
    quote: quote(firstChoice.id, prompt, 7, "saved-quote").data,
    completedAt: Date.now(),
    completedResponse: {
      response: "The old completed reply.",
      display_name: firstChoice.display_name,
      provider: firstChoice.provider,
      model: firstChoice.model,
      tuzis_charged: 5,
    },
  };
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "current-quote")
      ) as any;
    return Promise.reject(new Error("unexpected paid request")) as any;
  });
  window.localStorage.setItem(storageName, JSON.stringify(completedIntent));

  const editor = { replaceSelection: jest.fn() };
  renderDialog(true, editor);
  await screen.findByText(/Maximum hold: 7 2Z/);
  const staleRestoreButton = await screen.findByRole("button", {
    name: "Restore completed reply",
  });
  const newerIntent = {
    ...completedIntent,
    key: "66666666-6666-4666-8666-666666666666",
    completedAt: Date.now() + 1,
    completedResponse: {
      ...completedIntent.completedResponse,
      response: "The newer completed reply.",
    },
  };
  window.localStorage.setItem(storageName, JSON.stringify(newerIntent));

  await userEvent.click(staleRestoreButton);
  await waitFor(() =>
    expect(mockSetSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("changed in another tab"),
        severity: "warning",
      })
    )
  );
  expect(editor.replaceSelection).not.toHaveBeenCalled();
  expect(JSON.parse(window.localStorage.getItem(storageName)!).key).toBe(
    newerIntent.key
  );
});

test("a completed private reply is not restored under a changed session", async () => {
  const actor = "42";
  const prompt = "same saved prompt";
  const identity = `${firstChoice.id}\u0000${prompt}\u0000${creatorOutputTokens}`;
  const storageName = `f2z:creator-ai-prompt:v1:${encodeURIComponent(
    actor
  )}:${encodeURIComponent(identity)}`;
  const completedIntent = {
    key: "55555555-5555-4555-8555-555555555555",
    body: {
      model: firstChoice.id,
      prompt,
      max_output_tokens: creatorOutputTokens,
      quote_token: "saved-quote",
    },
    choice: firstChoice,
    quote: quote(firstChoice.id, prompt, 7, "saved-quote").data,
    completedAt: Date.now(),
    completedResponse: {
      response: "Alice's private completed reply.",
      display_name: firstChoice.display_name,
      provider: firstChoice.provider,
      model: firstChoice.model,
      tuzis_charged: 5,
    },
  };
  window.localStorage.setItem(storageName, JSON.stringify(completedIntent));
  mockedAxios.get.mockImplementation(
    (url: string) =>
      Promise.resolve({
        data:
          url === "/api/auth/user/"
            ? { id: 99 }
            : { cover: [], completion: choices },
      }) as any
  );
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "current-quote")
      ) as any;
    throw new TypeError("Restoring a completed reply must not send a request");
  });

  const editor = { replaceSelection: jest.fn() };
  renderDialog(true, editor);
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(
    await screen.findByRole("button", { name: "Restore completed reply" })
  );

  await waitFor(() =>
    expect(mockSetSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("changed in another tab"),
        severity: "warning",
      })
    )
  );
  expect(editor.replaceSelection).not.toHaveBeenCalled();
  expect(JSON.parse(window.localStorage.getItem(storageName)!)).toEqual(
    completedIntent
  );
});

test("retrying a cached completed reply verifies the current session", async () => {
  const actor = "42";
  const prompt = "Summarize the selected paragraph";
  const identity = `${firstChoice.id}\u0000${prompt}\u0000${creatorOutputTokens}`;
  const storageName = `f2z:creator-ai-prompt:v1:${encodeURIComponent(
    actor
  )}:${encodeURIComponent(identity)}`;
  const completedIntent = {
    key: "77777777-7777-4777-8777-777777777777",
    body: {
      model: firstChoice.id,
      prompt,
      max_output_tokens: creatorOutputTokens,
      quote_token: "saved-quote",
    },
    choice: firstChoice,
    quote: quote(firstChoice.id, prompt, 7, "saved-quote").data,
    completedAt: Date.now(),
    completedResponse: {
      response: "Alice's private completed reply.",
      display_name: firstChoice.display_name,
      provider: firstChoice.provider,
      model: firstChoice.model,
      tuzis_charged: 5,
    },
  };
  window.localStorage.setItem(storageName, JSON.stringify(completedIntent));
  mockedAxios.get.mockImplementation(
    (url: string) =>
      Promise.resolve({
        data:
          url === "/api/auth/user/"
            ? { id: 99 }
            : { cover: [], completion: choices },
      }) as any
  );
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "current-quote")
      ) as any;
    throw new TypeError("Retrying a cached reply must not send a request");
  });

  const editor = { replaceSelection: jest.fn() };
  render(
    <AIzPageDialog
      state={{ ...editorState, selectedText: prompt }}
      ta={editor as any}
      open
      setOpen={jest.fn()}
    />
  );
  await screen.findByText(/Retrying the original quote: maximum hold 7 2Z/);
  await userEvent.click(
    await screen.findByRole("checkbox", { name: /agree to send/ })
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Retry original request" })
  );

  await waitFor(() =>
    expect(mockSetSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/account changed/i),
      })
    )
  );
  expect(editor.replaceSelection).not.toHaveBeenCalled();
  expect(JSON.parse(window.localStorage.getItem(storageName)!)).toEqual(
    completedIntent
  );
});

test("resolved prompt records are bounded while unresolved recovery records remain", async () => {
  const actor = "42";
  const storedNames: string[] = [];
  for (let index = 0; index < 13; index += 1) {
    const identity = `${firstChoice.id}\u0000saved prompt ${index}\u0000${creatorOutputTokens}`;
    const name = `f2z:creator-ai-prompt:v1:${encodeURIComponent(
      actor
    )}:${encodeURIComponent(identity)}`;
    storedNames.push(name);
    window.localStorage.setItem(
      name,
      JSON.stringify({
        key: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
        body: {
          model: firstChoice.id,
          prompt: `saved prompt ${index}`,
          max_output_tokens: creatorOutputTokens,
          quote_token: `saved-quote-${index}`,
        },
        choice: firstChoice,
        quote: quote(
          firstChoice.id,
          `saved prompt ${index}`,
          7,
          `saved-quote-${index}`
        ).data,
        completedAt: 10 + index,
        insertedAt: 20 + index,
      })
    );
  }
  const unresolvedIdentity = `${firstChoice.id}\u0000unresolved prompt\u0000${creatorOutputTokens}`;
  const unresolvedName = `f2z:creator-ai-prompt:v1:${encodeURIComponent(
    actor
  )}:${encodeURIComponent(unresolvedIdentity)}`;
  window.localStorage.setItem(
    unresolvedName,
    JSON.stringify({
      key: "55555555-5555-4555-8555-555555555555",
      body: {
        model: firstChoice.id,
        prompt: "unresolved prompt",
        max_output_tokens: creatorOutputTokens,
        quote_token: "unresolved-quote",
      },
      choice: firstChoice,
      quote: quote(firstChoice.id, "unresolved prompt", 7, "unresolved-quote")
        .data,
    })
  );
  let racedActiveIntent = false;
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      query: async () => ({ held: [], pending: [] }),
      request: (name: string, optionsOrCallback: any, maybeCallback?: any) => {
        if (typeof optionsOrCallback === "function") return optionsOrCallback();
        if (optionsOrCallback?.ifAvailable && !racedActiveIntent) {
          racedActiveIntent = true;
          const active = JSON.parse(window.localStorage.getItem(name)!);
          active.key = "66666666-6666-4666-8666-666666666666";
          delete active.completedAt;
          delete active.insertedAt;
          window.localStorage.setItem(name, JSON.stringify(active));
          return maybeCallback(null);
        }
        return maybeCallback({ name });
      },
    },
  });
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "new-quote")
      ) as any;
    return Promise.resolve({
      data: {
        response: "New response",
        display_name: firstChoice.display_name,
        provider: firstChoice.provider,
        model: firstChoice.model,
        tuzis_charged: 5,
      },
    }) as any;
  });

  renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await waitFor(() =>
    expect(
      mockedAxios.post.mock.calls.filter(([url]) => url === "/api/ai/prompt/")
    ).toHaveLength(1)
  );

  const remainingCompleted = Array.from(
    { length: window.localStorage.length },
    (_, index) => window.localStorage.key(index)!
  ).filter((name) => {
    if (!name.startsWith("f2z:creator-ai-prompt:v1:")) return false;
    return Boolean(JSON.parse(window.localStorage.getItem(name)!).insertedAt);
  });
  expect(remainingCompleted.length).toBeLessThanOrEqual(12);
  const racedIntent = JSON.parse(window.localStorage.getItem(storedNames[0])!);
  expect(racedIntent.key).toBe("66666666-6666-4666-8666-666666666666");
  expect(racedIntent.insertedAt).toBeUndefined();
  expect(window.localStorage.getItem(storedNames[1])).toBeNull();
  expect(window.localStorage.getItem(unresolvedName)).not.toBeNull();
});

test("text model flow discloses the quote, retries the exact request, then requires consent for fallback", async () => {
  let generationCalls = 0;
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/") {
      return Promise.resolve(
        quote(
          body.model,
          body.prompt,
          body.model === firstChoice.id ? 7 : 12,
          `quote-${body.model}`
        )
      ) as any;
    }
    generationCalls += 1;
    if (generationCalls < 3) {
      return Promise.reject({
        response: { status: 503, data: { detail: "Model busy" } },
      }) as any;
    }
    return Promise.resolve({
      data: {
        response: "A concise completion.",
        display_name: secondChoice.display_name,
        provider: secondChoice.provider,
        model: secondChoice.model,
        tuzis_charged: 9,
      },
    }) as any;
  });

  const { ta, setOpen } = renderDialog();
  const generate = await screen.findByRole("button", { name: "Get AI Text" });
  await screen.findByText(
    "Free2Z AI · Prompt sent to OpenAI · openai / gpt-fixture-a"
  );
  await screen.findByText(/Maximum hold: 7 2Z/);
  expect(screen.getByText(firstChoice.queue)).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Provider privacy policy" })
  ).toHaveAttribute("href", firstChoice.privacy_policy_url);

  const consent = screen.getByRole("checkbox", {
    name: "I agree to send this prompt to OpenAI under the displayed pricing and provider policy.",
  });
  expect(generate).toBeDisabled();
  await userEvent.click(consent);
  expect(generate).toBeEnabled();
  await userEvent.click(generate);
  await waitFor(() =>
    expect(mockSetSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Model busy", severity: "error" })
    )
  );

  const firstGenerationCall = mockedAxios.post.mock.calls.find(
    ([url]) => url === "/api/ai/prompt/"
  );
  expect(firstGenerationCall).toBeDefined();
  const firstBody = firstGenerationCall![1];
  const firstHeaders = firstGenerationCall![2]?.headers;
  const retryButton = screen.getByRole("button", {
    name: "Retry original request",
  });
  await waitFor(() => expect(retryButton).toBeEnabled());
  await userEvent.click(retryButton);
  await waitFor(() => expect(mockSetSnackbar).toHaveBeenCalledTimes(2));
  const generationCallsMade = mockedAxios.post.mock.calls.filter(
    ([url]) => url === "/api/ai/prompt/"
  );
  expect(generationCallsMade[1][1]).toEqual(firstBody);
  expect(generationCallsMade[1][2]?.headers).toEqual(firstHeaders);

  await userEvent.click(screen.getByRole("combobox", { name: "Text model" }));
  await userEvent.click(
    await screen.findByRole("option", { name: /Claude Fixture B/ })
  );
  await screen.findByText(/Maximum hold: 12 2Z/);
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(generate).toBeDisabled();
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "I agree to send this prompt to Anthropic under the displayed pricing and provider policy.",
    })
  );
  await userEvent.click(generate);

  await waitFor(() =>
    expect(ta.replaceSelection).toHaveBeenCalledWith("A concise completion.")
  );
  expect(setOpen).toHaveBeenCalledWith(false);
  expect(mockSetSnackbar).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining(
        "Claude Fixture B (anthropic / claude-fixture-b) · charged 9 2Z"
      ),
      severity: "success",
    })
  );
  const fallbackCall = mockedAxios.post.mock.calls.filter(
    ([url]) => url === "/api/ai/prompt/"
  )[2];
  expect(fallbackCall[1]).toMatchObject({
    model: secondChoice.id,
    quote_token: `quote-${secondChoice.id}`,
  });
  expect(fallbackCall[2]?.headers?.["Idempotency-Key"]).not.toBe(
    firstHeaders?.["Idempotency-Key"]
  );
});

test("a same-id catalogue refresh changes the disclosure and clears prior consent", async () => {
  mockedAxios.post.mockImplementation(
    (url: string, body: any) =>
      Promise.resolve(
        quote(body.model, body.prompt, 7, "quote-before-refresh")
      ) as any
  );
  mockedAxios.get
    .mockResolvedValueOnce({
      data: { cover: [], completion: [firstChoice] },
    } as any)
    .mockResolvedValueOnce({
      data: {
        cover: [],
        completion: [
          {
            ...firstChoice,
            provider: "anthropic",
            model: "claude-fixture-updated",
            display_name: "Updated same-id model",
            destination: "Anthropic",
            privacy_policy_url: "https://www.anthropic.com/legal/privacy",
          },
        ],
      },
    } as any);
  const view = renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("checkbox")).toBeChecked();

  view.rerender(
    <AIzPageDialog
      state={editorState}
      ta={view.ta}
      open={false}
      setOpen={view.setOpen}
    />
  );
  view.rerender(
    <AIzPageDialog
      state={editorState}
      ta={view.ta}
      open={true}
      setOpen={view.setOpen}
    />
  );

  await screen.findByText(
    "Free2Z AI · Prompt sent to Anthropic · anthropic / claude-fixture-updated"
  );
  await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
  expect(mockedAxios.get).toHaveBeenCalledTimes(2);
});

test("a late quote for an older prompt cannot replace the current prompt quote", async () => {
  let resolveOld!: (value: any) => void;
  let resolveCurrent!: (value: any) => void;
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url !== "/api/ai/creator-options/")
      return Promise.resolve({ data: {} }) as any;
    return new Promise((resolve) => {
      if (body.prompt === "Summarize the selected paragraph")
        resolveOld = resolve;
      else resolveCurrent = resolve;
    }) as any;
  });
  renderDialog();
  const prompt = await screen.findByRole("textbox", { name: "Prompt" });
  await waitFor(() => expect(resolveOld).toBeDefined());
  fireEvent.change(prompt, { target: { value: "The newer prompt" } });
  await waitFor(() => expect(resolveCurrent).toBeDefined());
  resolveCurrent(quote(firstChoice.id, "The newer prompt", 22, "quote-new"));
  await screen.findByText(/Maximum hold: 22 2Z/);
  resolveOld(
    quote(firstChoice.id, "Summarize the selected paragraph", 4, "quote-old")
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.getByText(/Maximum hold: 22 2Z/)).toBeVisible();
  expect(screen.queryByText(/Maximum hold: 4 2Z/)).not.toBeInTheDocument();
});

test("retiring a refused original quote requires consent to the higher displayed quote", async () => {
  let nextPrice = 7;
  let generationCalls = 0;
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, nextPrice, `quote-${nextPrice}`)
      ) as any;
    generationCalls += 1;
    return generationCalls === 1
      ? (Promise.reject(new TypeError("connection dropped")) as any)
      : (Promise.reject({
          response: {
            status: 409,
            data: { code: "quote_changed", detail: "Quote expired" },
          },
        }) as any);
  });
  const { unmount } = renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await waitFor(() => expect(mockSetSnackbar).toHaveBeenCalled());
  unmount();
  nextPrice = 12;
  renderDialog();
  await screen.findByText(/Retrying the original quote: maximum hold 7 2Z/);
  await waitFor(() =>
    expect(
      mockedAxios.post.mock.calls.filter(
        ([url]) => url === "/api/ai/creator-options/"
      )
    ).toHaveLength(2)
  );
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(
    screen.getByRole("button", { name: "Retry original request" })
  );
  await screen.findByText(/Maximum hold: 12 2Z/);
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Get AI Text" })).toBeDisabled();
  expect(generationCalls).toBe(2);
});

test("a quote displays its exact provider even before catalogue refresh", async () => {
  const changedChoice = { ...secondChoice, id: firstChoice.id };
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/") {
      const response = quote(body.model, body.prompt, 12, "new-provider");
      response.data.choice = changedChoice;
      return Promise.resolve(response) as any;
    }
    return Promise.reject(new TypeError("lost response")) as any;
  });
  renderDialog();
  await screen.findByText(/Maximum hold: 12 2Z/);
  expect(
    screen.getByRole("checkbox", { name: /send this prompt to Anthropic/ })
  ).not.toBeChecked();
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await waitFor(() =>
    expect(
      mockedAxios.post.mock.calls.filter(([url]) => url === "/api/ai/prompt/")
    ).toHaveLength(1)
  );
  const stored = Array.from(
    { length: localStorage.length },
    (_, i) => localStorage.key(i)!
  ).find((key) => key.startsWith("f2z:creator-ai-prompt:v1:"))!;
  expect(JSON.parse(localStorage.getItem(stored)!).choice.provider).toBe(
    "anthropic"
  );
});

test("adopting another tab's more expensive request requires renewed consent", async () => {
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "old-quote")
      ) as any;
    return Promise.reject(new TypeError("lost response")) as any;
  });
  renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(screen.getByRole("checkbox"));
  const prompt = editorState.selectedText;
  const identity = `${firstChoice.id}\u0000${prompt}\u0000${creatorOutputTokens}`;
  const storageName = `f2z:creator-ai-prompt:v1:42:${encodeURIComponent(
    identity
  )}`;
  const newer = {
    key: "77777777-7777-4777-8777-777777777777",
    choice: firstChoice,
    quote: quote(firstChoice.id, prompt, 12, "new-quote").data,
    body: {
      model: firstChoice.id,
      prompt,
      max_output_tokens: creatorOutputTokens,
      quote_token: "new-quote",
    },
  };
  localStorage.setItem(storageName, JSON.stringify(newer));
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await screen.findByText(/Retrying the original quote: maximum hold 12 2Z/);
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(
    mockedAxios.post.mock.calls.filter(([url]) => url === "/api/ai/prompt/")
  ).toHaveLength(0);
  expect(JSON.parse(localStorage.getItem(storageName)!).key).toBe(newer.key);
});

test("recovering an empty completed reply preserves the selected draft text", async () => {
  const prompt = editorState.selectedText;
  const identity = `${firstChoice.id}\u0000${prompt}\u0000${creatorOutputTokens}`;
  const storageName = `f2z:creator-ai-prompt:v1:42:${encodeURIComponent(
    identity
  )}`;
  const completed = {
    key: "77777777-7777-4777-8777-777777777777",
    choice: firstChoice,
    quote: quote(firstChoice.id, prompt, 7, "saved-quote").data,
    body: {
      model: firstChoice.id,
      prompt,
      max_output_tokens: creatorOutputTokens,
      quote_token: "saved-quote",
    },
    completedAt: Date.now(),
    completedResponse: {
      response: "   ",
      display_name: firstChoice.display_name,
      provider: firstChoice.provider,
      model: firstChoice.model,
      tuzis_charged: 5,
    },
  };
  localStorage.setItem(storageName, JSON.stringify(completed));
  mockedAxios.post.mockImplementation((url: string, body: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "saved-quote")
      ) as any;
    throw new Error("Cached reply must not dispatch");
  });
  const { ta } = renderDialog();
  await screen.findByText(/Retrying the original quote/);
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(
    screen.getByRole("button", { name: "Retry original request" })
  );
  await waitFor(() =>
    expect(
      JSON.parse(localStorage.getItem(storageName)!).insertedAt
    ).toBeTruthy()
  );
  expect(ta.replaceSelection).not.toHaveBeenCalled();
});

test("a settled interrupted reply requires fresh consent and a new request key", async () => {
  let generationCalls = 0;
  const keys: string[] = [];
  mockedAxios.post.mockImplementation((url: string, body: any, config: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, 7, "quote-7")
      ) as any;
    keys.push(config.headers["Idempotency-Key"]);
    generationCalls += 1;
    return Promise.reject({
      response: {
        status: 503,
        data: {
          detail: "Generation interrupted. 2 2Z charged; no response saved.",
          charge_status: "settled",
          tuzis_charged: 2,
          response_saved: false,
        },
      },
    }) as any;
  });
  const { ta } = renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await waitFor(() => expect(mockSetSnackbar).toHaveBeenCalled());
  expect(ta.replaceSelection).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Get AI Text" })).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await waitFor(() => expect(generationCalls).toBe(2));
  expect(keys[1]).not.toBe(keys[0]);
});

test("an inserted completed receipt does not block a new quote for the same prompt", async () => {
  let nextPrice = 7;
  const keys: string[] = [];
  mockedAxios.post.mockImplementation((url: string, body: any, config: any) => {
    if (url === "/api/ai/creator-options/")
      return Promise.resolve(
        quote(body.model, body.prompt, nextPrice, `quote-${nextPrice}`)
      ) as any;
    keys.push(config.headers["Idempotency-Key"]);
    return Promise.resolve({
      data: {
        response: "Completed reply",
        tuzis_charged: 2,
        provider: "openai",
        model: firstChoice.model,
        display_name: firstChoice.display_name,
      },
    }) as any;
  });
  const first = renderDialog();
  await screen.findByText(/Maximum hold: 7 2Z/);
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await waitFor(() =>
    expect(first.ta.replaceSelection).toHaveBeenCalledWith("Completed reply")
  );
  first.unmount();
  nextPrice = 12;
  const second = renderDialog();
  await screen.findByText(/Maximum hold: 12 2Z/);
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "Get AI Text" }));
  await waitFor(() =>
    expect(second.ta.replaceSelection).toHaveBeenCalledWith("Completed reply")
  );
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]);
});
