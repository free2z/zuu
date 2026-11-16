import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import axios from "axios";
import CreatorLive from "./CreatorLive";

jest.mock("axios");
const mockInit = jest.fn();
const mockViewerInit = jest.fn();
const mockNavigate = jest.fn();
const mockState = jest.fn();
let mockActor = { id: 41, username: "Alice", can_stream: true };
let mockParams = { id: "Alice", type: "ppv" };
let mockEpoch = 0;
let mockProvidedMeeting: any;
jest.mock("@cloudflare/realtimekit", () => ({
  __esModule: true,
  default: { init: (...args: any[]) => mockInit(...args) },
}));
jest.mock("@cloudflare/realtimekit-react", () => ({
  useRealtimeKitClient: () => [null, mockViewerInit],
  RealtimeKitProvider: ({ children, value }: any) => {
    mockProvidedMeeting = value;
    return children;
  },
  useRealtimeKitMeeting: () => ({ meeting: mockProvidedMeeting }),
}));
jest.mock("@cloudflare/realtimekit-react-ui", () => ({
  RtkMeeting: () => null,
}));
jest.mock("react-helmet-async", () => ({
  Helmet: ({ children }: any) => children,
}));
jest.mock("react-router-dom", () => ({ useParams: () => mockParams }));
jest.mock("./hooks/useTransitionNavigate", () => ({
  useTransitionNavigate: () => mockNavigate,
}));
jest.mock("./components/DyteLeave", () => () => null);
jest.mock("./components/SubscribeToCreator", () => () => null);
jest.mock("./state/persist", () => ({ useStoreState: () => "23.00" }));
jest.mock("./state/global", () => ({
  useGlobalState: (key: string) => [
    key === "creator"
      ? mockActor
      : key === "authStatus"
      ? true
      : key === "hostAuthEpoch"
      ? mockEpoch
      : false,
    mockState,
  ],
  getGlobalState: (key: string) =>
    key === "hostAuthEpoch" ? mockEpoch : undefined,
}));
Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: require("crypto").webcrypto,
});
const http = axios as jest.Mocked<typeof axios>;
const mockFetch = jest.fn();
const originalFetch = globalThis.fetch;
function client() {
  const listeners = new Set<(event: { state: string }) => void>();
  const handoffs = new Map<string, Set<(next?: any) => void>>();
  return {
    leave: jest.fn().mockResolvedValue(undefined),
    self: {
      on: jest.fn((_event, fn) => listeners.add(fn)),
      removeListener: jest.fn((_event, fn) => listeners.delete(fn)),
    },
    connectedMeetings: {
      on: jest.fn((event, fn) => {
        if (!handoffs.has(event)) handoffs.set(event, new Set());
        handoffs.get(event)!.add(fn);
      }),
      removeListener: jest.fn((event, fn) => handoffs.get(event)?.delete(fn)),
    },
    emit: (state: string) => listeners.forEach((fn) => fn({ state })),
    changing: () => handoffs.get("changingMeeting")?.forEach((fn) => fn()),
    handoff: (next: any) =>
      handoffs.get("meetingChanged")?.forEach((fn) => fn(next)),
    pendingHandoffListeners: () => handoffs.get("meetingChanged")?.size ?? 0,
  };
}
let meeting: ReturnType<typeof client>;
const calls = (action: string) =>
  action === "release"
    ? mockFetch.mock.calls.map(([url, options]) => [
        url,
        JSON.parse(options.body),
        options,
      ])
    : http.post.mock.calls.filter(([, body]: any) => body?.action === action);
const starts = () =>
  http.post.mock.calls.filter(([url]: any) => !url.endsWith("host-session"));
async function flush(ms = 0) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true });
  globalThis.fetch = mockFetch;
  sessionStorage.clear();
  mockActor = { id: 41, username: "Alice", can_stream: true };
  mockParams = { id: "Alice", type: "ppv" };
  mockEpoch = 0;
  mockProvidedMeeting = null;
  meeting = client();
  mockInit.mockResolvedValue(meeting);
  mockViewerInit.mockResolvedValue({});
  http.get.mockImplementation(async (url: any) => ({
    data: url === "/api/auth/user/" ? mockActor : { id: 41, username: "Alice" },
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
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
});

test("actual classic host renews past 60 seconds through transient disconnect, then releases on unmount", async () => {
  const view = render(<CreatorLive />);
  await flush();
  expect(starts()).toHaveLength(1);
  const body: any = starts()[0][1];
  expect(body).toEqual({
    role: "host",
    host_session: expect.any(String),
    expected_actor_id: 41,
    price_per_minute: "23.00",
  });
  await act(async () => meeting.emit("disconnected"));
  for (let i = 0; i < 5; i++) await flush(15_000);
  expect(calls("heartbeat")).toHaveLength(6);
  expect(
    calls("heartbeat").every(
      ([, data]: any) => data.host_session === body.host_session
    )
  ).toBe(true);
  view.unmount();
  await flush();
  expect(calls("release")).toHaveLength(1);
  expect(meeting.leave).toHaveBeenCalledTimes(1);
  await flush(75_000);
  expect(calls("heartbeat")).toHaveLength(6);
});

test("transient heartbeat failure retries, supersession stops and leaves the exact client", async () => {
  render(<CreatorLive />);
  await flush();
  http.post.mockRejectedValueOnce(new Error("offline"));
  await flush(15_000);
  http.post.mockRejectedValueOnce({ response: { status: 503 } });
  await flush(15_000);
  expect(calls("heartbeat")).toHaveLength(3);
  expect(calls("heartbeat")[0][2]).toEqual({ timeout: 10_000 });
  http.post.mockRejectedValueOnce({
    response: { status: 409, data: { code: "host_session_superseded" } },
  });
  await flush(15_000);
  await flush(75_000);
  expect(calls("heartbeat")).toHaveLength(4);
  expect(calls("release")).toHaveLength(0);
  expect(meeting.leave).toHaveBeenCalledTimes(1);
  expect(mockNavigate).toHaveBeenCalledWith("/profile");
});

test("StrictMode does not provision or release a second seat", async () => {
  const view = render(
    <StrictMode>
      <CreatorLive />
    </StrictMode>
  );
  await flush();
  await flush();
  expect(starts()).toHaveLength(1);
  expect(calls("release")).toHaveLength(0);
  view.unmount();
  await flush();
  expect(calls("release")).toHaveLength(1);
});

test.each([
  [401, false],
  [403, false],
  [401, true],
  [403, true],
])(
  "heartbeat denial %i ends the host (initialization pending: %s)",
  async (status, pending) => {
    let resolve!: (value: any) => void;
    if (pending)
      mockInit.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
    render(<CreatorLive />);
    await flush();
    http.post.mockRejectedValueOnce({ response: { status } });
    await flush(15_000);
    if (pending) {
      await act(async () => resolve(meeting));
      await flush();
    }
    await flush(75_000);
    expect(calls("heartbeat")).toHaveLength(2);
    expect(calls("release")).toHaveLength(0);
    expect(meeting.leave).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("/profile");
    expect(mockState).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Sign in again"),
      })
    );
  }
);

test("cancelled provisioning releases its late response without initializing media", async () => {
  let resolve!: (data: any) => void;
  http.post.mockImplementationOnce(
    (_url, body: any) =>
      new Promise((done) => {
        resolve = () =>
          done({
            data: { host_session: body.host_session, auth_token: "late" },
          });
      })
  );
  const view = render(<CreatorLive />);
  await flush();
  view.unmount();
  await flush();
  resolve({});
  await flush();
  expect(mockInit).not.toHaveBeenCalled();
  expect(calls("heartbeat")).toHaveLength(0);
  expect(
    calls("release").every(
      ([, body]: any) =>
        body.host_session === (starts()[0][1] as any).host_session
    )
  ).toBe(true);
});

test("late SDK initialization after unmount leaves the abandoned client", async () => {
  let resolve!: (value: any) => void;
  mockInit.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const view = render(<CreatorLive />);
  await flush();
  view.unmount();
  await flush();
  resolve(meeting);
  await flush();
  expect(meeting.leave).toHaveBeenCalledTimes(1);
  expect(calls("release")).toHaveLength(1);
});

test("route intent fences late init before deferred cleanup while preserving same-actor release", async () => {
  let resolve!: (value: any) => void;
  mockInit.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const view = render(<CreatorLive />);
  await flush();
  http.get.mockImplementation(() => new Promise(() => {}));
  mockParams = { id: "Bob", type: "broadcast" };
  view.rerender(<CreatorLive />);
  await act(async () => resolve(meeting));
  expect(meeting.leave).toHaveBeenCalledTimes(1);
  expect(calls("release")).toHaveLength(1);
  await flush(75_000);
  expect(calls("heartbeat")).toHaveLength(1);
});

test("connected-meeting handoff transfers media cleanup while retaining the same seat", async () => {
  const next = client();
  const view = render(<CreatorLive />);
  await flush();
  await act(async () => {
    meeting.changing();
    meeting.emit("connected-meeting");
  });
  await flush(50);
  expect(mockNavigate).not.toHaveBeenCalled();
  await act(async () => meeting.handoff(next));
  await flush(100);
  await flush(15_000);
  expect(calls("release")).toHaveLength(0);
  view.unmount();
  await flush();
  expect(next.leave).toHaveBeenCalledTimes(1);
  expect(meeting.leave).not.toHaveBeenCalled();
  expect(calls("release")).toHaveLength(1);
});

test.each(["unmount", "authentication"])(
  "cancelled pending handoff on %s stops old media and disposes its eventual replacement",
  async (reason) => {
    const next = client();
    const view = render(<CreatorLive />);
    await flush();
    await act(async () => {
      meeting.changing();
      meeting.emit("connected-meeting");
    });
    if (reason === "unmount") view.unmount();
    else {
      mockEpoch++;
      view.rerender(<CreatorLive />);
    }
    await flush();
    expect(meeting.leave).toHaveBeenCalledTimes(1);
    await act(async () => meeting.handoff(next));
    await flush(100);
    expect(next.leave).toHaveBeenCalledTimes(1);
    expect(meeting.pendingHandoffListeners()).toBe(0);
    expect(calls("release")).toHaveLength(reason === "unmount" ? 1 : 0);
  }
);

test("account switch stops the old lease without using the new actor for release", async () => {
  const view = render(<CreatorLive />);
  await flush();
  mockActor = { id: 42, username: "alice", can_stream: true };
  view.rerender(<CreatorLive />);
  await flush();
  await flush(75_000);
  expect(starts()).toHaveLength(1);
  expect(calls("heartbeat")).toHaveLength(1);
  expect(calls("release")).toHaveLength(0);
  expect(meeting.leave).toHaveBeenCalledTimes(1);
});

test("synchronous auth retirement stops the host even before logout or batched account UI updates", async () => {
  const view = render(<CreatorLive />);
  await flush();
  mockEpoch += 1;
  view.rerender(<CreatorLive />);
  await flush();
  await flush(75_000);
  expect(starts()).toHaveLength(1);
  expect(calls("heartbeat")).toHaveLength(1);
  expect(calls("release")).toHaveLength(0);
  expect(meeting.leave).toHaveBeenCalledTimes(1);
});

test("route change cannot treat the old profile as the new route's host", async () => {
  const view = render(<CreatorLive />);
  await flush();
  http.get.mockImplementation(() => new Promise(() => {}));
  mockParams = { id: "Bob", type: "ppv" };
  view.rerender(<CreatorLive />);
  await flush();
  await flush(75_000);
  expect(starts()).toHaveLength(1);
  expect(calls("release")).toHaveLength(1);
});

test("a same-spelling different account is explicitly a viewer and never owns a host timer", async () => {
  mockActor = { id: 42, username: "alice", can_stream: true };
  mockParams = { id: "Alice", type: "broadcast" };
  render(<CreatorLive />);
  await flush();
  await flush(75_000);
  expect(http.post.mock.calls[0][1]).toEqual({ role: "viewer" });
  expect(mockInit).not.toHaveBeenCalled();
  expect(calls("heartbeat")).toHaveLength(0);
  expect(calls("release")).toHaveLength(0);
});

test("changed cookie actor is fenced by the original actor assertion before SDK initialization", async () => {
  http.post.mockImplementation(async (_url, body: any) => {
    if (body.role === "host") {
      expect(body.expected_actor_id).toBe(41);
      throw { response: { status: 409, data: { code: "actor_changed" } } };
    }
    return { data: {} };
  });
  render(<CreatorLive />);
  await flush();
  expect(mockInit).not.toHaveBeenCalled();
  expect(calls("heartbeat")).toHaveLength(0);
});

test("a mismatched returned seat is never renewed or used to initialize media", async () => {
  http.post.mockResolvedValueOnce({
    data: { host_session: "another-seat", auth_token: "synthetic" },
  });
  render(<CreatorLive />);
  await flush();
  await flush(75_000);
  expect(mockInit).not.toHaveBeenCalled();
  expect(calls("heartbeat")).toHaveLength(0);
  expect(calls("release")[0][1]).toEqual({
    host_session: (starts()[0][1] as any).host_session,
    action: "release",
  });
});

test("page teardown releases the current seat without waiting for unmount", async () => {
  render(<CreatorLive />);
  await flush();
  window.dispatchEvent(new Event("pagehide"));
  await flush();
  await flush(75_000);
  expect(calls("release")).toHaveLength(1);
  expect(calls("heartbeat")).toHaveLength(1);
  expect(calls("release")[0][2]).toEqual(
    expect.objectContaining({
      keepalive: true,
      credentials: "same-origin",
      method: "POST",
    })
  );
});

test.each(["left", "ended", "kicked", "failed"])(
  "terminal %s releases the owned seat",
  async (state) => {
    render(<CreatorLive />);
    await flush();
    await act(async () => meeting.emit(state));
    await flush(75_000);
    expect(calls("release")).toHaveLength(1);
    expect(calls("heartbeat")).toHaveLength(1);
  }
);
