import type { ActionContext } from "../../actions/context.js";
import type { PlannedCall } from "../../cost.js";
import type { ChapterOutline, NovelBlueprint, NovelSettings, SceneOutline } from "../../types.js";
import { countWords } from "../../util.js";
import { chapterOutlinePrompt, personality, scenePrompt } from "./prompts.js";
import { ChapterOutlineSchema, jsonSchemaOf, validator } from "./schemas.js";

const OUTLINE_TOKENS = 3000;
const SCENE_TOKENS = 2200;
const MIN_SCENE_WORDS = 350;
const SCENE_ATTEMPTS = 2;

export interface ChapterDraft {
  outline: ChapterOutline;
  title: string;
  scenes: string[];
  markdown: string;
}

export const plannedChapterCalls = (
  settings: NovelSettings,
  blueprint: NovelBlueprint,
  partNumber = 1,
  chapterNumber = 1,
): PlannedCall[] => {
  const chapter = blueprint.partOutlines
    ?.find((one) => one.partNumber === partNumber)
    ?.chapters.find((one) => one.number === chapterNumber);
  const scenes = Math.max(2, Math.ceil((chapter?.wordCount ?? 2000) / 750));
  return [
    {
      stage: "chapter outline",
      messages: [personality(settings.nsfw), { role: "user", content: chapterOutlinePrompt(settings, blueprint, partNumber, chapterNumber) }],
      maxOutputTokens: OUTLINE_TOKENS,
    },
    ...Array.from({ length: scenes }, (_, index) => ({
      stage: `scene ${index + 1}`,
      inputTokens: 3000 + index * 900,
      maxOutputTokens: SCENE_TOKENS,
    })),
  ];
};

const assemble = (blueprint: NovelBlueprint, outline: ChapterOutline, title: string, scenes: string[]) =>
  [
    blueprint.framework ? `# ${blueprint.framework.title}` : "",
    `## Chapter ${outline.chapterNumber}: ${title}`,
    ...scenes.map((scene) => scene.trim()),
  ]
    .filter((part) => part !== "")
    .join("\n\n");

export const generateChapter = async (
  ctx: ActionContext,
  settings: NovelSettings,
  blueprint: NovelBlueprint,
  partNumber = 1,
  chapterNumber = 1,
): Promise<ChapterDraft> => {
  const plan = blueprint.partOutlines
    ?.find((one) => one.partNumber === partNumber)
    ?.chapters.find((one) => one.number === chapterNumber);
  if (!plan) {
    throw new Error("The blueprint has no chapter outline for that chapter yet.");
  }

  ctx.progress({ step: "outlining chapter scenes", done: 0, total: 1 });
  const outlined = await ctx.callJson(
    "chapter outline",
    {
      messages: [personality(settings.nsfw), { role: "user", content: chapterOutlinePrompt(settings, blueprint, partNumber, chapterNumber) }],
      maxOutputTokens: OUTLINE_TOKENS,
      temperature: 0.7,
    },
    jsonSchemaOf(ChapterOutlineSchema),
    validator(ChapterOutlineSchema),
  );
  const outline: ChapterOutline = {
    partNumber,
    chapterNumber,
    scenes: outlined.scenes.map((scene, index) => ({ number: index + 1, ...scene })),
  };

  const scenes: string[] = [];
  for (const [index, scene] of outline.scenes.entries()) {
    ctx.progress({ step: `writing scene ${index + 1} of ${outline.scenes.length}`, done: index, total: outline.scenes.length });
    scenes.push(await writeScene(ctx, settings, blueprint, outline, scene, index, scenes));
  }

  ctx.progress({ step: "chapter written", done: outline.scenes.length, total: outline.scenes.length });
  return { outline, title: plan.title, scenes, markdown: assemble(blueprint, outline, plan.title, scenes) };
};

const writeScene = async (
  ctx: ActionContext,
  settings: NovelSettings,
  blueprint: NovelBlueprint,
  outline: ChapterOutline,
  scene: SceneOutline,
  index: number,
  previous: string[],
): Promise<string> => {
  let best = "";
  for (let attempt = 0; attempt < SCENE_ATTEMPTS; attempt += 1) {
    const result = await ctx.call(`scene ${scene.number}${attempt > 0 ? ` (retry ${attempt})` : ""}`, {
      messages: scenePrompt({
        settings,
        blueprint,
        partNumber: outline.partNumber,
        chapterNumber: outline.chapterNumber,
        sceneNumber: scene.number,
        scene,
        next: outline.scenes[index + 1] ?? null,
        previousScenes: previous,
      }),
      maxOutputTokens: SCENE_TOKENS,
      temperature: 0.8,
    });
    const text = result.content.trim();
    if (countWords(text) > countWords(best)) {
      best = text;
    }

    if (countWords(best) >= MIN_SCENE_WORDS) {
      break;
    }
  }

  return best;
};
