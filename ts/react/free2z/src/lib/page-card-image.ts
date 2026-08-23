const TUZI_CARD_IMAGE = "/docs/img/tuzi.svg";

type PageCardImage = {
  url: string;
  source: "featured" | "body" | "fallback";
};

function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const candidate = value.trim();
  const hasControlCharacter = candidate.split("").some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!candidate || hasControlCharacter) {
    return null;
  }

  try {
    const parsed = new URL(candidate, "https://free2z.invalid");
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && value[cursor] === "\\";
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function maskMatches(markdown: string, pattern: RegExp): string {
  const characters = markdown.split("");
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(markdown)) !== null) {
    const start = match.index || 0;
    for (let cursor = start; cursor < start + match[0].length; cursor += 1) {
      if (characters[cursor] !== "\n" && characters[cursor] !== "\r") {
        characters[cursor] = " ";
      }
    }
  }
  return characters.join("");
}

function maskCode(markdown: string): string {
  const withoutComments = maskMatches(markdown, /<!--[\s\S]*?-->/g);
  const withoutTildeFences = maskMatches(
    withoutComments,
    /^ {0,3}~{3,}[^\r\n]*(?:\r?\n|$)[\s\S]*?^ {0,3}~{3,}[ \t]*(?=\r?$)/gm
  );
  const characters = withoutTildeFences.split("");

  for (let index = 0; index < withoutTildeFences.length; ) {
    if (
      withoutTildeFences[index] !== "`" ||
      isEscaped(withoutTildeFences, index)
    ) {
      index += 1;
      continue;
    }

    let runLength = 1;
    while (withoutTildeFences[index + runLength] === "`") {
      runLength += 1;
    }

    const marker = "`".repeat(runLength);
    const closingIndex = withoutTildeFences.indexOf(marker, index + runLength);
    if (closingIndex === -1) {
      index += runLength;
      continue;
    }

    for (let cursor = index; cursor < closingIndex + runLength; cursor += 1) {
      if (characters[cursor] !== "\n" && characters[cursor] !== "\r") {
        characters[cursor] = " ";
      }
    }
    index = closingIndex + runLength;
  }

  return characters.join("");
}

function unescapeDestination(value: string): string {
  return value.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

function normalizeReference(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function referenceDefinitions(markdown: string): Map<string, string> {
  const definitions = new Map<string, string>();
  const definitionPattern =
    /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(?:<([^>\r\n]+)>|([^\s]+))/gm;

  let match: RegExpExecArray | null = null;
  while ((match = definitionPattern.exec(markdown)) !== null) {
    const url = safeImageUrl(unescapeDestination(match[2] || match[3]));
    if (url) {
      definitions.set(normalizeReference(match[1]), url);
    }
  }

  return definitions;
}

function closingBracket(markdown: string, start: number): number {
  let depth = 0;
  for (let index = start; index < markdown.length; index += 1) {
    if (isEscaped(markdown, index)) {
      continue;
    }
    if (markdown[index] === "[") {
      depth += 1;
    } else if (markdown[index] === "]") {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    }
  }
  return -1;
}

function inlineDestination(markdown: string, start: number): string | null {
  let cursor = start;
  while (markdown[cursor] === " " || markdown[cursor] === "\t") {
    cursor += 1;
  }

  if (markdown[cursor] === "<") {
    const end = markdown.indexOf(">", cursor + 1);
    if (end === -1 || !hasValidDestinationEnd(markdown, end + 1)) {
      return null;
    }
    return unescapeDestination(markdown.slice(cursor + 1, end));
  }

  const destinationStart = cursor;
  let parenthesisDepth = 0;
  for (; cursor < markdown.length; cursor += 1) {
    const character = markdown[cursor];
    if (isEscaped(markdown, cursor)) {
      continue;
    }
    if (character === "(") {
      parenthesisDepth += 1;
    } else if (character === ")") {
      if (parenthesisDepth === 0) {
        return unescapeDestination(markdown.slice(destinationStart, cursor));
      }
      parenthesisDepth -= 1;
    } else if (/\s/.test(character) && parenthesisDepth === 0) {
      return hasValidDestinationEnd(markdown, cursor)
        ? unescapeDestination(markdown.slice(destinationStart, cursor))
        : null;
    }
  }

  return null;
}

function hasValidDestinationEnd(markdown: string, start: number): boolean {
  let cursor = start;
  while (/\s/.test(markdown[cursor] || "")) {
    cursor += 1;
  }
  if (markdown[cursor] === ")") {
    return true;
  }

  const opener = markdown[cursor];
  const closer = opener === "(" ? ")" : opener;
  if (opener !== '"' && opener !== "'" && opener !== "(") {
    return false;
  }

  cursor += 1;
  while (cursor < markdown.length) {
    if (markdown[cursor] === closer && !isEscaped(markdown, cursor)) {
      cursor += 1;
      while (/\s/.test(markdown[cursor] || "")) {
        cursor += 1;
      }
      return markdown[cursor] === ")";
    }
    cursor += 1;
  }
  return false;
}

export function extractFirstArticleImage(content: unknown): string | null {
  if (typeof content !== "string" || !content.trim()) {
    return null;
  }

  const markdown = maskCode(content);
  const definitions = referenceDefinitions(markdown);

  for (let index = 0; index < markdown.length - 1; index += 1) {
    if (
      markdown[index] !== "!" ||
      markdown[index + 1] !== "[" ||
      isEscaped(markdown, index)
    ) {
      continue;
    }

    const altEnd = closingBracket(markdown, index + 2);
    if (altEnd === -1) {
      continue;
    }

    const nextCharacter = markdown[altEnd + 1];
    let candidate: string | null = null;
    if (nextCharacter === "(") {
      candidate = inlineDestination(markdown, altEnd + 2);
    } else if (nextCharacter === "[") {
      const referenceEnd = closingBracket(markdown, altEnd + 2);
      if (referenceEnd !== -1) {
        const reference =
          markdown.slice(altEnd + 2, referenceEnd) ||
          markdown.slice(index + 2, altEnd);
        candidate = definitions.get(normalizeReference(reference)) || null;
      }
    } else {
      const reference = markdown.slice(index + 2, altEnd);
      candidate = definitions.get(normalizeReference(reference)) || null;
    }

    const safeCandidate = safeImageUrl(candidate);
    if (safeCandidate) {
      return safeCandidate;
    }
    index = altEnd;
  }

  return null;
}

export function getPageCardImage(
  featuredImageUrl: string | null | undefined,
  content: unknown
): PageCardImage {
  if (featuredImageUrl) {
    return { url: featuredImageUrl, source: "featured" };
  }

  const bodyImageUrl = extractFirstArticleImage(content);
  if (bodyImageUrl) {
    return { url: bodyImageUrl, source: "body" };
  }

  return { url: TUZI_CARD_IMAGE, source: "fallback" };
}
