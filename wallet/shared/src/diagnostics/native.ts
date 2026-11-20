/** Native transport accepts only the fixed payload-free Rust record grammar. */
export function nativeDiagnosticsReport(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  const lines = value === "" ? [] : value.trimEnd().split("\n");
  if (lines.length > 40 || lines.some((line) => !/^native-panic \d{1,20} \d{1,10} \d{1,10}$/u.test(line))) return null;
  return ["### Native panic records", "", ...lines, "", "Panic payloads and filenames are omitted."].join("\n");
}
