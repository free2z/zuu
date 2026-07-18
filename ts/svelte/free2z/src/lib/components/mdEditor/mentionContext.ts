export type MentionContext = {
  start: number;
  query: string;
};

export const MENTION_QUERY_MAX_LENGTH = 30;

export function getMentionContext(
  content: string,
  cursorPosition: number,
): MentionContext | null {
  const lineStart = content.lastIndexOf("\n", cursorPosition - 1) + 1;
  const line = content.slice(lineStart, cursorPosition);
  const atIndex = line.lastIndexOf("@");

  if (atIndex === -1) {
    return null;
  }

  if (atIndex > 0 && !/\s/.test(line[atIndex - 1])) {
    return null;
  }

  const query = line.slice(atIndex + 1);

  if (query.length > MENTION_QUERY_MAX_LENGTH || !/^[\w.+-]*$/.test(query)) {
    return null;
  }

  return { start: lineStart + atIndex, query };
}
