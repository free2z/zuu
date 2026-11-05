import React from "react";
import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "react-query";
import axios from "axios";
import {
  BlockedContent,
  BlockManagement,
  ModerationControls,
} from "./Moderation";
import { defaultCreator, setGlobalState } from "../state/global";
import { moderationCopy } from "./moderationCopy";

jest.mock("axios");
const api = axios as jest.Mocked<typeof axios>;
const actor = (id: number) => {
  setGlobalState("creator", { ...defaultCreator, id, username: `user${id}` });
  setGlobalState("authStatus", !!id);
};
const mount = (node: React.ReactNode) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {node}
    </QueryClientProvider>
  );

beforeEach(() => {
  jest.clearAllMocks();
  actor(1);
  api.get.mockResolvedValue({ data: { results: [], count: 0, next: null } });
  api.post.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
  (api as unknown as jest.Mock).mockResolvedValue({ data: { active: true } });
});

test.each([
  ["comment", "comment-id"],
  ["zpage", "page-id"],
  ["creator", "alice"],
] as const)(
  "reports %s with its authoritative target",
  async (kind, targetId) => {
    mount(
      <ModerationControls username="alice" kind={kind} targetId={targetId} />
    );
    fireEvent.click(await screen.findByRole("button", { name: "Report" }));
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/api/reports/",
        expect.objectContaining({
          target_kind: kind,
          target_id: targetId,
          reason: "csae",
        })
      )
    );
    expect(await screen.findByText("Report sent.")).toBeInTheDocument();
  }
);

test("block replaces existing content and management unblocks it", async () => {
  mount(
    <>
      <BlockedContent username="alice">
        <span>Visible content</span>
        <ModerationControls username="alice" kind="comment" targetId="1" />
      </BlockedContent>
      <BlockManagement />
    </>
  );
  const button = await screen.findByRole("button", { name: "Block" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(
    await screen.findByText("Content hidden from a blocked account.")
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Blocked accounts" }));
  fireEvent.click(await screen.findByRole("button", { name: "Unblock" }));
  await waitFor(() =>
    expect(api.delete).toHaveBeenCalledWith("/api/creator/alice/block/")
  );
  expect(await screen.findByText("Visible content")).toBeInTheDocument();
});

test("failed list is retryable and report errors are shown", async () => {
  api.get.mockRejectedValueOnce(new Error("offline"));
  api.post.mockRejectedValueOnce(new Error("offline"));
  mount(
    <>
      <BlockManagement />
      <ModerationControls username="alice" kind="creator" targetId="alice" />
    </>
  );
  fireEvent.click(screen.getByRole("button", { name: "Blocked accounts" }));
  expect(
    await screen.findByText(/Could not load blocked accounts/)
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No blocked accounts.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(await screen.findByRole("button", { name: "Report" }));
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  expect(
    await screen.findByText(/Could not complete the request/)
  ).toBeInTheDocument();
});

test("a late block does not affect a different account", async () => {
  let complete!: (value: unknown) => void;
  (api as unknown as jest.Mock).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      })
  );
  mount(
    <BlockedContent username="alice">
      <ModerationControls username="alice" kind="creator" targetId="alice" />
      <span>Visible content</span>
    </BlockedContent>
  );
  const button = await screen.findByRole("button", { name: "Block" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await act(async () => {
    actor(2);
  });
  await act(async () => {
    complete({ data: { active: true } });
  });
  await screen.findByText("Visible content");
  expect(
    screen.queryByText("Content hidden from a blocked account.")
  ).not.toBeInTheDocument();
});

test("moderation copy is translated for supported locales", () => {
  expect(moderationCopy("es-MX")[0]).toBe("Denunciar");
  expect(moderationCopy("fr")[0]).toBe("Signaler");
  expect(moderationCopy("pt-BR")[0]).toBe("Denunciar");
});

test("report controls can be opened and submitted with the keyboard", async () => {
  mount(<ModerationControls username="alice" kind="comment" targetId="123" />);
  await screen.findByRole("button", { name: "Report" });
  userEvent.tab();
  expect(screen.getByRole("button", { name: "Report" })).toHaveFocus();
  userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  screen.getByRole("button", { name: "Send report" }).focus();
  userEvent.keyboard("{Enter}");
  await waitFor(() => expect(api.post).toHaveBeenCalled());
});
