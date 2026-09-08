import type { NovelBlueprint, NovelSettings } from "../../types.js";

const list = (items: unknown): string[] =>
  Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [];

const bullets = (items: unknown) =>
  list(items)
    .map((item) => `- ${item}`)
    .join("\n");

const section = (title: string, body: string) =>
  body.trim() === "" ? "" : `## ${title}\n\n${body.trim()}\n`;

const lines = (parts: string[]) => parts.filter((line) => line !== "").join("\n\n");

export const renderSettings = (settings: NovelSettings) =>
  [
    `Concept: ${settings.prompt.trim()}`,
    `Genre: ${settings.genre}`,
    `Target length: about ${settings.wordCount} words`,
    settings.nsfw ? "The story contains explicit scenes." : "The story contains no explicit scenes.",
    settings.stylePrompt ? `Style notes: ${settings.stylePrompt.trim()}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

export const renderBlueprint = (blueprint: NovelBlueprint, settings?: NovelSettings): string => {
  const parts: string[] = [];
  if (settings) {
    parts.push(section("Story settings", renderSettings(settings)));
  }

  const core = blueprint.coreElements;
  if (core) {
    parts.push(
      section(
        "Core story elements",
        lines([
          `Tone: ${core.tone ?? ""}`,
          `Genres: ${list(core.genres).join(", ")}`,
          `Story arc: ${core.structure ?? ""}`,
          `Key stages:\n${bullets(core.keyStages)}`,
          `Core theme: ${core.coreTheme ?? ""}`,
          `Emotional journey: ${core.emotionalJourney ?? ""}`,
          `Initial synopsis:\n${core.initialSynopsis ?? ""}`,
          list(core.worldRules).length > 0 ? `World rules:\n${bullets(core.worldRules)}` : "",
        ]),
      ),
    );
  }

  const hero = blueprint.protagonist;
  if (hero) {
    parts.push(
      section(
        "Protagonist",
        lines([
          `Name: ${hero.name ?? ""} (${hero.age ?? ""})`,
          `Physical description: ${hero.physicalDescription ?? ""}`,
          `Traits: ${list(hero.traits).join(", ")}`,
          `Main flaw: ${hero.flaw ?? ""}`,
          `Desires: ${list(hero.desires).join("; ")}`,
          list(hero.fears).length > 0 ? `Fears and quirks: ${list(hero.fears).join("; ")}` : "",
          `Background: ${hero.background ?? ""}`,
          `Arc: ${hero.arc ?? ""}`,
        ]),
      ),
    );
  }

  const characters = blueprint.characters ?? [];
  if (characters.length > 0) {
    parts.push(
      section(
        "Secondary characters",
        characters
          .map(
            (character) =>
              `### ${character.name ?? "Unnamed"} — ${character.role ?? ""}\n\n${lines([
                `Relationship to protagonist: ${character.relationship ?? ""}`,
                `Physical description: ${character.physicalDescription ?? ""}`,
                `Motivation: ${character.motivation ?? ""}`,
                `Conflict: ${character.conflict ?? ""}`,
                `Arc: ${character.arc ?? ""}`,
              ])}`,
          )
          .join("\n\n"),
      ),
    );
  }

  const world = blueprint.world;
  if (world) {
    parts.push(
      section(
        "World",
        lines([
          `Primary locations:\n${bullets(world.primaryLocations)}`,
          `Timeframe: ${world.timeframe ?? ""}`,
          `Atmosphere: ${world.atmosphere ?? ""}`,
          list(world.naturalLaws).length > 0 ? `Natural laws:\n${bullets(world.naturalLaws)}` : "",
          list(world.supernaturalElements).length > 0 ? `Supernatural elements:\n${bullets(world.supernaturalElements)}` : "",
          list(world.consequences).length > 0 ? `Consequences of breaking the rules:\n${bullets(world.consequences)}` : "",
          `Power structures: ${world.powerStructures ?? ""}`,
          `Conflicts: ${world.conflicts ?? ""}`,
          `Symbols:\n${bullets(world.symbols)}`,
        ]),
      ),
    );
  }

  const framework = blueprint.framework;
  if (framework) {
    const points = Array.isArray(framework.plotPoints) ? framework.plotPoints : [];
    parts.push(
      section(
        "Framework",
        lines([
          `Title: ${framework.title ?? ""}`,
          `Hook: ${framework.hook ?? ""}`,
          `Ignition point: ${framework.ignitionPoint ?? ""}`,
          `Plot points:\n${points
            .map((point, index) => `${index + 1}. ${point.name ?? ""} (around word ${point.wordCountLocation ?? "?"}): ${point.description ?? ""} Impact: ${point.characterImpact ?? ""}`)
            .join("\n")}`,
          `Climax: ${framework.climax ?? ""}`,
          `Resolution: ${framework.resolution ?? ""}`,
          `Transformation: ${framework.characterTransformation ?? ""}`,
        ]),
      ),
    );
  }

  const planned = blueprint.parts ?? [];
  if (planned.length > 0) {
    parts.push(
      section(
        "Parts",
        planned.map((part) => `### Part ${part.number}: ${part.title ?? ""} (${part.wordCount ?? "?"} words)\n\n${part.synopsis ?? ""}`).join("\n\n"),
      ),
    );
  }

  const outlines = blueprint.partOutlines ?? [];
  if (outlines.length > 0) {
    parts.push(
      section(
        "Chapters",
        outlines
          .map(
            (outline) =>
              `### Part ${outline.partNumber}\n\n${(outline.chapters ?? [])
                .map((chapter) => `Chapter ${chapter.number}: ${chapter.title ?? ""} (${chapter.wordCount ?? "?"} words${chapter.nsfw ? ", explicit" : ""})\n${chapter.synopsis ?? ""}`)
                .join("\n\n")}`,
          )
          .join("\n\n"),
      ),
    );
  }

  return parts.filter((part) => part !== "").join("\n");
};
