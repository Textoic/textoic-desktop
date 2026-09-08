import type { z } from "zod";
import type { ActionContext } from "../../actions/context.js";
import type { PlannedCall } from "../../cost.js";
import {
  BLUEPRINT_STEPS,
  type BlueprintStep,
  type ChatMessage,
  type NovelBlueprint,
  type NovelSettings,
  type PartOutline,
} from "../../types.js";
import { estimateMessageTokens, id } from "../../util.js";
import {
  charactersPrompt,
  coreElementsPrompt,
  frameworkPrompt,
  partOutlinePrompt,
  partsPrompt,
  personality,
  protagonistPrompt,
  worldPrompt,
} from "./prompts.js";
import {
  CoreStoryElementsSchema,
  FrameworkSchema,
  PartOutlineSchema,
  PartsSchema,
  ProtagonistSchema,
  SecondaryCharactersSchema,
  WorldSettingsSchema,
  jsonSchemaOf,
  validator,
} from "./schemas.js";

interface StepSpec {
  step: BlueprintStep;
  schema: z.ZodType;
  maxOutputTokens: number;
  prompt: (settings: NovelSettings, blueprint: NovelBlueprint) => string;
  apply: (blueprint: NovelBlueprint, value: unknown) => NovelBlueprint;
}

const SINGLE_STEPS: StepSpec[] = [
  {
    step: "coreElements",
    schema: CoreStoryElementsSchema,
    maxOutputTokens: 2000,
    prompt: coreElementsPrompt,
    apply: (blueprint, value) => ({ ...blueprint, coreElements: value as NovelBlueprint["coreElements"] }),
  },
  {
    step: "protagonist",
    schema: ProtagonistSchema,
    maxOutputTokens: 2000,
    prompt: protagonistPrompt,
    apply: (blueprint, value) => ({ ...blueprint, protagonist: value as NovelBlueprint["protagonist"] }),
  },
  {
    step: "characters",
    schema: SecondaryCharactersSchema,
    maxOutputTokens: 4000,
    prompt: charactersPrompt,
    apply: (blueprint, value) => ({
      ...blueprint,
      characters: (value as z.infer<typeof SecondaryCharactersSchema>).characters.map((character) => ({
        id: id(),
        ...character,
      })),
    }),
  },
  {
    step: "world",
    schema: WorldSettingsSchema,
    maxOutputTokens: 3000,
    prompt: worldPrompt,
    apply: (blueprint, value) => ({ ...blueprint, world: value as NovelBlueprint["world"] }),
  },
  {
    step: "framework",
    schema: FrameworkSchema,
    maxOutputTokens: 3000,
    prompt: frameworkPrompt,
    apply: (blueprint, value) => {
      const framework = value as z.infer<typeof FrameworkSchema>;
      return {
        ...blueprint,
        framework: {
          ...framework,
          plotPoints: framework.plotPoints.map((point) => ({ id: id(), ...point })),
        },
      };
    },
  },
  {
    step: "parts",
    schema: PartsSchema,
    maxOutputTokens: 4000,
    prompt: partsPrompt,
    apply: (blueprint, value) => ({
      ...blueprint,
      parts: (value as z.infer<typeof PartsSchema>).parts.map((part, index) => ({ number: index + 1, ...part })),
      partOutlines: undefined,
    }),
  },
];

const PART_OUTLINE_TOKENS = 5000;

export const isStepDone = (blueprint: NovelBlueprint, step: BlueprintStep) =>
  step === "partOutlines"
    ? (blueprint.partOutlines?.length ?? 0) > 0 &&
      blueprint.partOutlines?.length === blueprint.parts?.length
    : blueprint[step] !== undefined;

export const remainingSteps = (blueprint: NovelBlueprint): BlueprintStep[] =>
  BLUEPRINT_STEPS.filter((step) => !isStepDone(blueprint, step));

const messagesFor = (spec: StepSpec, settings: NovelSettings, blueprint: NovelBlueprint): ChatMessage[] => [
  personality(settings.nsfw),
  { role: "user", content: spec.prompt(settings, blueprint) },
];

export const plannedBlueprintCalls = (
  settings: NovelSettings,
  blueprint: NovelBlueprint,
  steps: BlueprintStep[],
): PlannedCall[] => {
  const planned: PlannedCall[] = [];
  for (const [index, step] of steps.entries()) {
    const spec = SINGLE_STEPS.find((one) => one.step === step);
    if (spec) {
      planned.push({
        stage: `blueprint:${step}`,
        inputTokens: estimateMessageTokens(messagesFor(spec, settings, blueprint)) + index * 700,
        maxOutputTokens: spec.maxOutputTokens,
      });
      continue;
    }

    const parts = Math.max(1, blueprint.parts?.length ?? 3);
    for (let number = 1; number <= parts; number += 1) {
      planned.push({
        stage: `blueprint:part ${number} outline`,
        inputTokens: 3500 + number * 800,
        maxOutputTokens: PART_OUTLINE_TOKENS,
      });
    }
  }

  return planned;
};

export const generateBlueprintSteps = async (
  ctx: ActionContext,
  settings: NovelSettings,
  initial: NovelBlueprint,
  steps: BlueprintStep[],
  onStep?: (blueprint: NovelBlueprint, step: BlueprintStep) => Promise<void>,
): Promise<NovelBlueprint> => {
  let blueprint = initial;
  const total = steps.length;
  for (const [index, step] of steps.entries()) {
    ctx.progress({ step: `blueprint: ${step}`, done: index, total });
    const spec = SINGLE_STEPS.find((one) => one.step === step);
    if (spec) {
      const value = await ctx.callJson(
        `blueprint:${step}`,
        { messages: messagesFor(spec, settings, blueprint), maxOutputTokens: spec.maxOutputTokens, temperature: 0.7 },
        jsonSchemaOf(spec.schema),
        validator(spec.schema),
      );
      blueprint = spec.apply(blueprint, value);
    } else {
      blueprint = await generatePartOutlines(ctx, settings, blueprint, index, total);
    }

    await onStep?.(blueprint, step);
  }

  ctx.progress({ step: "blueprint: done", done: total, total });
  return blueprint;
};

const generatePartOutlines = async (
  ctx: ActionContext,
  settings: NovelSettings,
  blueprint: NovelBlueprint,
  index: number,
  total: number,
): Promise<NovelBlueprint> => {
  const parts = blueprint.parts ?? [];
  if (parts.length === 0) {
    throw new Error("Generate the parts before the chapter outlines.");
  }

  const outlines: PartOutline[] = [];
  for (const part of parts) {
    ctx.progress({
      step: `blueprint: chapters of part ${part.number}/${parts.length}`,
      done: index,
      total,
      message: `Outlining chapters for part ${part.number} of ${parts.length}`,
    });
    const value = await ctx.callJson(
      `blueprint:part ${part.number} outline`,
      {
        messages: [personality(settings.nsfw), { role: "user", content: partOutlinePrompt(settings, blueprint, part.number, outlines) }],
        maxOutputTokens: PART_OUTLINE_TOKENS,
        temperature: 0.7,
      },
      jsonSchemaOf(PartOutlineSchema),
      validator(PartOutlineSchema),
    );
    outlines.push({
      partNumber: part.number,
      chapters: value.chapters.map((chapter, chapterIndex) => ({ number: chapterIndex + 1, ...chapter })),
    });
  }

  return { ...blueprint, partOutlines: outlines };
};
