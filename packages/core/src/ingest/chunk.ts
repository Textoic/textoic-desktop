import type { ContextChunk, ContextKind } from "../types.js";
import { estimateTokens } from "../util.js";

const TARGET_TOKENS = 350;
const MAX_TOKENS = 700;

type Piece = { at: number; end: number; heading?: string };

const HEADING = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t#]*$/u;

const paragraphs = (text: string): Piece[] => {
  const pieces: Piece[] = [];
  let heading: string | undefined;
  let offset = 0;
  for (const paragraph of text.split(/\n[ \t]*\n/u)) {
    const start = text.indexOf(paragraph, offset);
    const at = start === -1 ? offset : start;
    const end = at + paragraph.length;
    offset = end;
    if (paragraph.trim() === "") {
      continue;
    }

    const found = HEADING.exec(paragraph.split("\n")[0]);
    if (found) {
      heading = found[1].trim();
    }

    pieces.push({ at, end, heading });
  }

  return pieces;
};

const lines = (text: string, every: number): Piece[] => {
  const pieces: Piece[] = [];
  const all = text.split("\n");
  let offset = 0;
  for (let index = 0; index < all.length; index += every) {
    const slice = all.slice(index, index + every);
    const length = slice.reduce((total, line) => total + line.length + 1, 0) - 1;
    pieces.push({ at: offset, end: Math.min(text.length, offset + Math.max(0, length)) });
    offset += length + 1;
  }

  return pieces;
};

const split = (text: string, piece: Piece): Piece[] => {
  const size = piece.end - piece.at;
  const parts = Math.ceil(estimateTokens(text.slice(piece.at, piece.end)) / TARGET_TOKENS);
  if (parts <= 1) {
    return [piece];
  }

  const step = Math.ceil(size / parts);
  const made: Piece[] = [];
  let at = piece.at;
  while (at < piece.end) {
    const wanted = Math.min(piece.end, at + step);
    const breakAt = text.lastIndexOf(" ", wanted);
    const end = breakAt > at + step / 2 && wanted < piece.end ? breakAt : wanted;
    made.push({ at, end, heading: piece.heading });
    at = end;
  }

  return made;
};

const merged = (text: string, pieces: Piece[]): Piece[] =>
  pieces.reduce((made: Piece[], piece) => {
    const last = made[made.length - 1];
    if (
      last &&
      last.heading === piece.heading &&
      estimateTokens(text.slice(last.at, piece.end)) <= TARGET_TOKENS
    ) {
      made[made.length - 1] = { ...last, end: piece.end };
      return made;
    }

    return [...made, piece];
  }, []);

export const chunkText = (text: string, kind: ContextKind): ContextChunk[] => {
  const pieces =
    kind === "code" || kind === "data" ? lines(text, 40) : paragraphs(text);
  const sized = pieces.flatMap((piece) =>
    estimateTokens(text.slice(piece.at, piece.end)) > MAX_TOKENS
      ? split(text, piece)
      : [piece],
  );
  return merged(text, sized).map((piece, index) => ({
    id: `c${index}`,
    at: piece.at,
    end: piece.end,
    tokens: estimateTokens(text.slice(piece.at, piece.end)),
    ...(piece.heading ? { heading: piece.heading } : {}),
  }));
};

export const outlineOf = (text: string, kind: ContextKind): string[] => {
  if (kind === "code") {
    return (
      text.match(
        /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|def|fn|struct|enum|impl|pub fn|func)\s+[A-Za-z_$][\w$]*/gmu,
      ) ?? []
    )
      .map((line) => line.trim())
      .slice(0, 60);
  }

  return (text.match(/^[ \t]*#{1,6}[ \t]+.+$/gmu) ?? [])
    .map((line) => line.trim())
    .slice(0, 60);
};
