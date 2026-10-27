import { render, screen } from "@testing-library/react";
import axios from "axios";

jest.mock("react-router", () => ({
  useParams: () => ({ id: "alice" }),
}));
jest.mock("react-helmet-async", () => ({
  Helmet: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("./components/DisplayCreator", () => ({
  __esModule: true,
  default: ({ username }: { username: string }) => <div>{username}</div>,
}));
jest.mock("./state/global", () => ({
  useGlobalState: () => [false, jest.fn()],
}));
jest.mock("axios");

import CreatorDetail, { PublicCreator } from "./CreatorDetail";

it("reuses a creator resolved by RootSplitter without fetching it twice", () => {
  const creator = {
    username: "alice",
    is_verified: false,
    total: 0,
    full_name: "Alice",
    description: "",
    p2paddr: "",
    zpages: 0,
    member_price: "1",
    can_stream: false,
    avatar_image: null,
    banner_image: null,
  } as PublicCreator;

  render(<CreatorDetail initialCreator={creator} />);

  expect(screen.getByText("alice")).toBeTruthy();
  expect(axios.get).not.toHaveBeenCalled();
});

it("renders a replacement resolved creator without one stale frame", () => {
  const alice = {
    username: "alice",
    is_verified: false,
    total: 0,
    full_name: "Alice",
    description: "",
    p2paddr: "",
    zpages: 0,
    member_price: "1",
    can_stream: false,
    avatar_image: null,
    banner_image: null,
  } as PublicCreator;
  const bob = { ...alice, username: "bob", full_name: "Bob" };

  const view = render(<CreatorDetail initialCreator={alice} />);
  expect(screen.getByText("alice")).toBeTruthy();

  view.rerender(<CreatorDetail initialCreator={bob} />);
  expect(screen.queryByText("alice")).toBeNull();
  expect(screen.getByText("bob")).toBeTruthy();
  expect(axios.get).not.toHaveBeenCalled();
});
