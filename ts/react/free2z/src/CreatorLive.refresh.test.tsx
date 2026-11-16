import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "react-query";
import axios from "axios";
import CreatorLive from "./CreatorLive";
import GlobalCreator from "./state/GlobalCreator";
import { WebSocketProvider } from "./hooks/useWebSocket";
import {
  defaultCreator,
  getGlobalState,
  retireAuthSession,
  setGlobalState,
} from "./state/global";

jest.mock("axios");
const mockInit = jest.fn();
const mockViewerInit = jest.fn();
const mockNavigate = jest.fn();
jest.mock("@cloudflare/realtimekit", () => ({
  __esModule: true,
  default: { init: (...args: any[]) => mockInit(...args) },
}));
jest.mock("@cloudflare/realtimekit-react", () => ({
  useRealtimeKitClient: () => [null, mockViewerInit],
  RealtimeKitProvider: ({ children }: any) => children,
}));
jest.mock("react-helmet-async", () => ({
  Helmet: ({ children }: any) => children,
}));
jest.mock("react-router-dom", () => ({
  useParams: () => ({ id: "Alice", type: "ppv" }),
}));
jest.mock("./hooks/useTransitionNavigate", () => ({
  useTransitionNavigate: () => mockNavigate,
}));
jest.mock("./components/DyteLeave", () => () => null);
jest.mock("./components/DyteCreator", () => () => null);
jest.mock("./components/SubscribeToCreator", () => () => null);
jest.mock("./state/persist", () => ({ useStoreState: () => "23.00" }));

Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: require("crypto").webcrypto,
});
const http = axios as jest.Mocked<typeof axios>;
const alice = {
  ...defaultCreator,
  id: 41,
  username: "Alice",
  can_stream: true,
};
const bob = { ...defaultCreator, id: 42, username: "Bob", can_stream: true };
let currentProfile = alice;
let queryClient: QueryClient;
let meeting: {
  leave: jest.Mock;
  self: { on: jest.Mock; removeListener: jest.Mock };
};
let socket: FakeWebSocket;
class FakeWebSocket {
  onmessage?: (event: { data: string }) => void;
  close = jest.fn();
  constructor() {
    socket = this;
  }
}
const originalWebSocket = globalThis.WebSocket;
const calls = (action: string) =>
  http.post.mock.calls.filter(([, body]: any) => body?.action === action);
const starts = () =>
  http.post.mock.calls.filter(([, body]: any) => body?.role === "host");
async function flush(ms = 0) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
function mount() {
  return render(
    <QueryClientProvider client={queryClient}>
      <GlobalCreator />
      <WebSocketProvider wsUrl="wss://example.invalid/events">
        <CreatorLive />
      </WebSocketProvider>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  sessionStorage.clear();
  currentProfile = alice;
  setGlobalState("creator", alice);
  setGlobalState("authStatus", true);
  globalThis.WebSocket = FakeWebSocket as any;
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        cacheTime: 0,
      },
    },
  });
  queryClient.setQueryData("creatorData", alice);
  meeting = {
    leave: jest.fn().mockResolvedValue(undefined),
    self: { on: jest.fn(), removeListener: jest.fn() },
  };
  mockInit.mockResolvedValue(meeting);
  mockViewerInit.mockResolvedValue({});
  http.get.mockImplementation(async (url) => ({
    data:
      url === "/api/auth/user/"
        ? currentProfile
        : { id: 41, username: "Alice" },
  }));
  http.post.mockImplementation(async (_url, body: any) => ({
    data: {
      host_session: body.host_session,
      auth_token: "synthetic-provider-token",
    },
  }));
});
afterEach(async () => {
  cleanup();
  await flush();
  queryClient.clear();
  globalThis.WebSocket = originalWebSocket;
  jest.useRealTimers();
});

test.each(["donation", "subscription"])(
  "real %s notification refresh preserves host media and renews the same seat past sixty seconds",
  async (type) => {
    const view = mount();
    await flush();
    expect(starts()).toHaveLength(1);
    const cacheEpoch = getGlobalState("authEpoch");
    const hostEpoch = getGlobalState("hostAuthEpoch");
    currentProfile = { ...alice, tuzis: "125" };
    await act(async () =>
      socket.onmessage?.({
        data: JSON.stringify({ content: { id: "synthetic-event", type } }),
      })
    );
    await flush();
    expect(http.get).toHaveBeenCalledWith("/api/auth/user/");
    expect(getGlobalState("creator").tuzis).toBe("125");
    expect(getGlobalState("authEpoch")).toBeGreaterThan(cacheEpoch);
    expect(getGlobalState("hostAuthEpoch")).toBe(hostEpoch);
    expect(meeting.leave).not.toHaveBeenCalled();
    expect(calls("release")).toHaveLength(0);
    for (let i = 0; i < 5; i++) await flush(15_000);
    expect(starts()).toHaveLength(1);
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(calls("heartbeat")).toHaveLength(6);
    expect(
      calls("heartbeat").every(
        ([, body]: any) =>
          body.host_session === (starts()[0][1] as any).host_session
      )
    ).toBe(true);
    view.unmount();
    await flush();
    expect(calls("release")).toHaveLength(1);
    expect(meeting.leave).toHaveBeenCalledTimes(1);
  }
);

test.each(["explicit", "account-roundtrip", "status-roundtrip"])(
  "real %s authentication retirement stops the old host without restarting or releasing under another session",
  async (kind) => {
    mount();
    await flush();
    await act(async () => {
      if (kind === "explicit") retireAuthSession();
      else if (kind === "account-roundtrip") {
        setGlobalState("creator", bob);
        setGlobalState("creator", alice);
      } else {
        setGlobalState("authStatus", false);
        setGlobalState("authStatus", true);
      }
    });
    await flush(75_000);
    expect(starts()).toHaveLength(1);
    expect(calls("heartbeat")).toHaveLength(1);
    expect(calls("release")).toHaveLength(0);
    expect(meeting.leave).toHaveBeenCalledTimes(1);
  }
);

test.each(["network", "server"])(
  "a %s failure refreshing the host profile preserves the authenticated seat while heartbeats succeed",
  async (kind) => {
    mount();
    await flush();
    const hostEpoch = getGlobalState("hostAuthEpoch");
    const cacheEpoch = getGlobalState("authEpoch");
    const profile = getGlobalState("creator");
    http.get.mockRejectedValueOnce(
      kind === "network" ? new Error("offline") : { response: { status: 500 } }
    );
    await act(async () =>
      socket.onmessage?.({
        data: JSON.stringify({
          content: { id: "synthetic-event", type: "donation" },
        }),
      })
    );
    await flush();
    expect(http.get).toHaveBeenCalledWith("/api/auth/user/");
    expect(getGlobalState("creator")).toBe(profile);
    expect(getGlobalState("authStatus")).toBe(true);
    expect(getGlobalState("hostAuthEpoch")).toBe(hostEpoch);
    expect(getGlobalState("authEpoch")).toBeGreaterThan(cacheEpoch);
    expect(meeting.leave).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i++) await flush(15_000);
    expect(starts()).toHaveLength(1);
    expect(calls("heartbeat")).toHaveLength(6);
    expect(calls("release")).toHaveLength(0);
  }
);

test.each([401, 403])(
  "definitive profile authentication denial %i retires the host",
  async (status) => {
    mount();
    await flush();
    http.get.mockRejectedValueOnce({ response: { status } });
    await act(async () => {
      await queryClient.invalidateQueries("creatorData");
    });
    await flush(75_000);
    expect(getGlobalState("authStatus")).toBe(false);
    expect(meeting.leave).toHaveBeenCalledTimes(1);
    expect(starts()).toHaveLength(1);
    expect(calls("heartbeat")).toHaveLength(1);
  }
);

test.each(["logout", "account-switch"])(
  "a failed pending refresh after %s cannot re-adopt cached identity",
  async (transition) => {
    mount();
    await flush();
    let reject!: (error: Error) => void;
    http.get.mockImplementationOnce(
      () =>
        new Promise((_done, fail) => {
          reject = fail;
        })
    );
    await act(async () => {
      void queryClient.invalidateQueries("creatorData");
    });
    const next = transition === "logout" ? defaultCreator : bob;
    await act(async () => {
      if (transition === "logout") {
        retireAuthSession();
        setGlobalState("authStatus", false);
      }
      setGlobalState("creator", next);
      reject(new Error("offline"));
    });
    await flush(75_000);
    expect(getGlobalState("creator")).toBe(next);
    expect(getGlobalState("authStatus")).toBe(transition !== "logout");
    expect(meeting.leave).toHaveBeenCalledTimes(1);
    expect(starts()).toHaveLength(1);
    expect(calls("heartbeat")).toHaveLength(1);
    expect(calls("release")).toHaveLength(0);
  }
);

test("an initial profile failure without authoritative cached data does not authenticate", async () => {
  queryClient.removeQueries("creatorData");
  http.get.mockRejectedValueOnce(new Error("offline"));
  render(
    <QueryClientProvider client={queryClient}>
      <GlobalCreator />
    </QueryClientProvider>
  );
  await flush();
  expect(getGlobalState("authStatus")).toBe(false);
  expect(starts()).toHaveLength(0);
});

test.each([bob, { ...alice, username: "RenamedAlice" }])(
  "authoritative identity $username fences pending initialization before adoption",
  async (next) => {
    let resolve!: (value: typeof meeting) => void;
    mockInit.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    mount();
    await flush();
    currentProfile = next;
    await act(async () => {
      await queryClient.invalidateQueries("creatorData");
      resolve(meeting);
    });
    await flush(75_000);
    expect(getGlobalState("creator").username).toBe(next.username);
    expect(starts()).toHaveLength(1);
    expect(calls("heartbeat")).toHaveLength(1);
    expect(calls("release")).toHaveLength(0);
    expect(meeting.leave).toHaveBeenCalledTimes(1);
  }
);
