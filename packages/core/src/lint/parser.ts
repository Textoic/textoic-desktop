import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import nlp, {
  type Dictionary,
  type FeatureWeights,
  type LexicalProps,
  type ParsedToken,
} from "nlp";

export type Parser = (text: string) => ParsedToken[][];

type StoredWeights = { featureSet?: number; weights?: FeatureWeights };

const load = async <T>(specifier: string): Promise<T> =>
  JSON.parse(
    await readFile(fileURLToPath(import.meta.resolve(specifier)), "utf8"),
  ) as T;

let loading: Promise<Parser> | null = null;

export const loadParser = (): Promise<Parser> => {
  loading ??= (async () => {
    const [entries, stored] = await Promise.all([
      load<[string, LexicalProps][]>("nlp/dictionary.json"),
      load<StoredWeights | FeatureWeights>("nlp/weights.json").catch(
        () => ({}) as StoredWeights,
      ),
    ]);
    const dictionary: Dictionary = new Map(entries);
    const weights: FeatureWeights =
      "weights" in stored
        ? ((stored as StoredWeights).weights ?? {})
        : (stored as FeatureWeights);
    const quiet = console.debug;
    console.debug = () => undefined;
    const parse: Parser = (text) => nlp(text, { dictionary, weights });
    parse("Warm up the parser.");
    console.debug = quiet;
    return (text) => {
      const restore = console.debug;
      console.debug = () => undefined;
      try {
        return parse(text);
      } finally {
        console.debug = restore;
      }
    };
  })();
  return loading;
};
