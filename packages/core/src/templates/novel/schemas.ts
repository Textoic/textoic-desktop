import { z } from "zod";
import type { JsonSchema } from "../../providers/types.js";
import { ValidationError } from "../../actions/context.js";

const text = (description: string) => z.string().describe(description);
const list = (description: string) => z.array(z.string()).describe(description);

export const CoreStoryElementsSchema = z.object({
  tone: text("The tone of the story"),
  genres: list("Primary and secondary genres"),
  structure: text("The story arc chosen from the list, or the proposed one"),
  keyStages: list("3-5 key stages or turning points in this arc"),
  coreTheme: text("The central theme the story explores"),
  emotionalJourney: text("The emotional transformation arc for the protagonist"),
  initialSynopsis: text("A 2-paragraph version of what this story could be"),
  worldRules: list("5-7 essential rules or limitations if supernatural or fantasy elements exist, else empty"),
});

export const ProtagonistSchema = z.object({
  name: text("Full name, a real-world name congruent with the character"),
  age: text("Age"),
  physicalDescription: text("Key physical attributes"),
  traits: list("Salient personality traits in Big Five terms"),
  flaw: text("The main flaw: how their model of the world is incorrect"),
  desires: list("Conscious wants and unconscious needs"),
  fears: list("Fears, quirks and strengths worth knowing"),
  background: text("Brief, relevant backstory"),
  arc: text("The character arc from flaw to ignition point to transformation"),
});

export const SecondaryCharacterSchema = z.object({
  name: text("Full name"),
  role: text("Archetype: Mentor, Threshold Guardian, Herald, Shapeshifter, Shadow, Ally or Trickster"),
  relationship: text("Relationship to the protagonist"),
  physicalDescription: text("Key physical attributes"),
  motivation: text("What they want"),
  conflict: text("How they challenge, aid or oppose the protagonist"),
  arc: text("Their own journey and function in the story"),
});

export const SecondaryCharactersSchema = z.object({
  characters: z.array(SecondaryCharacterSchema).describe("3-8 secondary characters"),
});

export const WorldSettingsSchema = z.object({
  primaryLocations: list("3-5 key locations with brief descriptions"),
  timeframe: text("When the story takes place and over what duration"),
  atmosphere: text("The sensory and emotional qualities of this world"),
  naturalLaws: list("Modifications to physics or reality, else empty"),
  supernaturalElements: list("How supernatural elements function and their limitations, else empty"),
  consequences: list("What happens when the rules are broken"),
  powerStructures: text("Relevant social dynamics or hierarchies"),
  conflicts: text("Underlying tensions in this world"),
  symbols: list("3-5 symbolic elements, objects or motifs that will recur"),
});

export const PlotPointSchema = z.object({
  name: text("Key plot milestone"),
  description: text("What happens at this point"),
  wordCountLocation: z.number().describe("Approximate word count into the novel where this occurs"),
  characterImpact: text("How this affects the protagonist's journey"),
});

export const FrameworkSchema = z.object({
  title: text("A compelling title"),
  hook: text("The opening situation that draws readers in"),
  ignitionPoint: text("The event that disrupts the status quo and forces the protagonist to question their deepest beliefs"),
  plotPoints: z.array(PlotPointSchema).describe("6-8 major plot points"),
  climax: text("The final confrontation or revelation"),
  resolution: text("How the main conflict is resolved"),
  characterTransformation: text("How the protagonist is changed"),
});

export const PartsSchema = z.object({
  parts: z.array(
    z.object({
      title: text("The part's title"),
      synopsis: text("Two or more paragraphs of the key events and conversations in this part"),
      wordCount: z.number().describe("Target word count for the part"),
    }),
  ),
});

export const PartOutlineSchema = z.object({
  chapters: z.array(
    z.object({
      title: text("The chapter's title, without the word Chapter or a number"),
      synopsis: text("Two or more paragraphs of the key events and conversations in the chapter"),
      wordCount: z.number().describe("Approximate target word count, under 2500"),
      nsfw: z.boolean().describe("Whether the chapter contains explicit content"),
    }),
  ),
});

export const ChapterOutlineSchema = z.object({
  scenes: z.array(
    z.object({
      wordCount: z.number().describe("Approximate target word count for the scene, 500-1000"),
      synopsis: text("Three or more paragraphs of the key events and conversations in this scene"),
      nsfw: z.boolean().describe("Whether the scene contains explicit content"),
    }),
  ),
});

export const jsonSchemaOf = (schema: z.ZodType): JsonSchema =>
  z.toJSONSchema(schema, { target: "draft-7" }) as JsonSchema;

export const validator =
  <T>(schema: z.ZodType<T>) =>
  (value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError(
        result.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
          .join("; "),
      );
    }

    return result.data;
  };
