import type { AIConversation } from "./components/AIConversationListDrawer";
import type { PublicCreator } from "./CreatorDetail";

export interface AIPersonality {
  id: string;
  display_name: string;
  creator: string;
  system_message: string;
}

export interface AIModel {
  id: string;
  display_name: string;
  provider?: string;
  order?: number;
}

export interface PromptResponse {
  id: string;
  user_input: string;
  response: string;
  created_at?: string;
  personality?: AIPersonality;
  user?: PublicCreator;
  ai_model?: AIModel;
}

export interface PromptResponseAPI {
  count: number;
  next: string | null;
  previous: string | null;
  results: PromptResponse[];
}

export type AIState = {
  currentConversation: AIConversation;
  promptResponses: PromptResponse[];
  currentResponse: string;
  currentInput: string;
  selectedModel: string;
  selectedPersonality: string;
  websocket: WebSocket | null;
  autoScroll: boolean;
  textAreaHeight: number;
  activeGenerationId: string | null;
};

export type AIAction =
  | {
      type: "addMessage";
      conversationId: string;
      message: string;
      streamId: string | null;
    }
  | { type: "beginGeneration"; streamId: string }
  | { type: "completeResponse" }
  | { type: "clearPromptResponses" }
  | {
      type: "loadConversation";
      conversationId: string;
      streamId: string;
      promptResponses: PromptResponse[];
    }
  | { type: "loadPromptResponses"; promptResponses: PromptResponse[] }
  | {
      type: "settlePromptResponse";
      conversationId: string;
      streamId: string;
      promptResponse: PromptResponse;
    }
  | { type: "storeCurrentInput"; userInput: string }
  | { type: "setSelectedModel"; selectedModel: string }
  | { type: "setSelectedPersonality"; selectedPersonality: string }
  | { type: "setConversation"; conversation: AIConversation }
  | { type: "startConversation" }
  | { type: "setWebsocket"; websocket: WebSocket | null }
  | { type: "startAutoScroll" }
  | { type: "stopAutoScroll" }
  | { type: "setTextAreaHeight"; textAreaHeight: number }
  | { type: "clearCurrent" };

export const generationIsCurrent = (
  state: AIState,
  routeConversationId: string | undefined,
  targetConversationId: string,
  streamId: string,
) => state.currentConversation.id === targetConversationId
  // Returning to a conversation reloads its history and clears live stream
  // ownership. Its pending HTTP completion can still supply a saved answer.
  && (state.activeGenerationId === null || state.activeGenerationId === streamId)
  && (!routeConversationId || routeConversationId === targetConversationId);

export const reducer = (state: AIState, action: AIAction): AIState => {
  switch (action.type) {
    case "addMessage":
      return state.currentConversation.id === action.conversationId
        && state.activeGenerationId !== null
        && state.activeGenerationId === action.streamId
        ? { ...state, currentResponse: state.currentResponse + action.message }
        : state;
    case "beginGeneration":
      return { ...state, activeGenerationId: action.streamId };
    case "clearPromptResponses":
      return { ...state, promptResponses: [] };
    case "completeResponse":
      if (!state.currentInput || !state.currentResponse) {
        return state;
      }
      return {
        ...state,
        promptResponses: [
          ...state.promptResponses,
          {
            id: "",
            user_input: state.currentInput,
            response: state.currentResponse,
          },
        ],
        currentResponse: "",
        currentInput: "",
        activeGenerationId: null,
      };
    case "loadConversation":
      if (state.currentConversation.id !== action.conversationId
        || (state.activeGenerationId !== null
          && state.activeGenerationId !== action.streamId)) {
        return state;
      }
      return {
        ...state,
        promptResponses: action.promptResponses,
        currentResponse: "",
        activeGenerationId: null,
      };
    case "loadPromptResponses":
      return {
        ...state,
        promptResponses: [...state.promptResponses, ...action.promptResponses],
      };
    case "settlePromptResponse":
      if (state.currentConversation.id !== action.conversationId
        || (state.activeGenerationId !== null
          && state.activeGenerationId !== action.streamId)) {
        return state;
      }
      return {
        ...state,
        promptResponses: state.promptResponses.some(
          response => response.id === action.promptResponse.id,
        )
          ? state.promptResponses
          : [...state.promptResponses, action.promptResponse],
        currentResponse: "",
        currentInput: "",
        activeGenerationId: null,
      };
    case "storeCurrentInput":
      return { ...state, currentInput: action.userInput };
    case "setSelectedModel":
      return { ...state, selectedModel: action.selectedModel };
    case "setSelectedPersonality":
      return { ...state, selectedPersonality: action.selectedPersonality };
    case "setConversation":
      if (state.currentConversation.id === action.conversation.id) {
        return { ...state, currentConversation: action.conversation };
      }
      state.websocket && state.websocket.readyState !== WebSocket.CLOSED
        && state.websocket.close();
      return {
        ...state,
        currentConversation: action.conversation,
        currentResponse: "",
        // On the first turn, AITextarea stores the submitted prompt before it
        // creates the conversation. Keep it so streamed output remains paired
        // with that prompt; switching between existing conversations clears it.
        currentInput: state.currentConversation.id ? "" : state.currentInput,
        activeGenerationId: null,
        websocket: null,
      };
    case "startConversation":
      state.websocket?.readyState === WebSocket.OPEN && state.websocket.close();
      return {
        promptResponses: [],
        currentResponse: "",
        currentInput: "",
        selectedModel: "",
        selectedPersonality: "",
        currentConversation: {} as AIConversation,
        websocket: null,
        autoScroll: true,
        textAreaHeight: 0,
        activeGenerationId: null,
      };
    case "setWebsocket":
      return { ...state, websocket: action.websocket };
    case "startAutoScroll":
      return { ...state, autoScroll: true };
    case "stopAutoScroll":
      return { ...state, autoScroll: false };
    case "setTextAreaHeight":
      return { ...state, textAreaHeight: action.textAreaHeight };
    case "clearCurrent":
      return { ...state, currentResponse: "", activeGenerationId: null };
    default:
      throw new Error();
  }
};
