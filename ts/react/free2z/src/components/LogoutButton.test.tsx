import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import LogoutButton from "./LogoutButton";

const mockClear = jest.fn();
const mockInvalidateQueries = jest.fn();

jest.mock("axios");
jest.mock("react-query", () => ({
  useQueryClient: () => ({
    clear: mockClear,
    invalidateQueries: mockInvalidateQueries,
  }),
}));
jest.mock("../state/global", () => ({
  defaultCreator: {},
  useGlobalState: () => [null, jest.fn()],
}));
jest.mock("./AvatarMenu", () => ({
  MenuItemWithIcon: ({
    onClick,
    label,
  }: {
    onClick: () => void;
    label: string;
  }) => <button onClick={onClick}>{label}</button>,
}));

test("confirmed logout prunes inserted replies and preserves paid recovery keys", async () => {
  (axios.post as jest.Mock).mockResolvedValue({});
  const insertedKey = "f2z:creator-ai-prompt:v1:alice:inserted";
  const recoveryKey = "f2z:creator-ai-prompt:v1:alice:unresolved";
  window.localStorage.setItem(
    insertedKey,
    JSON.stringify({
      completedAt: Date.now(),
      insertedAt: Date.now(),
    })
  );
  window.localStorage.setItem(
    recoveryKey,
    JSON.stringify({ key: "retry-key", body: { prompt: "unresolved" } })
  );
  window.localStorage.setItem("unrelated:cache", "keep");

  render(<LogoutButton />);
  fireEvent.click(screen.getByRole("button", { name: "Logout" }));

  await waitFor(() =>
    expect(window.localStorage.getItem(insertedKey)).toBeNull()
  );
  expect(window.localStorage.getItem(recoveryKey)).not.toBeNull();
  expect(window.localStorage.getItem("unrelated:cache")).toBe("keep");
  expect(mockClear).toHaveBeenCalled();
  window.localStorage.removeItem(recoveryKey);
  window.localStorage.removeItem("unrelated:cache");
});
