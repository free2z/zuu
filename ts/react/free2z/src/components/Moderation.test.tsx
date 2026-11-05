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
import {
  defaultCreator,
  getGlobalState,
  setGlobalState,
} from "../state/global";
import { moderationCopy } from "./moderationCopy";
import GlobalCreator from "../state/GlobalCreator";

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
  api.delete.mockResolvedValue({ data: { username: "alice", active: false } });
  (api as unknown as jest.Mock).mockResolvedValue({
    data: { username: "alice", active: true },
  });
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

test.each(["same", "other", "roundtrip"])(
  "a delayed block cannot cross %s session changes",
  async (transition) => {
    let finish!: (value: unknown) => void;
    (api as unknown as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    mount(
      <>
        <BlockedContent username="alice">
          <span>Visible content</span>
        </BlockedContent>
        <ModerationControls username="alice" kind="creator" targetId="alice" />
      </>
    );
    const block = await screen.findByRole("button", { name: "Block" });
    await waitFor(() => expect(block).toBeEnabled());
    fireEvent.click(block);
    await act(async () => {
      actor(0);
      actor(transition === "other" ? 2 : 1);
      if (transition === "roundtrip") {
        actor(2);
        actor(1);
      }
      finish({ data: { username: "alice", active: true } });
    });
    expect(screen.getByText("Visible content")).toBeInTheDocument();
    expect(
      screen.queryByText("Content hidden from a blocked account.")
    ).not.toBeInTheDocument();
  }
);

test("a malformed list is an error rather than an empty list", async () => {
  api.get.mockResolvedValueOnce({
    data: { count: 3, next: null, results: [] },
  });
  mount(<BlockManagement />);
  fireEvent.click(screen.getByRole("button", { name: "Blocked accounts" }));
  expect(
    await screen.findByText(/Could not load blocked accounts/)
  ).toBeInTheDocument();
  expect(screen.queryByText("No blocked accounts.")).not.toBeInTheDocument();
});

test("report success from an earlier session is cleared on same-account login", async () => {
  mount(
    <ModerationControls username="alice" kind="creator" targetId="alice" />
  );
  fireEvent.click(await screen.findByRole("button", { name: "Report" }));
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  expect(await screen.findByText("Report sent.")).toBeInTheDocument();
  await act(async () => {
    actor(0);
    actor(1);
  });
  expect(screen.queryByText("Report sent.")).not.toBeInTheDocument();
});

test("authoritative same-account identity refresh replaces cached private names", async () => {
  let fresh = false;
  api.get.mockImplementation(async (url) => {
    if (url === "/api/auth/user/")
      return { data: { ...defaultCreator, id: 1, username: "user1" } };
    return {
      data: {
        count: 1,
        next: null,
        results: [{ username: fresh ? "fresh" : "private-old" }],
      },
    };
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <GlobalCreator />
      <BlockManagement />
    </QueryClientProvider>
  );
  await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/auth/user/"));
  await waitFor(() =>
    expect(
      client.getQueryData(["moderation-blocks", 1, getGlobalState("authEpoch")])
    ).toEqual(["private-old"])
  );
  fireEvent.click(screen.getByRole("button", { name: "Blocked accounts" }));
  expect(await screen.findByText("@private-old")).toBeInTheDocument();
  fresh = true;
  await act(async () => {
    await client.invalidateQueries("creatorData");
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Blocked accounts" })
  );
  expect(await screen.findByText("@fresh")).toBeInTheDocument();
  expect(screen.queryByText("@private-old")).not.toBeInTheDocument();
});

test.each([false, true])(
  "HTTP failure leaves membership unchanged (already blocked: %s)",
  async (alreadyBlocked) => {
    api.get.mockResolvedValue({
      data: {
        count: alreadyBlocked ? 1 : 0,
        next: null,
        results: alreadyBlocked ? [{ username: "alice" }] : [],
      },
    });
    api.delete.mockRejectedValueOnce(new Error("offline"));
    (api as unknown as jest.Mock).mockRejectedValueOnce(new Error("offline"));
    mount(
      <>
        <BlockedContent username="alice">
          <span>Visible content</span>
        </BlockedContent>
        <ModerationControls username="alice" kind="creator" targetId="alice" />
      </>
    );
    const button = await screen.findByRole("button", {
      name: alreadyBlocked ? "Unblock" : "Block",
    });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(
      await screen.findByText(/Could not complete the request/)
    ).toBeInTheDocument();
    if (alreadyBlocked)
      expect(
        screen.getByText("Content hidden from a blocked account.")
      ).toBeInTheDocument();
    else expect(screen.getByText("Visible content")).toBeInTheDocument();
  }
);

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

test.each(["same", "other", "roundtrip"])(
  "a delayed list cannot cross %s session changes",
  async (transition) => {
    let finish!: (value: unknown) => void;
    api.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    mount(<BlockManagement />);
    fireEvent.click(screen.getByRole("button", { name: "Blocked accounts" }));
    await waitFor(() => expect(finish).toBeDefined());
    await act(async () => {
      actor(0);
      actor(transition === "other" ? 2 : 1);
      if (transition === "roundtrip") {
        actor(2);
        actor(1);
      }
    });
    await act(async () =>
      finish({
        data: {
          count: 49,
          next: "next",
          results: [{ username: "private-old" }],
        },
      })
    );
    expect(await screen.findByText("No blocked accounts.")).toBeInTheDocument();
    expect(screen.queryByText("@private-old")).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
  }
);

test.each(["same", "other", "roundtrip"])(
  "a delayed second page cannot publish after %s session changes",
  async (transition) => {
    let finish!: (value: unknown) => void;
    api.get.mockResolvedValueOnce({
      data: {
        count: 49,
        next: "next",
        results: Array.from({ length: 48 }, (_, i) => ({
          username: `old${i}`,
        })),
      },
    });
    api.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    mount(<BlockManagement />);
    fireEvent.click(screen.getByRole("button", { name: "Blocked accounts" }));
    await waitFor(() => expect(finish).toBeDefined());
    await act(async () => {
      actor(0);
      actor(transition === "other" ? 2 : 1);
      if (transition === "roundtrip") {
        actor(2);
        actor(1);
      }
    });
    await act(async () =>
      finish({
        data: { count: 49, next: null, results: [{ username: "private-old" }] },
      })
    );
    expect(await screen.findByText("No blocked accounts.")).toBeInTheDocument();
    expect(screen.queryByText("@private-old")).not.toBeInTheDocument();
    expect(screen.queryByText("@old1")).not.toBeInTheDocument();
  }
);

test.each([
  { username: "wrong", active: false },
  { username: "alice", active: true },
  {},
])(
  "unblock rejects an invalid response and retains membership",
  async (data) => {
    api.get.mockResolvedValue({
      data: { count: 1, next: null, results: [{ username: "alice" }] },
    });
    api.delete.mockResolvedValue({ data });
    mount(<BlockManagement />);
    fireEvent.click(screen.getByRole("button", { name: "Blocked accounts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Unblock" }));
    expect(
      await screen.findByText(/Could not complete the request/)
    ).toBeInTheDocument();
    expect(screen.getByText("@alice")).toBeInTheDocument();
  }
);

test.each([
  { username: "wrong", active: true },
  { username: "alice", active: false },
  {},
])(
  "a malformed block response does not update visible content",
  async (data) => {
    (api as unknown as jest.Mock).mockResolvedValue({ data });
    mount(
      <>
        <BlockedContent username="alice">
          <span>Visible content</span>
        </BlockedContent>
        <ModerationControls username="alice" kind="creator" targetId="alice" />
      </>
    );
    const block = await screen.findByRole("button", { name: "Block" });
    await waitFor(() => expect(block).toBeEnabled());
    fireEvent.click(block);
    expect(
      await screen.findByText(/Could not complete the request/)
    ).toBeInTheDocument();
    expect(screen.getByText("Visible content")).toBeInTheDocument();
  }
);

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
