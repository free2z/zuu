import React from "react";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "react-query";
import { MemoryRouter } from "react-router-dom";
import axios from "axios";
import { defaultCreator, setGlobalState } from "../state/global";
import CommentCard from "./CommentCard";
import CommentCardInfinite from "./CommentCardInfinite";

jest.mock("axios");
jest.mock("./MathMarkdown", () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));
jest.mock("./CommentVote", () => () => null);
jest.mock("./CommentVoteInfinite", () => () => null);
jest.mock("./ThreadedCommentReplyAction", () => () => null);

const comment = {
  uuid: "comment-1",
  author: { username: "alice" },
  parent: null,
  headline: "Hello",
  content: "Comment body",
  tuzis: 1,
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
  num_children: 0,
  content_url: null,
};
const api = axios as jest.Mocked<typeof axios>;

test.each(["thread", "feed"])(
  "%s comment exposes report and block controls",
  async (variant) => {
    setGlobalState("creator", { ...defaultCreator, id: 1, username: "reader" });
    setGlobalState("authStatus", true);
    api.get.mockResolvedValue({ data: { results: [], count: 0, next: null } });
    api.post.mockResolvedValue({ data: {} });
    (api as unknown as jest.Mock).mockResolvedValue({ data: { active: true } });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          {variant === "thread" ? (
            <CommentCard comment={comment} setReload={jest.fn()} />
          ) : (
            <CommentCardInfinite comment={comment} />
          )}
        </MemoryRouter>
      </QueryClientProvider>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Report" }));
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/api/reports/",
        expect.objectContaining({
          target_kind: "comment",
          target_id: comment.uuid,
        })
      )
    );
    const button = await screen.findByRole("button", { name: "Block" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(
      await screen.findByText("Content hidden from a blocked account.")
    ).toBeInTheDocument();
  }
);

jest.mock("./CreatorDonate", () => () => null);
jest.mock("./UpDownPage", () => () => null);
jest.mock("./profile/CreatorSupport", () => () => null);
jest.mock("./profile/HeroBanner", () => () => null);
jest.mock("./Find", () => () => null);
jest.mock("../hooks/useTransitionNavigate", () => ({
  useTransitionNavigate: () => jest.fn(),
}));

const PageListRow = require("./PageListRow2").default;
const DisplayCreator = require("./DisplayCreator").default;

test.each(["zpage", "creator"])(
  "%s entry renders actionable moderation controls",
  async (kind) => {
    setGlobalState("creator", { ...defaultCreator, id: 1, username: "reader" });
    setGlobalState("authStatus", true);
    api.get.mockResolvedValue({ data: { results: [], count: 0, next: null } });
    api.post.mockResolvedValue({ data: {} });
    (api as unknown as jest.Mock).mockResolvedValue({ data: { active: true } });
    const creator = {
      ...defaultCreator,
      id: 2,
      username: "alice",
      description: "Creator text",
      zpages: 0,
    };
    const page = {
      creator,
      mine: false,
      free2zaddr: "page-1",
      vanity: "page",
      title: "Page title",
      content: "Page body",
      get_url: "/alice/page",
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          {kind === "zpage" ? (
            <PageListRow {...page} />
          ) : (
            <DisplayCreator {...creator} />
          )}
        </MemoryRouter>
      </QueryClientProvider>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Report" }));
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/api/reports/",
        expect.objectContaining({
          target_kind: kind,
          target_id: kind === "zpage" ? "page-1" : "alice",
        })
      )
    );
    const block = await screen.findByRole("button", { name: "Block" });
    await waitFor(() => expect(block).toBeEnabled());
    fireEvent.click(block);
    expect(
      await screen.findByText("Content hidden from a blocked account.")
    ).toBeInTheDocument();
  }
);
