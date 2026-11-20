import { expect, it, vi } from "vitest";
import { nativeDiagnosticsReport } from "@free2z/wallet-shared";
const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => native);
import { readNativeDiagnostics } from "./native-diagnostics";

it("reads exactly one argument-free command and revalidates the bounded native grammar", async () => {
  native.invoke.mockResolvedValue("native-panic 123 42 5\n");
  expect(await readNativeDiagnostics()).toContain("native-panic 123 42 5");
  expect(native.invoke).toHaveBeenCalledWith("native_diagnostics_report");
  for (const value of ["seed abandon", "native-panic 1 2 3\nhttps://private.invalid", "native-panic 1 2 3\n".repeat(41), "x".repeat(4097), {}]) {
    native.invoke.mockResolvedValue(value);
    expect(await readNativeDiagnostics()).toBeNull();
  }
  expect(nativeDiagnosticsReport("")).toContain("Native panic records");
  native.invoke.mockRejectedValue(new Error("/private/secret"));
  expect(await readNativeDiagnostics()).toBeNull();
  native.isTauri.mockReturnValue(false);
  native.invoke.mockClear();
  expect(await readNativeDiagnostics()).toBeNull();
  expect(native.invoke).not.toHaveBeenCalled();
});
