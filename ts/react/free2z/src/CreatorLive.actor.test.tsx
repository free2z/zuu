import { act, render, waitFor } from "@testing-library/react";
import axios from "axios";
import CreatorLive from "./CreatorLive";

jest.mock("axios");
jest.mock("react-helmet-async", () => ({
  Helmet: ({ children }: any) => children,
}));
jest.mock("@cloudflare/realtimekit-react", () => ({
  useRealtimeKitClient: () => [null, jest.fn().mockResolvedValue({})],
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
  mockViewer = { id: 100, username: "viewer-a", can_stream: true };
});

test("paid viewer assertion uses the original displayed actor after fresh authentication", async () => {
  mocked.get.mockImplementation((url: any) =>
    Promise.resolve({
      data:
        url === "/api/auth/user/" ? mockViewer : { username: "stream-owner" },
    }),
  );
  mocked.post.mockResolvedValue({ data: { auth_token: "synthetic-token" } });
  render(<CreatorLive />);
  await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(1));
  expect(mocked.post.mock.calls[0][1]).toEqual({ expected_actor_id: 100 });
});

test("a cookie-switched paid viewer never creates a meeting for another actor", async () => {
  mocked.get.mockImplementation((url: any) =>
    Promise.resolve({
      data:
        url === "/api/auth/user/"
          ? { id: 101, username: "viewer-b" }
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
      : Promise.resolve({ data: { username: "stream-owner" } }),
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

test("backend actor_changed after the fresh identity check explains the refusal without retrying", async () => {
  mocked.get.mockImplementation((url: any) =>
    Promise.resolve({
      data:
        url === "/api/auth/user/" ? mockViewer : { username: "stream-owner" },
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
  expect(mocked.post.mock.calls[0][1]).toEqual({ expected_actor_id: 100 });
});
