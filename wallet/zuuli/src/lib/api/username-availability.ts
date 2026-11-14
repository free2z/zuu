export interface UsernameAvailability {
  username: string | null;
  status: "available" | "taken" | "invalid";
}

/** Treat the server response as untrusted, including its canonical spelling. */
export function parseUsernameAvailability(input: string, response: unknown): UsernameAvailability {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Invalid availability response");
  const { username, status } = response as Record<string, unknown>;
  if (status !== "available" && status !== "taken" && status !== "invalid") throw new Error("Invalid availability response");
  const canonical = input.trim().normalize("NFKC");
  if (username !== canonical && !(status === "invalid" && username === null)) throw new Error("Invalid availability response");
  if (status !== "invalid" && (!canonical || [...canonical].length > 150 || !/^[\p{L}\p{N}_@.+-]+$/u.test(canonical))) throw new Error("Invalid availability response");
  return { username: username as string | null, status };
}
