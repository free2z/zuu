import { act, render, screen } from "@testing-library/react";
import axios from "axios";

const mockSetLoading = jest.fn();
const mockSetSnackbar = jest.fn();
const mockNavigate = jest.fn();

jest.mock("./state/global", () => ({
  useGlobalState: (key: string) => {
    if (key === "snackbar") return [{}, mockSetSnackbar];
    if (key === "loading") return [false, mockSetLoading];
    if (key === "authStatus") return [null, jest.fn()];
    throw new Error(`Unexpected global state key: ${key}`);
  },
}));

jest.mock("react-router", () => ({
  useLocation: () => ({ search: "", hash: "" }),
  useNavigate: () => mockNavigate,
  useParams: () => ({}),
}));

jest.mock("react-helmet-async", () => ({
  Helmet: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("./components/SubscribeToCreator", () => () => null);
jest.mock("./components/PageRenderer", () => ({
  __esModule: true,
  default: ({ page }: { page: { free2zaddr: string } }) => (
    <div data-testid="rendered-page">{page.free2zaddr}</div>
  ),
}));

jest.mock("axios");

import PageDetail from "./PageDetail";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function page(free2zaddr: string) {
  return {
    title: free2zaddr,
    content: "content",
    description: "description",
    tags: [],
    free2zaddr,
    p2paddr: "",
    vanity: free2zaddr,
    is_published: true,
    is_verified: false,
    is_subscriber_only: false,
    creator: { username: "same-owner", full_name: "Same Owner" },
    total: "0",
    f2z_score: "0",
    created_at: "2026-08-30T00:00:00Z",
    updated_at: "2026-08-30T00:00:00Z",
    comments: [],
    get_url: `/same-owner/${free2zaddr}`,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (axios.get as jest.Mock).mockReset();
});

it("re-encodes a decoded article identifier before the credentialed API call", async () => {
  (axios.get as jest.Mock).mockResolvedValueOnce({
    data: page("../twitter/start#"),
  });

  render(<PageDetail identifier="../twitter/start#" />);

  expect(await screen.findByTestId("rendered-page")).toBeTruthy();
  expect(axios.get).toHaveBeenCalledWith("/api/zpage/..%2Ftwitter%2Fstart%23/");
  expect(axios.get).not.toHaveBeenCalledWith("/api/twitter/start");
});

it("ignores a stale page response after the canonical identifier changes", async () => {
  const first = deferred<{ data: ReturnType<typeof page> }>();
  const second = deferred<{ data: ReturnType<typeof page> }>();
  (axios.get as jest.Mock)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);

  const view = render(
    <PageDetail identifier="page-a" expectedCreator="same-owner" />,
  );
  view.rerender(
    <PageDetail identifier="page-b" expectedCreator="same-owner" />,
  );

  await act(async () => {
    second.resolve({ data: page("page-b") });
    await second.promise;
  });
  expect(screen.getByTestId("rendered-page").textContent).toBe("page-b");

  await act(async () => {
    first.resolve({ data: page("page-a") });
    await first.promise;
  });
  expect(screen.getByTestId("rendered-page").textContent).toBe("page-b");
  expect(mockNavigate).not.toHaveBeenCalled();
});

it("hides a loaded page when a same-owner navigation fails", async () => {
  const first = deferred<{ data: ReturnType<typeof page> }>();
  const second = deferred<{ data: ReturnType<typeof page> }>();
  (axios.get as jest.Mock)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);

  const view = render(
    <PageDetail identifier="page-a" expectedCreator="same-owner" />,
  );
  await act(async () => {
    first.resolve({ data: page("page-a") });
    await first.promise;
  });
  expect(screen.getByTestId("rendered-page").textContent).toBe("page-a");

  view.rerender(
    <PageDetail identifier="page-b" expectedCreator="same-owner" />,
  );
  expect(screen.queryByTestId("rendered-page")).toBeNull();

  await act(async () => {
    second.reject(new Error("page-b failed"));
    await second.promise.catch(() => undefined);
  });
  expect(screen.queryByTestId("rendered-page")).toBeNull();
});
