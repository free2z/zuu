import { act, render, waitFor } from "@testing-library/react";
import axios from "axios";
import CreatorLive from "./CreatorLive";

jest.mock("axios");
const mockInitMeeting = jest.fn();
const roomJoinedListeners = new Set<() => void>();
const mockSelf = {
  on: jest.fn((event: string, listener: () => void) => {
    if (event === "roomJoined") roomJoinedListeners.add(listener);
  }),
  removeListener: jest.fn((event: string, listener: () => void) => {
    if (event === "roomJoined") roomJoinedListeners.delete(listener);
  }),
};
const mockMeeting = { self: mockSelf };
Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: require("crypto").webcrypto,
});
jest.mock("react-helmet-async", () => ({
  Helmet: ({ children }: any) => children,
}));
jest.mock("@cloudflare/realtimekit-react", () => ({
  useRealtimeKitClient: () => [null, mockInitMeeting],
  RealtimeKitProvider: ({ children }: any) => children,
}));
jest.mock("react-router-dom", () => ({
  useParams: () => ({ id: "stream-owner", type: "ppv" }),
}));
jest.mock("./hooks/useTransitionNavigate", () => ({
  useTransitionNavigate: () => jest.fn(),
}));
jest.mock("./components/DyteLeave", () => () => null);
jest.mock("./components/DyteCreator", () => () => null);
jest.mock("./components/SubscribeToCreator", () => () => null);
jest.mock("./state/persist", () => ({ useStoreState: () => "1.000" }));
let mockViewer = { id: 100, username: "viewer-a", can_stream: true };
const mockSetState = jest.fn();
jest.mock("./state/global", () => ({
  useGlobalState: (key: string) => [
    key === "creator" ? mockViewer : key === "authStatus" ? true : false,
    mockSetState,
  ],
}));
const mocked = axios as jest.Mocked<typeof axios>;
beforeEach(() => {
  jest.clearAllMocks();
  mockSelf.on.mockImplementation((event: string, listener: () => void) => {
    if (event === "roomJoined") roomJoinedListeners.add(listener);
  });
  mockSelf.removeListener.mockImplementation(
    (event: string, listener: () => void) => {
      if (event === "roomJoined") roomJoinedListeners.delete(listener);
    },
  );
  roomJoinedListeners.clear();
  sessionStorage.clear();
  mockInitMeeting.mockResolvedValue(mockMeeting);
  mockViewer = { id: 100, username: "viewer-a", can_stream: true };
});

test("paid viewer assertion uses the original displayed actor after fresh authentication", async () => {
  mocked.get.mockImplementation((url: any) =>
    Promise.resolve({
      data:
        url === "/api/auth/user/"
          ? mockViewer
          : url.endsWith("/live-status")
            ? { ppv: { session_id: "provider-session-1" } }
            : { username: "stream-owner" },
    }),
  );
  mocked.post.mockResolvedValue({ data: { auth_token: "synthetic-token" } });
  render(<CreatorLive />);
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(1));
  expect(mocked.get).toHaveBeenCalledWith(
    "/api/dyte/stream-owner/live-status",
  );
  expect(mocked.post.mock.calls[0][1]).toEqual({
    expected_actor_id: 100,
    admission_idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  expect(
    sessionStorage.getItem(
      "f2z:ppv-join:stream-owner:100:provider-session-1",
    ),
  ).toBe((mocked.post.mock.calls[0][1] as any).admission_idempotency_key);
});

test("a cookie-switched paid viewer never creates a meeting for another actor", async () => {
  mocked.get.mockImplementation((url: any) =>
    Promise.resolve({
      data:
        url === "/api/auth/user/"
          ? { id: 101, username: "viewer-b" }
          : url.endsWith("/live-status")
            ? { ppv: { session_id: "provider-session-1" } }
            : { username: "stream-owner" },
    }),
  );
  render(<CreatorLive />);
  await waitFor(() =>
    expect(mockSetState).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Sign in again before joining this paid stream.",
      }),
    ),
  );
  expect(mocked.post).not.toHaveBeenCalled();
});

test("a late auth result and actor change to the stream owner cannot reinterpret the original paid-viewer instruction as a host", async () => {
  let release!: (value: unknown) => void;
  mocked.get.mockImplementation((url: any) =>
    url === "/api/auth/user/"
      ? (new Promise((resolve) => {
          release = resolve;
        }) as any)
      : Promise.resolve({
          data: url.endsWith("/live-status")
            ? { ppv: { session_id: "provider-session-1" } }
            : { username: "stream-owner" },
        }),
  );
  const view = render(<CreatorLive />);
  await waitFor(() => expect(release).toBeDefined());
  mockViewer = { id: 101, username: "stream-owner", can_stream: true };
  view.rerender(<CreatorLive />);
  await act(async () => release({ data: mockViewer }));
  await waitFor(() =>
    expect(mockSetState).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Sign in again before joining this paid stream.",
      }),
    ),
  );
  expect(mocked.post).not.toHaveBeenCalled();
});

test("an actor change while live status is pending stores no retry key and sends no paid join", async () => {
  let releaseLiveStatus!: (value: unknown) => void;
  mocked.get.mockImplementation((url: any) =>
    url === "/api/auth/user/"
      ? Promise.resolve({ data: mockViewer })
      : url.endsWith("/live-status")
        ? (new Promise((resolve) => {
            releaseLiveStatus = resolve;
          }) as any)
        : Promise.resolve({ data: { username: "stream-owner" } }),
  );
  const setItem = jest.spyOn(Storage.prototype, "setItem");
  const view = render(<CreatorLive />);
  await waitFor(() => expect(releaseLiveStatus).toBeDefined());

  mockViewer = { id: 101, username: "viewer-b", can_stream: true };
  view.rerender(<CreatorLive />);
  await act(async () =>
    releaseLiveStatus({ data: { ppv: { session_id: "provider-session-1" } } }),
  );

  expect(setItem).not.toHaveBeenCalledWith(
    "f2z:ppv-join:stream-owner:100:provider-session-1",
    expect.any(String),
  );
  expect(
    sessionStorage.getItem(
      "f2z:ppv-join:stream-owner:100:provider-session-1",
    ),
  ).toBeNull();
  expect(mocked.post).not.toHaveBeenCalled();
  setItem.mockRestore();
});

test("unmounting while live status is pending stores no retry key and sends no paid join", async () => {
  let releaseLiveStatus!: (value: unknown) => void;
  mocked.get.mockImplementation((url: any) =>
    url === "/api/auth/user/"
      ? Promise.resolve({ data: mockViewer })
      : url.endsWith("/live-status")
        ? (new Promise((resolve) => {
            releaseLiveStatus = resolve;
          }) as any)
        : Promise.resolve({ data: { username: "stream-owner" } }),
  );
  const setItem = jest.spyOn(Storage.prototype, "setItem");
  const view = render(<CreatorLive />);
  await waitFor(() => expect(releaseLiveStatus).toBeDefined());

  view.unmount();
  await act(async () =>
    releaseLiveStatus({ data: { ppv: { session_id: "provider-session-1" } } }),
  );

  expect(setItem).not.toHaveBeenCalledWith(
    "f2z:ppv-join:stream-owner:100:provider-session-1",
    expect.any(String),
  );
  expect(
    sessionStorage.getItem(
      "f2z:ppv-join:stream-owner:100:provider-session-1",
    ),
  ).toBeNull();
  expect(mocked.post).not.toHaveBeenCalled();
  setItem.mockRestore();
});

test("backend actor_changed after the fresh identity check explains the refusal without retrying", async () => {
  mocked.get.mockImplementation((url: any) =>
    Promise.resolve({
      data:
        url === "/api/auth/user/"
          ? mockViewer
          : url.endsWith("/live-status")
            ? { ppv: { session_id: "provider-session-1" } }
            : { username: "stream-owner" },
    }),
  );
  mocked.post.mockRejectedValue({
    status: 409,
    data: { code: "actor_changed" },
  });
  render(<CreatorLive />);
  await waitFor(() =>
    expect(mockSetState).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Sign in again before joining this paid stream.",
        severity: "warning",
        duration: null,
      }),
    ),
  );
  expect(mocked.post).toHaveBeenCalledTimes(1);
  expect(mocked.post.mock.calls[0][1]).toEqual({
    expected_actor_id: 100,
    admission_idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
});

test("paid admission retry identity remains until roomJoined on its SDK client", async () => {
  mockViewer = { id: 105, username: "viewer-e", can_stream: true };
  mocked.get.mockImplementation((url: any) =>
    Promise.resolve({
      data:
        url === "/api/auth/user/"
          ? mockViewer
          : url.endsWith("/live-status")
            ? { ppv: { session_id: "provider-session-1" } }
            : { username: "stream-owner" },
    }),
  );
  mocked.post.mockResolvedValue({ data: { auth_token: "synthetic-token" } });
  let confirmJoin!: (value: unknown) => void;
  mockInitMeeting.mockImplementation(
    () => new Promise((resolve) => (confirmJoin = resolve)),
  );

  render(<CreatorLive />);
  await waitFor(() => expect(mockInitMeeting).toHaveBeenCalledTimes(1));
  const storageKey = "f2z:ppv-join:stream-owner:105:provider-session-1";
  const admissionKey = sessionStorage.getItem(storageKey);
  expect(admissionKey).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));

  await act(async () => confirmJoin(mockMeeting));
  expect(sessionStorage.getItem(storageKey)).toBe(admissionKey);
  expect(roomJoinedListeners.size).toBe(1);
  expect(mockSelf.on).toHaveBeenCalledWith(
    "roomJoined",
    expect.any(Function),
  );

  await act(async () => {
    for (const listener of Array.from(roomJoinedListeners)) listener();
  });
  await waitFor(() => expect(sessionStorage.getItem(storageKey)).toBeNull());
  expect(roomJoinedListeners.size).toBe(0);
});

test("roomJoined clears the paid key so an intentional same-session join gets a new key", async () => {
  mocked.get.mockImplementation((url: any) =>
    Promise.resolve({
      data:
        url === "/api/auth/user/"
          ? mockViewer
          : url.endsWith("/live-status")
            ? { ppv: { session_id: "provider-session-1" } }
            : { username: "stream-owner" },
    }),
  );
  mocked.post.mockResolvedValue({ data: { auth_token: "synthetic-token" } });

  const view = render(<CreatorLive />);
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(roomJoinedListeners.size).toBe(1));
  const storageKey =
    "f2z:ppv-join:stream-owner:100:provider-session-1";
  const firstKey = sessionStorage.getItem(storageKey);
  expect(firstKey).toBe(
    (mocked.post.mock.calls[0][1] as any).admission_idempotency_key,
  );

  await act(async () => {
    for (const listener of Array.from(roomJoinedListeners)) listener();
  });
  expect(sessionStorage.getItem(storageKey)).toBeNull();

  // Rerun the effect without remounting CreatorLive. The paid intent's
  // in-memory admission key must have been cleared along with storage.
  mockViewer = { id: 101, username: "viewer-b", can_stream: true };
  view.rerender(<CreatorLive />);
  await waitFor(() => expect(mocked.get).toHaveBeenCalledTimes(4));
  mockViewer = { id: 100, username: "viewer-a", can_stream: true };
  view.rerender(<CreatorLive />);

  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(2));
  const secondKey = (mocked.post.mock.calls[1][1] as any)
    .admission_idempotency_key;
  expect(secondKey).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
  expect(secondKey).not.toBe(firstKey);
  expect(sessionStorage.getItem(storageKey)).toBe(secondKey);
});

test("a stale roomJoined callback cannot clear the key for a later join", async () => {
  mocked.get.mockImplementation((url: any) =>
    Promise.resolve({
      data:
        url === "/api/auth/user/"
          ? mockViewer
          : url.endsWith("/live-status")
            ? { ppv: { session_id: "provider-session-1" } }
            : { username: "stream-owner" },
    }),
  );
  mocked.post.mockResolvedValue({ data: { auth_token: "synthetic-token" } });

  const view = render(<CreatorLive />);
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(roomJoinedListeners.size).toBe(1));
  const staleCallback = Array.from(roomJoinedListeners)[0];

  await act(async () => staleCallback());
  mockViewer = { id: 101, username: "viewer-b", can_stream: true };
  view.rerender(<CreatorLive />);
  await waitFor(() => expect(mocked.get).toHaveBeenCalledTimes(4));
  mockViewer = { id: 100, username: "viewer-a", can_stream: true };
  view.rerender(<CreatorLive />);
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(2));
  const storageKey =
    "f2z:ppv-join:stream-owner:100:provider-session-1";
  const laterKey = sessionStorage.getItem(storageKey);
  expect(laterKey).toBe(
    (mocked.post.mock.calls[1][1] as any).admission_idempotency_key,
  );
  expect(laterKey).not.toBeNull();

  await act(async () => staleCallback());
  expect(sessionStorage.getItem(storageKey)).toBe(laterKey);
});

test("roomJoined remains safe when session storage refuses key removal", async () => {
  mocked.get.mockImplementation((url: any) =>
    Promise.resolve({
      data:
        url === "/api/auth/user/"
          ? mockViewer
          : url.endsWith("/live-status")
            ? { ppv: { session_id: "provider-session-1" } }
            : { username: "stream-owner" },
    }),
  );
  mocked.post.mockResolvedValue({ data: { auth_token: "synthetic-token" } });
  const removeItem = jest
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("storage is unavailable");
    });

  try {
    const view = render(<CreatorLive />);
    await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(roomJoinedListeners.size).toBe(1));
    const storageKey =
      "f2z:ppv-join:stream-owner:100:provider-session-1";
    const firstKey = sessionStorage.getItem(storageKey);

    await expect(
      act(async () => {
        for (const listener of Array.from(roomJoinedListeners)) listener();
      }),
    ).resolves.toBeUndefined();
    expect(sessionStorage.getItem(storageKey)).toBe(firstKey);
    expect(roomJoinedListeners.size).toBe(0);

    // Since persistence could not be cleared, a later effect safely reuses
    // the durable identity instead of minting an unpersisted replacement.
    mockViewer = { id: 101, username: "viewer-b", can_stream: true };
    view.rerender(<CreatorLive />);
    await waitFor(() => expect(mocked.get).toHaveBeenCalledTimes(4));
    mockViewer = { id: 100, username: "viewer-a", can_stream: true };
    view.rerender(<CreatorLive />);
    await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(2));
    expect(
      (mocked.post.mock.calls[1][1] as any).admission_idempotency_key,
    ).toBe(firstKey);
  } finally {
    removeItem.mockRestore();
  }
});

test("a cancelled paid admission unregisters its roomJoined listener", async () => {
  mocked.get.mockImplementation((url: any) =>
    Promise.resolve({
      data:
        url === "/api/auth/user/"
          ? mockViewer
          : url.endsWith("/live-status")
            ? { ppv: { session_id: "provider-session-1" } }
            : { username: "stream-owner" },
    }),
  );
  mocked.post.mockResolvedValue({ data: { auth_token: "synthetic-token" } });
  const view = render(<CreatorLive />);
  await waitFor(() => expect(mockSelf.on).toHaveBeenCalledTimes(1));

  view.unmount();

  expect(mockSelf.removeListener).toHaveBeenCalledWith(
    "roomJoined",
    expect.any(Function),
  );
  expect(roomJoinedListeners.size).toBe(0);
  expect(
    sessionStorage.getItem("f2z:ppv-join:stream-owner:100:provider-session-1"),
  ).not.toBeNull();
});

test("a failed SDK join retains the same key across a reload retry", async () => {
  mocked.get.mockImplementation((url: any) =>
    Promise.resolve({
      data:
        url === "/api/auth/user/"
          ? mockViewer
          : url.endsWith("/live-status")
            ? { ppv: { session_id: "provider-session-1" } }
            : { username: "stream-owner" },
    }),
  );
  mocked.post.mockResolvedValue({ data: { auth_token: "synthetic-token" } });
  const reload = jest.fn();
  const originalLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { reload },
  });
  try {
    mockInitMeeting.mockRejectedValueOnce(new Error("SDK join failed"));
    const first = render(<CreatorLive />);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    const storageKey =
      "f2z:ppv-join:stream-owner:100:provider-session-1";
    const firstKey = sessionStorage.getItem(storageKey);
    expect(firstKey).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    first.unmount();

    mockInitMeeting.mockResolvedValue(mockMeeting);
    render(<CreatorLive />);
    await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(2));
    expect((mocked.post.mock.calls[1][1] as any).admission_idempotency_key).toBe(
      firstKey,
    );
    expect(sessionStorage.getItem(storageKey)).toBe(firstKey);
  } finally {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  }
});

test("blocked retry storage fails closed, including after a reload", async () => {
  mocked.get.mockImplementation((url: any) =>
    Promise.resolve({
      data:
        url === "/api/auth/user/"
          ? mockViewer
          : url.endsWith("/live-status")
            ? { ppv: { session_id: "provider-session-1" } }
            : { username: "stream-owner" },
    }),
  );
  const getItem = jest
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(() => {
      throw new Error("blocked");
    });
  const view = render(<CreatorLive />);
  await waitFor(() =>
    expect(mocked.get).toHaveBeenCalledWith(
      "/api/dyte/stream-owner/live-status",
    ),
  );
  expect(mocked.post).not.toHaveBeenCalled();
  view.unmount();
  getItem.mockRestore();
  const setItem = jest
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("blocked");
    });
  render(<CreatorLive />);
  await waitFor(() =>
    expect(mocked.get).toHaveBeenCalledWith(
      "/api/dyte/stream-owner/live-status",
    ),
  );
  expect(mocked.post).not.toHaveBeenCalled();
  setItem.mockRestore();
});

test("the same meeting uses a separate retry key for a different provider session", async () => {
  let providerSessionId = "provider-session-1";
  mocked.get.mockImplementation((url: any) =>
    Promise.resolve({
      data:
        url === "/api/auth/user/"
          ? mockViewer
          : url.endsWith("/live-status")
            ? {
                ppv: {
                  meeting_id: "same-meeting",
                  session_id: providerSessionId,
                },
              }
            : { username: "stream-owner" },
    }),
  );
  mocked.post.mockResolvedValue({ data: { auth_token: "synthetic-token" } });
  const first = render(<CreatorLive />);
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(1));
  const firstKey = (mocked.post.mock.calls[0][1] as any)
    .admission_idempotency_key;
  expect(firstKey).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
  expect(
    sessionStorage.getItem("f2z:ppv-join:stream-owner:100:provider-session-1"),
  ).toBe(firstKey);
  first.unmount();

  providerSessionId = "provider-session-2";
  render(<CreatorLive />);
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(2));
  const secondKey = (mocked.post.mock.calls[1][1] as any)
    .admission_idempotency_key;
  expect(secondKey).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
  expect(secondKey).not.toBe(firstKey);
  expect(
    sessionStorage.getItem("f2z:ppv-join:stream-owner:100:provider-session-2"),
  ).toBe(secondKey);
});
