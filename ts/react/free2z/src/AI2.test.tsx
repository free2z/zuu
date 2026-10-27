import {
  generationIsCurrent,
  reducer,
  type AIState,
  type PromptResponse,
} from "./aiState";

const response = (id: string): PromptResponse => ({
  id,
  user_input: "question",
  response: "answer",
});

const generationState = (
  conversationId: string,
  streamId: string,
): AIState => ({
  currentConversation: { id: conversationId } as AIState["currentConversation"],
  promptResponses: [],
  currentResponse: "live answer",
  currentInput: "question",
  selectedModel: "model",
  selectedPersonality: "",
  websocket: null,
  autoScroll: true,
  textAreaHeight: 0,
  activeGenerationId: streamId,
});

test("late settlement for another conversation is ignored", () => {
  const state = generationState("conversation-b", "generation-b");

  const next = reducer(state, {
    type: "settlePromptResponse",
    conversationId: "conversation-a",
    streamId: "generation-a",
    promptResponse: response("response-a"),
  });

  expect(next).toBe(state);
  expect(next.promptResponses).toEqual([]);
  expect(next.currentResponse).toBe("live answer");
});

test("changing conversations clears the previous live generation", () => {
  const state = generationState("conversation-a", "generation-a");

  const next = reducer(state, {
    type: "setConversation",
    conversation: { id: "conversation-b" } as AIState["currentConversation"],
  });

  expect(next.currentResponse).toBe("");
  expect(next.currentInput).toBe("");
  expect(next.activeGenerationId).toBeNull();
  expect(next.websocket).toBeNull();
});

test("creating the first conversation keeps its submitted prompt visible", () => {
  const state = {
    ...generationState("", "generation-a"),
    currentInput: "first prompt",
  };

  const next = reducer(state, {
    type: "setConversation",
    conversation: { id: "conversation-a" } as AIState["currentConversation"],
  });

  expect(next.currentInput).toBe("first prompt");
  expect(next.currentResponse).toBe("");
});

test("queued websocket deltas from another conversation are ignored", () => {
  const state = generationState("conversation-b", "generation-a");

  const next = reducer(state, {
    type: "addMessage",
    conversationId: "conversation-a",
    message: "stale delta",
    streamId: "generation-a",
  });

  expect(next).toBe(state);
  expect(next.currentResponse).toBe("live answer");
});

test("a route change invalidates settlement before conversation state reloads", () => {
  const state = generationState("conversation-a", "generation-a");

  expect(
    generationIsCurrent(
      state,
      "conversation-b",
      "conversation-a",
      "generation-a",
    ),
  ).toBe(false);
});

test("late settlement from an older generation in the same conversation is ignored", () => {
  const state = generationState("conversation-a", "generation-b");

  const next = reducer(state, {
    type: "settlePromptResponse",
    conversationId: "conversation-a",
    streamId: "generation-a",
    promptResponse: response("response-a"),
  });

  expect(next).toBe(state);
  expect(next.promptResponses).toEqual([]);
});

test("the active generation settles into its own conversation", () => {
  const state = generationState("conversation-a", "generation-a");

  const next = reducer(state, {
    type: "settlePromptResponse",
    conversationId: "conversation-a",
    streamId: "generation-a",
    promptResponse: response("response-a"),
  });

  expect(next.promptResponses).toEqual([response("response-a")]);
  expect(next.currentResponse).toBe("");
  expect(next.activeGenerationId).toBeNull();
});

test("late initial-conversation load is ignored after navigation", () => {
  const state = generationState("conversation-b", "generation-b");

  const next = reducer(state, {
    type: "loadConversation",
    conversationId: "conversation-a",
    streamId: "generation-a",
    promptResponses: [response("response-a")],
  });

  expect(next).toBe(state);
  expect(next.promptResponses).toEqual([]);
});


test.each(["loadConversation", "settlePromptResponse"] as const)(
  "%s reconciles a paid completion after navigating away and back",
  (type) => {
    let state = generationState("conversation-a", "generation-a");
    for (const id of ["conversation-b", "conversation-a"]) {
      state = reducer(state, {
        type: "setConversation",
        conversation: { id } as AIState["currentConversation"],
      });
      state = reducer(state, { type: "clearPromptResponses" });
      // The history response arrived before the paid turn was persisted.
      state = reducer(state, { type: "loadPromptResponses", promptResponses: [] });
    }
    expect(state.activeGenerationId).toBeNull();
    expect(generationIsCurrent(
      state, "conversation-a", "conversation-a", "generation-a",
    )).toBe(true);
    const completed = response("saved-answer");
    const next = reducer(state, type === "loadConversation" ? {
      type, conversationId: "conversation-a", streamId: "generation-a",
      promptResponses: [completed],
    } : {
      type, conversationId: "conversation-a", streamId: "generation-a",
      promptResponse: completed,
    });
    expect(next.promptResponses).toEqual([completed]);
    expect(next.currentResponse).toBe("");
    expect(next.currentInput).toBe("");
  },
);
