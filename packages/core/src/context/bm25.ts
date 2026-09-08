const STOPWORDS = new Set(
  "a an the and or but if then than that this these those of in on at to for from by with without as is are was were be been being it its it's he she they them his her their we you i me my our your not no yes do does did done have has had having will would can could should may might must shall about above after again against all am any because before below between both down during each few further here how into just more most off once only other out over own same so some such there through too under until up very what when where which while who whom why".split(
    " ",
  ),
);

const stem = (word: string) =>
  word.length > 3
    ? word.replace(/(?:ing|ed|es|s|ly|ment|ness|tion)$/u, "")
    : word;

export const terms = (text: string): string[] =>
  (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? [])
    .map((word) => word.replace(/['’]/gu, ""))
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map(stem);

export interface IndexedDocument {
  id: string;
  text: string;
}

export interface Hit {
  id: string;
  score: number;
}

type Posting = Map<string, number>;

export class Bm25Index {
  private readonly postings = new Map<string, Posting>();
  private readonly lengths = new Map<string, number>();
  private averageLength = 0;
  private readonly k1: number;
  private readonly b: number;

  constructor(documents: IndexedDocument[] = [], k1 = 1.4, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    documents.forEach((document) => this.add(document));
  }

  get size() {
    return this.lengths.size;
  }

  add({ id, text }: IndexedDocument) {
    const words = terms(text);
    this.lengths.set(id, words.length);
    const total = [...this.lengths.values()].reduce((sum, one) => sum + one, 0);
    this.averageLength = total / Math.max(1, this.lengths.size);
    for (const word of words) {
      const posting = this.postings.get(word) ?? new Map<string, number>();
      posting.set(id, (posting.get(id) ?? 0) + 1);
      this.postings.set(word, posting);
    }
  }

  search(query: string, limit = 10): Hit[] {
    const scores = new Map<string, number>();
    const count = this.lengths.size;
    for (const word of new Set(terms(query))) {
      const posting = this.postings.get(word);
      if (!posting) {
        continue;
      }

      const idf = Math.log(1 + (count - posting.size + 0.5) / (posting.size + 0.5));
      for (const [id, frequency] of posting) {
        const length = this.lengths.get(id) ?? 0;
        const normalized =
          (frequency * (this.k1 + 1)) /
          (frequency +
            this.k1 * (1 - this.b + (this.b * length) / Math.max(1, this.averageLength)));
        scores.set(id, (scores.get(id) ?? 0) + idf * normalized);
      }
    }

    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((one, other) => other.score - one.score)
      .slice(0, limit);
  }
}
