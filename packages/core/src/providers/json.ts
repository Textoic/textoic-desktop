const FENCED = /```(?:json)?\s*([\s\S]*?)```/iu;

const firstBalanced = (text: string): string | null => {
  const start = text.search(/[[{]/u);
  if (start === -1) {
    return null;
  }

  const opener = text[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === opener) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
};

const candidates = (text: string): string[] => {
  const trimmed = text.trim();
  const fenced = FENCED.exec(trimmed);
  const balanced = firstBalanced(trimmed);
  return [trimmed, fenced?.[1]?.trim(), balanced].filter(
    (one): one is string => typeof one === "string" && one !== "",
  );
};

const repaired = (text: string) =>
  text
    .replace(/,\s*([}\]])/gu, "$1")
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'");

export class JsonParseError extends Error {
  readonly raw: string;
  constructor(raw: string) {
    super("The model did not return valid JSON.");
    this.name = "JsonParseError";
    this.raw = raw;
  }
}

export const parseJsonLoosely = <T = unknown>(text: string): T => {
  for (const candidate of candidates(text)) {
    for (const attempt of [candidate, repaired(candidate)]) {
      try {
        return JSON.parse(attempt) as T;
      } catch {
        continue;
      }
    }
  }

  throw new JsonParseError(text);
};
