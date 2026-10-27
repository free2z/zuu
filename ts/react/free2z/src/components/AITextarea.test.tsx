import React, { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import AITextarea from "./AITextarea";
import { generationIsCurrent, reducer, type AIState } from "../aiState";

const mockNavigate = jest.fn();
const mockCreator = { id: 1 };
const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(window, "crypto");

afterEach(() => {
  if (originalCryptoDescriptor) {
    Object.defineProperty(window, "crypto", originalCryptoDescriptor);
  } else {
    delete (window as any).crypto;
  }
});

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));
jest.mock("react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock("@mui/material", () => ({
  TextField: (props: any) => require("react").createElement("textarea", {
    "data-testid": "prompt-input",
    value: props.value,
    onChange: props.onChange,
    onKeyDown: props.onKeyDown,
  }),
  IconButton: () => null,
  InputAdornment: () => null,
  Stack: () => null,
}));
jest.mock("@mui/icons-material", () => ({ Send: () => null }));
jest.mock("./AIEditConversation", () => ({ __esModule: true, default: () => null }));
jest.mock("../state/global", () => ({
  useGlobalState: (key: string) => key === "creator"
    ? [mockCreator, jest.fn()]
    : [null, jest.fn()],
}));
jest.mock("../hooks/useTransitionNavigate", () => ({
  useTransitionNavigate: () => mockNavigate,
}));

test("first chat stores its retry key and navigates before the billable POST", async () => {
  window.sessionStorage.clear();
  mockNavigate.mockClear();
  let onSocketOpen: (() => void) | null = null;
  let storedAtPromptPost: string | null = null;
  const post = axios.post as jest.Mock;
  post.mockReset();
  post.mockImplementation((url: string) => {
    if (url === "/api/ai/conversations/") {
      return Promise.resolve({ data: { id: "conversation-a" } });
    }
    storedAtPromptPost = window.sessionStorage.getItem(
      "f2z:ai-pending-generation:1:conversation-a",
    );
    return Promise.resolve({
      data: { id: "response-a", user_input: "hello", response: "hi" },
    });
  });
  Object.defineProperty(window, "crypto", {
    configurable: true,
    value: { randomUUID: () => "generation-a" },
  });

  const state = {
    currentConversation: {} as AIState["currentConversation"],
    promptResponses: [],
    currentResponse: "",
    currentInput: "",
    selectedModel: "model-a",
    selectedPersonality: "",
    websocket: null,
    autoScroll: true,
    textAreaHeight: 0,
    activeGenerationId: null,
  } satisfies AIState;

  const connect = jest.fn((_conversationId: string, callback: (() => void) | null) => {
    onSocketOpen = callback;
  });
  const dispatch = jest.fn();
  render(
    <AITextarea
      selectedModel="model-a"
      state={state}
      dispatch={dispatch}
      connect={connect}
      isCurrentGeneration={() => true}
    />,
  );

  fireEvent.change(screen.getByTestId("prompt-input"), {
    target: { value: "hello" },
  });
  fireEvent.keyDown(screen.getByTestId("prompt-input"), { key: "Enter" });
  await waitFor(() => expect(connect).toHaveBeenCalledWith(
    "conversation-a",
    expect.any(Function),
  ));

  act(() => onSocketOpen?.());

  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(storedAtPromptPost).not.toBeNull();
  expect(storedAtPromptPost).toContain('"key":"generation-a"');
  expect(storedAtPromptPost).toContain('"accountId":"1"');
  expect(mockNavigate).toHaveBeenCalledWith("/ai/conversation-a");
  expect(mockNavigate.mock.invocationCallOrder[0]).toBeLessThan(
    post.mock.invocationCallOrder[1],
  );
});

test("generic HTTP 400 retains the key; explicit application refusal releases it", async () => {
  window.sessionStorage.clear();
  mockCreator.id = 7;
  let keyNumber = 0;
  Object.defineProperty(window, "crypto", {
    configurable: true,
    value: { randomUUID: () => `generation-${++keyNumber}` },
  });
  const post = axios.post as jest.Mock;
  post.mockReset();
  post
    .mockRejectedValueOnce({
      response: { status: 400, data: { detail: "Bad Request" } },
    })
    .mockRejectedValueOnce({
      response: {
        status: 400,
        data: {
          detail: "Prompt exceeds this model's input budget.",
          charge_status: "not_charged",
          tuzis_charged: 0,
        },
      },
    })
    .mockResolvedValue({ data: { id: "response-a" } });
  const state = {
    currentConversation: { id: "conversation-400" } as AIState["currentConversation"],
    promptResponses: [],
    currentResponse: "",
    currentInput: "",
    selectedModel: "model-a",
    selectedPersonality: "",
    websocket: null,
    autoScroll: true,
    textAreaHeight: 0,
    activeGenerationId: null,
  } satisfies AIState;
  render(
    <AITextarea
      selectedModel="model-a"
      conversationId="conversation-400"
      state={state}
      dispatch={jest.fn()}
      connect={jest.fn()}
      isCurrentGeneration={() => true}
    />,
  );
  const input = screen.getByTestId("prompt-input");
  const submit = async (calls: number) => {
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(calls));
  };
  const requestKey = (index: number) => post.mock.calls[index][2].headers["Idempotency-Key"];

  await submit(1);
  const originalKey = requestKey(0);
  await submit(2);
  expect(requestKey(1)).toBe(originalKey);

  // The application identifies this specific refusal as definitely free;
  // after it clears the claim, the next request can use a fresh key.
  await submit(3);
  expect(requestKey(2)).not.toBe(originalKey);
});

test("a stale no-charge response cannot clear a newer attempt with the same key", async () => {
  window.sessionStorage.clear();
  mockCreator.id = 47;
  let keyNumber = 0;
  Object.defineProperty(window, "crypto", {
    configurable: true,
    value: { randomUUID: () => `generation-${++keyNumber}` },
  });
  const post = axios.post as jest.Mock;
  post.mockReset();
  const pendingPosts: Array<{
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = [];
  post.mockImplementation(() => new Promise((resolve, reject) => {
    pendingPosts.push({ resolve, reject });
  }));
  const conversationId = "conversation-delayed-refusal";
  const state = {
    currentConversation: { id: conversationId } as AIState["currentConversation"],
    promptResponses: [],
    currentResponse: "",
    currentInput: "",
    selectedModel: "model-a",
    selectedPersonality: "",
    websocket: null,
    autoScroll: true,
    textAreaHeight: 0,
    activeGenerationId: null,
  } satisfies AIState;
  const props = () => ({
    selectedModel: "model-a",
    conversationId,
    state,
    dispatch: jest.fn(),
    connect: jest.fn(),
    isCurrentGeneration: () => true,
  });
  const requestKey = (index: number) =>
    post.mock.calls[index][2].headers["Idempotency-Key"];
  const submit = async (calls: number) => {
    const input = screen.getByTestId("prompt-input");
    fireEvent.change(input, { target: { value: "same prompt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(calls));
  };

  let view = render(<AITextarea {...props()} />);
  await submit(1);
  const originalKey = requestKey(0);

  // The first attempt's server refusal is delayed. A remounted component
  // retries the released claim under the same key, but loses that response.
  view.unmount();
  view = render(<AITextarea {...props()} />);
  await submit(2);
  expect(requestKey(1)).toBe(originalKey);
  await act(async () => pendingPosts[1].reject(new Error("connection lost")));
  await act(async () => pendingPosts[0].reject({
    response: {
      status: 402,
      data: { charge_status: "not_charged", tuzis_charged: 0 },
    },
  }));

  view.unmount();
  view = render(<AITextarea {...props()} />);
  await submit(3);
  expect(requestKey(2)).toBe(originalKey);
  const stored = JSON.parse(window.sessionStorage.getItem(
    `f2z:ai-pending-generation:${mockCreator.id}:${conversationId}`,
  ) || "{}");
  expect(stored.key).toBe(originalKey);
  await act(async () => pendingPosts[2].reject(new Error("connection lost")));
});

test("switching conversations restores that conversation's unresolved prompt", async () => {
  window.sessionStorage.clear();
  mockCreator.id = 2;
  let keyNumber = 0;
  Object.defineProperty(window, "crypto", {
    configurable: true,
    value: { randomUUID: () => `generation-${++keyNumber}` },
  });
  const post = axios.post as jest.Mock;
  post.mockReset();
  post.mockRejectedValue(new Error("connection lost"));
  const conversationState = (id: string): AIState => ({
    currentConversation: { id } as AIState["currentConversation"],
    promptResponses: [],
    currentResponse: "",
    currentInput: "",
    selectedModel: "model-a",
    selectedPersonality: "",
    websocket: null,
    autoScroll: true,
    textAreaHeight: 0,
    activeGenerationId: null,
  });
  const dispatch = jest.fn();
  const connect = jest.fn();
  const props = (conversationId: string): React.ComponentProps<typeof AITextarea> => ({
    selectedModel: "model-a",
    conversationId,
    state: conversationState(conversationId),
    dispatch,
    connect,
    isCurrentGeneration: () => true,
  });
  const { rerender } = render(<AITextarea {...props("conversation-a")} />);
  const input = screen.getByTestId("prompt-input");

  fireEvent.change(input, { target: { value: "prompt A" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

  rerender(<AITextarea {...props("conversation-b")} />);
  fireEvent.change(input, { target: { value: "prompt B" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));

  rerender(<AITextarea {...props("conversation-a")} />);
  fireEvent.change(input, { target: { value: "another prompt" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => {
    expect((input as HTMLTextAreaElement).value).toBe("prompt A");
  });
  expect(post).toHaveBeenCalledTimes(2);
});

test("mints a UUIDv4 when crypto.randomUUID is unavailable", async () => {
  window.sessionStorage.clear();
  mockCreator.id = 6;
  const originalCrypto = window.crypto;
  Object.defineProperty(window, "crypto", {
    configurable: true,
    value: {},
  });
  const post = axios.post as jest.Mock;
  post.mockReset();
  post.mockResolvedValue({ data: { id: "response-a" } });
  const state = {
    currentConversation: { id: "conversation-uuid-fallback" } as AIState["currentConversation"],
    promptResponses: [],
    currentResponse: "",
    currentInput: "",
    selectedModel: "model-a",
    selectedPersonality: "",
    websocket: null,
    autoScroll: true,
    textAreaHeight: 0,
    activeGenerationId: null,
  } satisfies AIState;
  try {
    render(
      <AITextarea
        selectedModel="model-a"
        conversationId="conversation-uuid-fallback"
        state={state}
        dispatch={jest.fn()}
        connect={jest.fn()}
        isCurrentGeneration={() => true}
      />,
    );

    fireEvent.change(screen.getByTestId("prompt-input"), {
      target: { value: "hello" },
    });
    fireEvent.keyDown(screen.getByTestId("prompt-input"), { key: "Enter" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][2].headers["Idempotency-Key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  } finally {
    Object.defineProperty(window, "crypto", {
      configurable: true,
      value: originalCrypto,
    });
  }
});

test("blocked storage preserves retry keys across A-B-A and resolves only each operation", async () => {
  window.sessionStorage.clear();
  mockCreator.id = 3;
  let keyNumber = 0;
  Object.defineProperty(window, "crypto", {
    configurable: true,
    value: { randomUUID: () => `generation-${++keyNumber}` },
  });
  const storageError = () => { throw new DOMException("blocked", "SecurityError"); };
  const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation(storageError);
  const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(storageError);
  const removeItem = jest.spyOn(Storage.prototype, "removeItem").mockImplementation(storageError);
  const post = axios.post as jest.Mock;
  post.mockReset();
  post.mockRejectedValue(new Error("connection lost"));

  const conversationState = (id: string): AIState => ({
    currentConversation: { id } as AIState["currentConversation"],
    promptResponses: [],
    currentResponse: "",
    currentInput: "",
    selectedModel: "model-a",
    selectedPersonality: "",
    websocket: null,
    autoScroll: true,
    textAreaHeight: 0,
    activeGenerationId: null,
  });
  const dispatch = jest.fn();
  const props = (conversationId: string): React.ComponentProps<typeof AITextarea> => ({
    selectedModel: "model-a",
    conversationId,
    state: conversationState(conversationId),
    dispatch,
    connect: jest.fn(),
    isCurrentGeneration: () => true,
  });
  let view = render(<AITextarea {...props("conversation-a")} />);
  let input = screen.getByTestId("prompt-input");
  const submit = async (conversationId: string, prompt: string, expectedCall: number) => {
    view.rerender(<AITextarea {...props(conversationId)} />);
    fireEvent.change(input, { target: { value: prompt } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(expectedCall));
  };
  const requestKey = (index: number) => post.mock.calls[index][2].headers["Idempotency-Key"];

  try {
    await submit("conversation-a", "prompt A", 1);
    expect(requestKey(0)).toBe("generation-1");
    await submit("conversation-a", "prompt A", 2);
    expect(requestKey(1)).toBe("generation-1"); // same-conversation retry positive control

    view.unmount();
    view = render(<AITextarea {...props("conversation-a")} />);
    input = screen.getByTestId("prompt-input");
    await submit("conversation-a", "prompt A", 3);
    expect(requestKey(2)).toBe("generation-1"); // storage-disabled unmount/remount recovery

    await submit("conversation-b", "prompt B", 4);
    expect(requestKey(3)).toBe("generation-2");
    await submit("conversation-a", "prompt A", 5);
    expect(requestKey(4)).toBe("generation-1"); // storage-disabled A-B-A regression
    expect(getItem).toHaveBeenCalled();
    expect(setItem).toHaveBeenCalled();
  } finally {
    getItem.mockRestore();
    setItem.mockRestore();
    removeItem.mockRestore();
  }
});

test("out-of-order outcomes remove only their own account and conversation operation", async () => {
  window.sessionStorage.clear();
  mockCreator.id = 4;
  let keyNumber = 0;
  Object.defineProperty(window, "crypto", {
    configurable: true,
    value: { randomUUID: () => `generation-${++keyNumber}` },
  });
  const post = axios.post as jest.Mock;
  post.mockReset();
  const pendingPosts: Array<{ resolve: (value: any) => void; reject: (error: any) => void }> = [];
  post.mockImplementation(() => new Promise((resolve, reject) => pendingPosts.push({ resolve, reject })));
  const conversationState = (id: string): AIState => ({
    currentConversation: { id } as AIState["currentConversation"],
    promptResponses: [],
    currentResponse: "",
    currentInput: "",
    selectedModel: "model-a",
    selectedPersonality: "",
    websocket: null,
    autoScroll: true,
    textAreaHeight: 0,
    activeGenerationId: null,
  });
  const props = (conversationId: string): React.ComponentProps<typeof AITextarea> => ({
    selectedModel: "model-a",
    conversationId,
    state: conversationState(conversationId),
    dispatch: jest.fn(),
    connect: jest.fn(),
    isCurrentGeneration: () => true,
  });
  const { rerender } = render(<AITextarea {...props("conversation-a")} />);
  const input = screen.getByTestId("prompt-input");
  const submit = async (conversationId: string, prompt: string, expectedCall: number) => {
    rerender(<AITextarea {...props(conversationId)} />);
    fireEvent.change(input, { target: { value: prompt } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(expectedCall));
  };
  const requestKey = (index: number) => post.mock.calls[index][2].headers["Idempotency-Key"];

  await submit("conversation-a", "prompt A", 1);
  const keyA = requestKey(0);
  await submit("conversation-b", "prompt B", 2);
  const keyB = requestKey(1);
  expect(keyA).not.toBe(keyB);

  // Complete B first. A's later ambiguous failure must still retain A's key.
  await act(async () => pendingPosts[1].resolve({ data: { id: "response-b" } }));
  await act(async () => pendingPosts[0].reject(new Error("connection lost")));
  await submit("conversation-a", "prompt A", 3);
  expect(requestKey(2)).toBe(keyA);

  // An account change cannot reuse the old account's retry key for this
  // conversation, and returning to the original account can still recover it.
  mockCreator.id = 5;
  await submit("conversation-a", "prompt A", 4);
  const keyOtherAccount = requestKey(3);
  expect(keyOtherAccount).not.toBe(keyA);
  mockCreator.id = 4;
  await submit("conversation-a", "prompt A", 5);
  expect(requestKey(4)).toBe(keyA);
  await act(async () => pendingPosts[2].reject(new Error("connection lost")));
});


test("returning before a paid completion displays the answer and clears the prompt", async () => {
  window.sessionStorage.clear();
  mockCreator.id = 81;
  let state: AIState = {
    currentConversation: { id: "conversation-a" } as AIState["currentConversation"],
    promptResponses: [], currentResponse: "", currentInput: "",
    selectedModel: "model-a", selectedPersonality: "", websocket: null,
    autoScroll: true, textAreaHeight: 0, activeGenerationId: null,
  };
  let route = "conversation-a";
  const pending: Array<(value: any) => void> = [];
  const post = axios.post as jest.Mock;
  post.mockReset();
  post.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const props = () => ({
    selectedModel: "model-a", conversationId: route, state,
    connect: jest.fn(),
    dispatch: (action: Parameters<typeof reducer>[1]) => { state = reducer(state, action); },
    isCurrentGeneration: (conversationId: string, streamId: string) =>
      generationIsCurrent(state, route, conversationId, streamId),
  });
  const view = render(<AITextarea {...props()} />);
  const input = screen.getByTestId("prompt-input");
  fireEvent.change(input, { target: { value: "question" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  // Retry the same still-pending operation so a duplicate success can arrive
  // after the first has resolved and the reader has begun another draft.
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  for (const id of ["conversation-b", "conversation-a"]) {
    route = id;
    state = reducer(state, {
      type: "setConversation", conversation: { id } as AIState["currentConversation"],
    });
    state = reducer(state, { type: "clearPromptResponses" });
    state = reducer(state, { type: "loadPromptResponses", promptResponses: [] });
    view.rerender(<AITextarea {...props()} />);
  }
  const data = { id: "paid-answer", user_input: "question", response: "complete answer" };
  await act(async () => pending[0]({ data }));
  expect(state.promptResponses).toEqual([data]);
  expect((input as HTMLTextAreaElement).value).toBe("");
  expect(window.sessionStorage.getItem(
    "f2z:ai-pending-generation:81:conversation-a",
  )).toBeNull();
  fireEvent.change(input, { target: { value: "next draft" } });
  await act(async () => pending[1]({ data }));
  expect(state.promptResponses).toEqual([data]);
  expect((input as HTMLTextAreaElement).value).toBe("next draft");
});
