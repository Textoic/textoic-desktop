import { createTwoFilesPatch, diffWords } from "diff";

export interface ChangeSummary {
  addedWords: number;
  removedWords: number;
  unchanged: boolean;
}

const wordsIn = (text: string) => (text.match(/\S+/gu) ?? []).length;

export const summarizeChange = (before: string, after: string): ChangeSummary => {
  if (before === after) {
    return { addedWords: 0, removedWords: 0, unchanged: true };
  }

  const parts = diffWords(before, after);
  return parts.reduce(
    (summary, part) => ({
      ...summary,
      addedWords: summary.addedWords + (part.added ? wordsIn(part.value) : 0),
      removedWords:
        summary.removedWords + (part.removed ? wordsIn(part.value) : 0),
    }),
    { addedWords: 0, removedWords: 0, unchanged: false },
  );
};

export const unifiedDiff = (
  before: string,
  after: string,
  name = "document",
): string =>
  before === after
    ? ""
    : createTwoFilesPatch(name, name, before, after, "before", "after", {
        context: 2,
      });

export const describeChange = (summary: ChangeSummary): string =>
  summary.unchanged
    ? "no change"
    : [
        summary.addedWords > 0 ? `+${summary.addedWords} words` : "",
        summary.removedWords > 0 ? `-${summary.removedWords} words` : "",
      ]
        .filter((part) => part !== "")
        .join(", ") || "edited";
