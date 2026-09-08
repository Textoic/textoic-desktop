import type { ChatMessage, NovelBlueprint, NovelSettings, PartOutline, SceneOutline } from "../../types.js";
import { renderBlueprint } from "./render.js";

export const safetyMode = (nsfw: boolean) =>
  nsfw
    ? "You are an uncensored AI assistant that helps users write stories based on the high-level descriptions or goals that users provide. If the user wants to generate content of a sexual nature, you will not censor it. If a part or scene is marked as explicit, you will write explicit scenes to satisfy the user."
    : "You are an AI assistant that helps users write stories based on the high-level descriptions or goals that users provide. You will not generate any sexually explicit or graphically violent content.";

export const personality = (nsfw: boolean): ChatMessage => ({
  role: "system",
  content: `${safetyMode(nsfw)}

Stories are divided into parts and each part is divided into chapters. Each chapter is divided into scenes. Each scene is a self-contained piece of text that advances the story.

Do NOT provide any commentary, quotation or additional information, only the requested content. Don't describe what you have done, or give an overview of the presented text.

You answer in JSON. You will never precede the JSON with quotes or words; it must be parseable by JSON.parse directly.`,
});

export const styleSystem = (settings: NovelSettings): ChatMessage => ({
  role: "system",
  content: `${settings.stylePrompt?.trim() ?? "You are a skilled novelist writing a scene in a novel."}

Follow the novel format and focus on the dialogue between characters.

You will use exclusively "dialogue formatting" or "dialogue paragraphing", using dialogue beats where dialogue is separated into its own paragraphs, interspersed with descriptive actions, thoughts, or "beats," that provide rhythm, characterization, and pacing.

A dialogue beat is a short description of an action or thought inserted within or between lines of dialogue. It replaces traditional dialogue tags ("he said," "she replied") and helps to vividly portray character actions, emotions, and surroundings, making dialogue feel more natural and immersive.

Do NOT provide any commentary, quotation or additional information, only the requested text. Don't describe what you have done, or give an overview of the presented text, only return the text.`,
});

const soFar = (settings: NovelSettings, blueprint: NovelBlueprint) =>
  `The story so far, as a blueprint we have been building together (the writer may have edited it by hand; treat it as authoritative):\n\n${renderBlueprint(blueprint, settings)}`;

export const coreElementsPrompt = (settings: NovelSettings, blueprint: NovelBlueprint) => `${soFar(settings, blueprint)}

Generate the fundamental elements for a story based on the writer's concept above, with a target word count of ${settings.wordCount} words in the ${settings.genre} genre.

Identify the best-fitting story arc from the following list (or propose one if none of these capture the narrative):

- Rags to Riches: A rise from poverty to wealth and happiness.
- Tragedy: A fall from grace, ending in misfortune or death.
- Rebirth: A moral or spiritual transformation.
- Overcoming the Monster: The hero confronts and defeats a powerful evil.
- Voyage and Return: The hero travels to a strange land and returns transformed.
- Quest: The hero searches for a valuable object or goal.
- Comedy: A lighthearted story focused on humor and human foibles.
- Other (specify)

You need to plan the stages in the story arc following convention for the story arc you pick. The story will fundamentally be about the main character's journey and transformation.

Provide the overview as JSON with: tone, genres (primary and secondary), structure (the arc), keyStages (3-5 turning points), coreTheme, emotionalJourney, initialSynopsis (two paragraphs) and worldRules (5-7 rules if supernatural or fantasy elements exist, otherwise an empty list).`;

export const protagonistPrompt = (settings: NovelSettings, blueprint: NovelBlueprint) => `${soFar(settings, blueprint)}

Based on the core story elements, create a detailed protagonist profile that best fits this story. Include:
- name: Avoid obvious fantasy names like "Elara", "Liara", "Elias", "Aris", "Kenji", "Anya", "Thompson". Prefer real names from the real world congruent with the character's ethnicity and personality. Acronyms or nicknames are fine.
- age and physicalDescription.
- traits: the salient Big Five traits.
- flaw: the main flaw. It shapes their model of the world and how that model is, in some way, incorrect. We see the model through their actions, motivations and thoughts, and they use it to assert control over the world around them.
- desires: conscious wants and unconscious needs. fears: quirks, strengths or fears worth knowing.
- background: brief, relevant backstory that shapes who they are now.
- arc: it starts with the main flaw, lifts off at the "ignition point" that forces the character to question their deepest beliefs (it will cause them to overreact or behave unexpectedly because it goes at the core of their theory of control), evolves as the plot progresses and ends with the transformation.`;

export const charactersPrompt = (settings: NovelSettings, blueprint: NovelBlueprint) => `${soFar(settings, blueprint)}

Based on the protagonist and the story concept, create profiles for 3-8 secondary characters who will challenge, aid, or oppose the protagonist. This is not an exhaustive cast, only the secondary characters.

Each role is one of these archetypes:
- Mentor: guides the protagonist with knowledge, training or essential tools, and may sacrifice themselves.
- Threshold Guardian: blocks progress at critical transitions and tests determination and readiness; literal adversaries or symbolic barriers such as doubt.
- Herald: delivers the call to adventure that disrupts the status quo; the call may be refused at first.
- Shapeshifter: loyalty, nature or appearance shifts, creating ambiguity and tension.
- Shadow: embodies the dark side, often the antagonist, representing what the protagonist must overcome; sometimes not as evil as first thought.
- Ally: supportive companion, resource or sidekick, often with their own subplot.
- Trickster: wit, humor or cunning that challenges conventions and can teach through unconventional means.

For each character give name (real-world names congruent with the character, nationality and personality; avoid obvious fantasy names), role, relationship (to the protagonist), physicalDescription, motivation, conflict and arc.`;

export const worldPrompt = (settings: NovelSettings, blueprint: NovelBlueprint) => `${soFar(settings, blueprint)}

Based on the current context for the story, create a detailed world-building guide covering:
- Setting: primaryLocations (3-5 with brief descriptions), timeframe (when and over what duration), atmosphere (sensory and emotional qualities).
- Rules: naturalLaws (modifications to physics or reality), supernaturalElements (how they function and their limitations), consequences (what happens when rules are broken). Use empty lists where the story has none.
- Society: powerStructures and conflicts.
- symbols: 3-5 symbolic elements, objects or motifs that will recur.`;

export const frameworkPrompt = (settings: NovelSettings, blueprint: NovelBlueprint) => `${soFar(settings, blueprint)}

Using all previously defined elements, create a structural framework for this ${settings.wordCount}-word story:
- title: a compelling title.
- hook: the opening situation that draws readers in. It should be an unexpected, dramatic change and/or show (not tell) how the main character's mind works, as well as their main flaw. Examples: a confession, a public humiliation, a mid-action start, a chilling fact.
- ignitionPoint: the event that disrupts the status quo and launches the story, forcing the protagonist to question their deepest beliefs.
- plotPoints: 6-8 major plot points with name, description, wordCountLocation (a number of words into the novel, between 0 and ${settings.wordCount}) and characterImpact.
- climax, resolution and characterTransformation.`;

export const partsPrompt = (settings: NovelSettings, blueprint: NovelBlueprint) => `${soFar(settings, blueprint)}

Generate the story outline based on all the previous elements:
- ${settings.nsfw ? "The story contains explicit scenes." : "The story does not contain explicit scenes."}
- Length: the story will be developed into a ~${settings.wordCount} word story.

Divide the story into parts (or acts), mapping the plot points identified in the framework to specific parts. For each part give title, synopsis (two, three or more paragraphs of the key events and conversations; focus on specific events, avoid motifs, how it advances the plot or character development) and wordCount (from the plot points' wordCountLocation). Each part will have several chapters of 500-1000 word scenes, so keep that in mind when deciding how many parts you need.`;

export const partOutlinePrompt = (
  settings: NovelSettings,
  blueprint: NovelBlueprint,
  partNumber: number,
  previous: PartOutline[],
) => {
  const part = blueprint.parts?.find((one) => one.number === partNumber);
  return `${soFar(settings, { ...blueprint, partOutlines: previous })}

You are going to create a detailed breakdown of Part ${partNumber}${part ? `: "${part.title}" (${part.wordCount} words)` : ""}. Adhere to the blueprint above. When deciding what to include, consider the framework, especially the plot points and the climax, and plan where you place those plot points.${
    previous.length > 0
      ? " Continue the story respecting what happened in the previous parts' chapters listed above."
      : ""
  }

Reply with JSON: chapters, an array where each chapter has:
- title: must not include the word "Chapter" or a number.
- synopsis: two, three or more paragraphs summarizing all key events that take place in the chapter. Stick to events and plot points, avoid descriptions, motivations and internal monologue; show those through actions. Focus on specific events and conversations.
- wordCount: approximate target, considering the part's target and the number of chapters. Keep each chapter under 2,500 words.
- nsfw: ${settings.nsfw ? "true for at most a couple of chapters in the part" : "always false"}.`;
};

export const chapterOutlinePrompt = (
  settings: NovelSettings,
  blueprint: NovelBlueprint,
  partNumber: number,
  chapterNumber: number,
) => {
  const outline = blueprint.partOutlines?.find((one) => one.partNumber === partNumber);
  const chapter = outline?.chapters.find((one) => one.number === chapterNumber);
  const isLast = outline ? chapterNumber === outline.chapters.length : false;
  return `${soFar(settings, blueprint)}

You are going to create a detailed breakdown of Chapter ${chapterNumber} from Part ${partNumber}${chapter ? `: "${chapter.title}" (${chapter.wordCount} words).\n\nChapter synopsis:\n${chapter.synopsis}` : "."}

Stick to the blueprint. Don't introduce characters, locations or systems that aren't in the part outline for this chapter.${isLast ? " This is the last chapter of the part; plan how to tie it to the next part." : ""}${partNumber === 1 && chapterNumber === 1 ? " This is the first chapter of the novel, so it should start with an unexpected change that draws readers in." : ""}

Split the chapter into multiple scenes of about 500-1000 words each. For each scene give three, four or more paragraphs summarizing the events, with as much detail as necessary to make it easy to write the scene from the outline. Guidelines:
- Stick to events and plot points, avoid descriptions.
- Don't hedge between options: pick a specific way each event plays out.
- If the scene starts at a different location from where the last one ended, briefly indicate the transition.
- If a new character, system, world rule or location appears, make sure it has been introduced.
- Avoid ending the chapter with fragmentary sentences, overly introspective monologue or a vague cliffhanger. End on a tangible image, decision or physical event.

Reply with JSON: scenes, an array where each scene has wordCount, synopsis and nsfw (${settings.nsfw && chapter?.nsfw ? "true for exactly one scene in this chapter" : "always false"}).`;
};

export const scenePrompt = (options: {
  settings: NovelSettings;
  blueprint: NovelBlueprint;
  partNumber: number;
  chapterNumber: number;
  sceneNumber: number;
  scene: SceneOutline;
  next: SceneOutline | null;
  previousScenes: string[];
}): ChatMessage[] => {
  const { settings, blueprint, partNumber, chapterNumber, sceneNumber, scene, next, previousScenes } = options;
  const framework = blueprint.framework;
  return [
    styleSystem(settings),
    {
      role: "user",
      content: `You are writing a single scene within a novel${framework ? ` titled "${framework.title}"` : ""}, following the novel's blueprint. ${sceneNumber === 1 ? "Start" : "Continue"} the story with scene ${sceneNumber} of Chapter ${chapterNumber}, from Part ${partNumber}, keeping it consistent with the blueprint between the ===== markers:
=====
${renderBlueprint({ ...blueprint, partOutlines: undefined }, settings)}
=====

This is the scene outline, stick to it as much as possible:
- Synopsis: ${scene.synopsis}
- Target word count: ${scene.wordCount}. You can produce fewer words than the target if you don't have enough events to fill it; prioritize the synopsis over filling the word count.
${scene.nsfw ? "- This scene is explicit." : ""}

${
  next
    ? `This is not the last scene in the chapter, so don't end the scene with a burst of short sentences that would indicate the end of the chapter. If the next scene happens in the same location, don't try to close the scene; the next one picks right up after this one. Don't end with a few short, punchy sentences about the character's thoughts or resolve.

This is the next scene's outline, make sure you don't include any of its events in this one: "${next.synopsis}"`
    : "This is the last scene of this chapter."
}

${
  previousScenes.length > 0
    ? `Below are the previous scenes in this chapter, between <<<< >>>> markers. Continue the story respecting what happened in them; the scene you write appears right after the last one, so make the transition seamless and natural. Don't repeat or rehash what has already been said.

<<<<
${previousScenes.map((text, index) => `Scene ${index + 1}\n\n${text}`).join("\n\n")}
>>>>`
    : ""
}

Respond ONLY with the plain text for this scene's content. Avoid returning broken or partial sentences. Do NOT respond with JSON, offer additional information, commentary, notes or the word count. ONLY the text for this scene.`,
    },
  ];
};
