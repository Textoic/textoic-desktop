import type { BlueprintStep, NovelBlueprint, NovelState, SecondaryCharacter } from "@textoic/core/types";
import { BLUEPRINT_STEPS } from "@textoic/core/types";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useDebounced } from "../hooks";

const STEP_LABELS: Record<BlueprintStep, string> = {
  coreElements: "Core story elements",
  protagonist: "Protagonist",
  characters: "Secondary characters",
  world: "World",
  framework: "Framework and plot points",
  parts: "Parts",
  partOutlines: "Chapter outlines",
};

const isDone = (blueprint: NovelBlueprint, step: BlueprintStep) =>
  step === "partOutlines" ? (blueprint.partOutlines?.length ?? 0) > 0 && blueprint.partOutlines?.length === blueprint.parts?.length : blueprint[step] !== undefined;

const Text = ({ label, value, onChange, rows }: { label: string; value: string; onChange: (value: string) => void; rows?: number }) => (
  <div className="field">
    <label>{label}</label>
    <textarea value={value} rows={rows ?? 2} onChange={(event) => onChange(event.target.value)} />
  </div>
);

const Line = ({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) => (
  <div className="field">
    <label>{label}</label>
    <input type="text" value={value} onChange={(event) => onChange(event.target.value)} />
  </div>
);

const ListEdit = ({ label, items, onChange }: { label: string; items: string[]; onChange: (items: string[]) => void }) => (
  <div className="field list-edit">
    <label>{label}</label>
    {items.map((item, index) => (
      <div className="row" key={index}>
        <input type="text" value={item} onChange={(event) => onChange(items.map((one, at) => (at === index ? event.target.value : one)))} />
        <button className="small ghost" onClick={() => onChange(items.filter((_, at) => at !== index))}>×</button>
      </div>
    ))}
    <button className="small ghost" onClick={() => onChange([...items, ""])}>+ add</button>
  </div>
);

const newCharacter = (): SecondaryCharacter => ({ id: crypto.randomUUID(), name: "New character", role: "Ally", relationship: "", physicalDescription: "", motivation: "", conflict: "", arc: "" });

export const NovelPanel = ({ sessionId, novel, onGenerate, onTestChapter, onSaved }: { sessionId: string; novel: NovelState; onGenerate: (steps?: BlueprintStep[]) => void; onTestChapter: () => void; onSaved: (novel: NovelState) => void }) => {
  const [draft, setDraft] = useState<NovelBlueprint>(novel.blueprint);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) {
      setDraft(novel.blueprint);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [novel.updatedAt]);

  const save = async (approved?: boolean) => {
    setSaving(true);
    try {
      const result = await api.saveNovel(sessionId, { blueprint: draft, approved });
      setDirty(false);
      onSaved(result.novel);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  useDebounced(() => {
    if (dirty && !saving) {
      void save();
    }
  }, 1500, [draft, dirty]);

  const edit = (patch: Partial<NovelBlueprint>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
  };

  const remaining = BLUEPRINT_STEPS.filter((step) => !isDone(draft, step));
  const complete = remaining.length === 0;
  const { coreElements, protagonist, characters, world, framework, parts, partOutlines } = draft;

  return (
    <div className="blueprint">
      <div className="panel-section">
        <h3>Blueprint</h3>
        <p className="small-text muted">Settings: {novel.settings.genre}, about {novel.settings.wordCount} words{novel.settings.nsfw ? ", explicit allowed" : ""}. Every field is editable; the model reads your edits when it generates later sections.</p>
        <div className="row wrap" style={{ marginBottom: 8 }}>
          {BLUEPRINT_STEPS.map((step) => (
            <span key={step} className={`badge ${isDone(draft, step) ? "ok" : ""}`}>{STEP_LABELS[step]}</span>
          ))}
        </div>
        <div className="row wrap">
          {!complete && <button className="primary" onClick={() => onGenerate()}>Generate {remaining.length === BLUEPRINT_STEPS.length ? "blueprint" : `remaining (${remaining.length})`}</button>}
          {complete && !novel.approved && <button className="primary" disabled={dirty || saving} onClick={() => void save(true)}>Approve blueprint</button>}
          {novel.approved && <button className="primary" onClick={onTestChapter}>Generate test chapter</button>}
          {novel.approved && <button className="ghost small" onClick={() => void save(false)}>Reopen for edits</button>}
          {(dirty || saving) && <span className="small-text muted">{saving ? "Saving…" : "Unsaved edits"}</span>}
        </div>
        {error && <div className="error small-text">{error}</div>}
      </div>

      {coreElements && (
        <div className="panel-section">
          <div className="row"><h3 className="grow">Core story elements</h3><button className="small ghost" onClick={() => onGenerate(["coreElements"])}>Regenerate</button></div>
          <Line label="Tone" value={coreElements.tone} onChange={(tone) => edit({ coreElements: { ...coreElements, tone } })} />
          <ListEdit label="Genres" items={coreElements.genres} onChange={(genres) => edit({ coreElements: { ...coreElements, genres } })} />
          <Line label="Story arc" value={coreElements.structure} onChange={(structure) => edit({ coreElements: { ...coreElements, structure } })} />
          <ListEdit label="Key stages" items={coreElements.keyStages} onChange={(keyStages) => edit({ coreElements: { ...coreElements, keyStages } })} />
          <Line label="Core theme" value={coreElements.coreTheme} onChange={(coreTheme) => edit({ coreElements: { ...coreElements, coreTheme } })} />
          <Text label="Emotional journey" value={coreElements.emotionalJourney} onChange={(emotionalJourney) => edit({ coreElements: { ...coreElements, emotionalJourney } })} />
          <Text label="Initial synopsis" rows={5} value={coreElements.initialSynopsis} onChange={(initialSynopsis) => edit({ coreElements: { ...coreElements, initialSynopsis } })} />
          <ListEdit label="World rules" items={coreElements.worldRules} onChange={(worldRules) => edit({ coreElements: { ...coreElements, worldRules } })} />
        </div>
      )}

      {protagonist && (
        <div className="panel-section">
          <div className="row"><h3 className="grow">Protagonist</h3><button className="small ghost" onClick={() => onGenerate(["protagonist"])}>Regenerate</button></div>
          <Line label="Name" value={protagonist.name} onChange={(name) => edit({ protagonist: { ...protagonist, name } })} />
          <Line label="Age" value={protagonist.age} onChange={(age) => edit({ protagonist: { ...protagonist, age } })} />
          <Text label="Physical description" value={protagonist.physicalDescription} onChange={(physicalDescription) => edit({ protagonist: { ...protagonist, physicalDescription } })} />
          <ListEdit label="Traits" items={protagonist.traits} onChange={(traits) => edit({ protagonist: { ...protagonist, traits } })} />
          <Text label="Main flaw" value={protagonist.flaw} onChange={(flaw) => edit({ protagonist: { ...protagonist, flaw } })} />
          <ListEdit label="Desires" items={protagonist.desires} onChange={(desires) => edit({ protagonist: { ...protagonist, desires } })} />
          <ListEdit label="Fears and quirks" items={protagonist.fears} onChange={(fears) => edit({ protagonist: { ...protagonist, fears } })} />
          <Text label="Background" rows={3} value={protagonist.background} onChange={(background) => edit({ protagonist: { ...protagonist, background } })} />
          <Text label="Arc" rows={4} value={protagonist.arc} onChange={(arc) => edit({ protagonist: { ...protagonist, arc } })} />
        </div>
      )}

      {characters && (
        <div className="panel-section">
          <div className="row"><h3 className="grow">Secondary characters · {characters.length}</h3><button className="small ghost" onClick={() => onGenerate(["characters"])}>Regenerate</button><button className="small" onClick={() => edit({ characters: [...characters, newCharacter()] })}>+ Add</button></div>
          {characters.map((character, index) => {
            const update = (patch: Partial<SecondaryCharacter>) => edit({ characters: characters.map((one, at) => (at === index ? { ...one, ...patch } : one)) });
            return (
              <div className="item" key={character.id}>
                <div className="row"><strong className="grow">{character.name || "Unnamed"}</strong><button className="small ghost" onClick={() => edit({ characters: characters.filter((_, at) => at !== index) })}>Remove</button></div>
                <Line label="Name" value={character.name} onChange={(name) => update({ name })} />
                <Line label="Role (archetype)" value={character.role} onChange={(role) => update({ role })} />
                <Line label="Relationship to protagonist" value={character.relationship} onChange={(relationship) => update({ relationship })} />
                <Text label="Physical description" value={character.physicalDescription} onChange={(physicalDescription) => update({ physicalDescription })} />
                <Text label="Motivation" value={character.motivation} onChange={(motivation) => update({ motivation })} />
                <Text label="Conflict" value={character.conflict} onChange={(conflict) => update({ conflict })} />
                <Text label="Arc" value={character.arc} onChange={(arc) => update({ arc })} />
              </div>
            );
          })}
        </div>
      )}

      {world && (
        <div className="panel-section">
          <div className="row"><h3 className="grow">World</h3><button className="small ghost" onClick={() => onGenerate(["world"])}>Regenerate</button></div>
          <ListEdit label="Primary locations" items={world.primaryLocations} onChange={(primaryLocations) => edit({ world: { ...world, primaryLocations } })} />
          <Line label="Timeframe" value={world.timeframe} onChange={(timeframe) => edit({ world: { ...world, timeframe } })} />
          <Text label="Atmosphere" value={world.atmosphere} onChange={(atmosphere) => edit({ world: { ...world, atmosphere } })} />
          <ListEdit label="Natural laws" items={world.naturalLaws} onChange={(naturalLaws) => edit({ world: { ...world, naturalLaws } })} />
          <ListEdit label="Supernatural elements" items={world.supernaturalElements} onChange={(supernaturalElements) => edit({ world: { ...world, supernaturalElements } })} />
          <ListEdit label="Consequences" items={world.consequences} onChange={(consequences) => edit({ world: { ...world, consequences } })} />
          <Text label="Power structures" value={world.powerStructures} onChange={(powerStructures) => edit({ world: { ...world, powerStructures } })} />
          <Text label="Conflicts" value={world.conflicts} onChange={(conflicts) => edit({ world: { ...world, conflicts } })} />
          <ListEdit label="Symbols" items={world.symbols} onChange={(symbols) => edit({ world: { ...world, symbols } })} />
        </div>
      )}

      {framework && (
        <div className="panel-section">
          <div className="row"><h3 className="grow">Framework</h3><button className="small ghost" onClick={() => onGenerate(["framework"])}>Regenerate</button></div>
          <Line label="Title" value={framework.title} onChange={(title) => edit({ framework: { ...framework, title } })} />
          <Text label="Hook" value={framework.hook} onChange={(hook) => edit({ framework: { ...framework, hook } })} />
          <Text label="Ignition point" value={framework.ignitionPoint} onChange={(ignitionPoint) => edit({ framework: { ...framework, ignitionPoint } })} />
          <h4>Plot points <button className="small" onClick={() => edit({ framework: { ...framework, plotPoints: [...framework.plotPoints, { id: crypto.randomUUID(), name: "New plot point", description: "", wordCountLocation: 0, characterImpact: "" }] } })}>+ Add</button></h4>
          {framework.plotPoints.map((point, index) => {
            const update = (patch: Partial<typeof point>) => edit({ framework: { ...framework, plotPoints: framework.plotPoints.map((one, at) => (at === index ? { ...one, ...patch } : one)) } });
            return (
              <div className="item" key={point.id}>
                <div className="row"><strong className="grow">{index + 1}. {point.name}</strong><button className="small ghost" onClick={() => edit({ framework: { ...framework, plotPoints: framework.plotPoints.filter((_, at) => at !== index) } })}>Remove</button></div>
                <Line label="Name" value={point.name} onChange={(name) => update({ name })} />
                <Text label="What happens" value={point.description} onChange={(description) => update({ description })} />
                <div className="field"><label>Around word</label><input type="number" value={point.wordCountLocation} onChange={(event) => update({ wordCountLocation: Number(event.target.value) })} /></div>
                <Text label="Impact on the protagonist" value={point.characterImpact} onChange={(characterImpact) => update({ characterImpact })} />
              </div>
            );
          })}
          <Text label="Climax" value={framework.climax} onChange={(climax) => edit({ framework: { ...framework, climax } })} />
          <Text label="Resolution" value={framework.resolution} onChange={(resolution) => edit({ framework: { ...framework, resolution } })} />
          <Text label="Character transformation" value={framework.characterTransformation} onChange={(characterTransformation) => edit({ framework: { ...framework, characterTransformation } })} />
        </div>
      )}

      {parts && (
        <div className="panel-section">
          <div className="row"><h3 className="grow">Parts · {parts.length}</h3><button className="small ghost" onClick={() => onGenerate(["parts"])}>Regenerate</button></div>
          {parts.map((part, index) => {
            const update = (patch: Partial<typeof part>) => edit({ parts: parts.map((one, at) => (at === index ? { ...one, ...patch } : one)) });
            return (
              <div className="item" key={part.number}>
                <Line label={`Part ${part.number} title`} value={part.title} onChange={(title) => update({ title })} />
                <Text label="Synopsis" rows={4} value={part.synopsis} onChange={(synopsis) => update({ synopsis })} />
                <div className="field"><label>Word count</label><input type="number" value={part.wordCount} onChange={(event) => update({ wordCount: Number(event.target.value) })} /></div>
              </div>
            );
          })}
        </div>
      )}

      {partOutlines && partOutlines.length > 0 && (
        <div className="panel-section">
          <div className="row"><h3 className="grow">Chapters</h3><button className="small ghost" onClick={() => onGenerate(["partOutlines"])}>Regenerate</button></div>
          {partOutlines.map((outline, outlineIndex) => (
            <div key={outline.partNumber}>
              <h4>Part {outline.partNumber}</h4>
              {outline.chapters.map((chapter, chapterIndex) => {
                const update = (patch: Partial<typeof chapter>) =>
                  edit({ partOutlines: partOutlines.map((one, at) => (at === outlineIndex ? { ...one, chapters: one.chapters.map((entry, index) => (index === chapterIndex ? { ...entry, ...patch } : entry)) } : one)) });
                return (
                  <div className="item" key={chapter.number}>
                    <Line label={`Chapter ${chapter.number} title`} value={chapter.title} onChange={(title) => update({ title })} />
                    <Text label="Synopsis" rows={4} value={chapter.synopsis} onChange={(synopsis) => update({ synopsis })} />
                    <div className="row">
                      <div className="field grow"><label>Word count</label><input type="number" value={chapter.wordCount} onChange={(event) => update({ wordCount: Number(event.target.value) })} /></div>
                      <label style={{ marginTop: 18 }}><input type="checkbox" checked={chapter.nsfw} onChange={(event) => update({ nsfw: event.target.checked })} /> explicit</label>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
