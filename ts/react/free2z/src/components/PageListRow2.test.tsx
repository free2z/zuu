import { render, screen } from "@testing-library/react";

import PageListRow from "./PageListRow2";

jest.mock("@mui/icons-material", () => ({
  Edit: () => null,
  MoreVert: () => null,
}));

jest.mock("@mui/material", () => {
  const React = require("react");
  const Wrapper = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  const CardMedia = React.forwardRef(
    (
      {
        image,
        style,
        title,
      }: { image: string; style: { opacity: number }; title: string },
      ref: React.ForwardedRef<HTMLDivElement>
    ) => (
      <div
        ref={ref}
        data-testid="page-card-image"
        data-image={image}
        data-opacity={style.opacity}
        title={title}
      />
    )
  );
  CardMedia.displayName = "CardMedia";

  return {
    Avatar: Wrapper,
    Box: Wrapper,
    Card: Wrapper,
    CardContent: Wrapper,
    CardHeader: Wrapper,
    CardMedia,
    Divider: Wrapper,
    Grid: Wrapper,
    IconButton: Wrapper,
    Link: Wrapper,
    ListItem: Wrapper,
    Popover: Wrapper,
    Stack: Wrapper,
    Tooltip: Wrapper,
    Typography: Wrapper,
    useMediaQuery: () => false,
  };
});

jest.mock("moment", () => () => ({ fromNow: () => "now" }));
jest.mock("../state/global", () => ({
  useGlobalState: () => [{ username: "viewer", stars: [] }, jest.fn()],
}));
jest.mock("../hooks/useTransitionNavigate", () => ({
  useTransitionNavigate: () => jest.fn(),
}));
jest.mock("./CreatorDonate", () => () => null);
jest.mock("./UpDownPage", () => () => null);
jest.mock("./TransitionLink", () => () => null);
jest.mock("./profile/CreatorSupport", () => () => null);

const page = {
  creator: {
    username: "alice",
    is_verified: false,
    total: 0,
    full_name: "Alice",
    description: "",
    p2paddr: "creator-address",
    zpages: 1,
    member_price: "",
    can_stream: false,
    avatar_image: null,
    banner_image: null,
  },
  get_url: "/alice/article",
  vanity: "article",
  title: "Article",
  content: "![Body](/uploads/body.jpg)",
  description: "",
  tags: [],
  free2zaddr: "article-id",
  p2paddr: "address",
  featured_image: {
    name: "featured.jpg",
    title: "Featured",
    access: "public" as const,
    thumbnail: "/uploads/featured.jpg",
  },
  is_verified: false,
  is_published: true,
  is_subscriber_only: false,
  total: "0",
  f2z_score: "0",
  created_at: "2026-08-23T00:00:00Z",
  updated_at: "2026-08-23T00:00:00Z",
  comments: [],
};

test("uses the selected card image and fallback opacity in the classic card", () => {
  const { rerender } = render(<PageListRow {...page} mine={false} />);
  expect(screen.getByTestId("page-card-image").getAttribute("data-image")).toBe(
    "/uploads/featured.jpg"
  );
  expect(
    screen.getByTestId("page-card-image").getAttribute("data-opacity")
  ).toBe("1");

  rerender(<PageListRow {...page} featured_image={null} mine={false} />);
  expect(screen.getByTestId("page-card-image").getAttribute("data-image")).toBe(
    "/uploads/body.jpg"
  );
  expect(
    screen.getByTestId("page-card-image").getAttribute("data-opacity")
  ).toBe("1");

  rerender(
    <PageListRow
      {...page}
      content="Text only"
      featured_image={null}
      mine={false}
    />
  );
  expect(screen.getByTestId("page-card-image").getAttribute("data-image")).toBe(
    "/docs/img/tuzi.svg"
  );
  expect(
    screen.getByTestId("page-card-image").getAttribute("data-opacity")
  ).toBe("0.25");
});
