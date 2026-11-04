import { act, fireEvent, render, screen } from "@testing-library/react";
import axios from "axios";

let mockRouteId = "alice";
let mockRouteUsername: string | undefined;

jest.mock("react-router", () => ({
  useParams: () => ({ id: mockRouteId, username: mockRouteUsername }),
}));
jest.mock("./CreatorDetail", () => ({
  __esModule: true,
  default: ({ initialCreator }: { initialCreator?: { username?: string } }) => (
    <div>creator detail {initialCreator?.username}</div>
  ),
}));
jest.mock("./PageDetail", () => ({
  __esModule: true,
  default: ({ expectedCreator }: { expectedCreator?: string }) => (
    <div>page detail {expectedCreator}</div>
  ),
}));
jest.mock("./Global404", () => () => <div>not found</div>);
jest.mock("axios");

import RootSplitter, { resolutionForRoute } from "./RootSplitter";

function failure(status: number) {
  return { response: { status } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockRouteId = "alice";
  mockRouteUsername = undefined;
  jest.clearAllMocks();
  (axios.get as jest.Mock).mockReset();
});

it("never exposes a completed resolution under a replacement route", () => {
  const alice = {
    routeKey: "alice:0",
    type: "creator" as const,
    creator: null,
    failure: "" as const,
  };

  expect(resolutionForRoute(alice, "bob:0")).toEqual({
    routeKey: "",
    type: "",
    creator: null,
    failure: "",
  });
});

it("resolves a creator without spending the historic get-type bucket", async () => {
  (axios.get as jest.Mock).mockResolvedValueOnce({
    data: { username: "alice" },
  });

  render(<RootSplitter />);

  expect(await screen.findByText("creator detail alice")).toBeTruthy();
  expect(axios.get).toHaveBeenCalledTimes(1);
  expect(axios.get).toHaveBeenCalledWith("/api/creator/alice/");
});

it("uses get-type only after a confirmed creator miss", async () => {
  (axios.get as jest.Mock)
    .mockRejectedValueOnce(failure(404))
    .mockResolvedValueOnce({ data: "zpage" });

  render(<RootSplitter />);

  expect(await screen.findByText("page detail")).toBeTruthy();
  expect(axios.get).toHaveBeenNthCalledWith(1, "/api/creator/alice/");
  expect(axios.get).toHaveBeenNthCalledWith(2, "/api/get-type/alice");
});

it("re-encodes a decoded root identifier for both credentialed lookups", async () => {
  mockRouteId = "../auth/user";
  (axios.get as jest.Mock)
    .mockRejectedValueOnce(failure(404))
    .mockResolvedValueOnce({ data: "zpage" });

  render(<RootSplitter />);

  expect(await screen.findByText("page detail")).toBeTruthy();
  expect(axios.get).toHaveBeenNthCalledWith(
    1,
    "/api/creator/..%2Fauth%2Fuser/",
  );
  expect(axios.get).toHaveBeenNthCalledWith(
    2,
    "/api/get-type/..%2Fauth%2Fuser",
  );
  expect(axios.get).not.toHaveBeenCalledWith("/api/auth/user/");
});

it("binds the explicit legacy zpage route to its requested creator", async () => {
  mockRouteId = "support";
  mockRouteUsername = "trusted-creator";
  (axios.get as jest.Mock)
    .mockRejectedValueOnce(failure(404))
    .mockResolvedValueOnce({ data: "zpage" });

  render(<RootSplitter />);

  expect(await screen.findByText("page detail trusted-creator")).toBeTruthy();
});

it("renders a retryable resolver rejection instead of a false 404", async () => {
  (axios.get as jest.Mock)
    .mockRejectedValueOnce(failure(404))
    .mockRejectedValueOnce(failure(429))
    .mockRejectedValueOnce(failure(404))
    .mockResolvedValueOnce({ data: "zpage" });

  render(<RootSplitter />);

  expect((await screen.findByRole("alert")).textContent).toContain(
    "temporarily unavailable",
  );
  expect(screen.queryByText("not found")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("page detail")).toBeTruthy();
});

it("ignores a stale creator result after the route changes", async () => {
  const alice = deferred<{ data: { username: string } }>();
  (axios.get as jest.Mock)
    .mockReturnValueOnce(alice.promise)
    .mockResolvedValueOnce({ data: { username: "bob" } });

  const view = render(<RootSplitter />);
  mockRouteId = "bob";
  view.rerender(<RootSplitter />);
  expect(await screen.findByText("creator detail bob")).toBeTruthy();

  await act(async () => {
    alice.resolve({ data: { username: "alice" } });
    await alice.promise;
  });
  expect(axios.get).toHaveBeenCalledTimes(2);
  expect(screen.getByText("creator detail bob")).toBeTruthy();
});

it("hides a resolved creator synchronously while the next route loads", async () => {
  const bob = deferred<{ data: { username: string } }>();
  (axios.get as jest.Mock)
    .mockResolvedValueOnce({ data: { username: "alice" } })
    .mockReturnValueOnce(bob.promise);

  const view = render(<RootSplitter />);
  expect(await screen.findByText("creator detail alice")).toBeTruthy();

  mockRouteId = "bob";
  view.rerender(<RootSplitter />);
  expect(screen.queryByText("creator detail alice")).toBeNull();

  await act(async () => {
    bob.resolve({ data: { username: "bob" } });
    await bob.promise;
  });
  expect(screen.getByText("creator detail bob")).toBeTruthy();
});
