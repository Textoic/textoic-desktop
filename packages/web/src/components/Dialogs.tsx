import type { CostEstimate, ModelInfo, ProviderKind, Rewrite, TemplateKind, TemplateSettings } from "@textoic/core/types";
import type { TextoicConfig } from "@textoic/enlint-lsp/config";
import { RulesEditor } from "./RulesEditor";
import { useEffect, useState, type ReactNode } from "react";
import { api, formatTokens, formatUsd, type RedactedSettings } from "../api";

export const Modal = ({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) => (
  <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="modal" style={wide ? { width: "min(900px, 94vw)" } : undefined}>
      <h2>{title}</h2>
      {children}
    </div>
  </div>
);

const TEMPLATES: { kind: TemplateKind; name: string; blurb: string }[] = [
  { kind: "blank", name: "Blank", blurb: "Paste or write your own text and edit it with the style linter." },
  { kind: "tweet", name: "Tweet", blurb: "One idea, at most 280 characters." },
  { kind: "article", name: "Article", blurb: "Planned and drafted, 500 to 1,000 words." },
  { kind: "novel", name: "Novel", blurb: "A structured blueprint you approve before a test chapter." },
];

export const NewSessionDialog = ({ promptMax, onClose, onCreate }: { promptMax: number; onClose: () => void; onCreate: (input: { title?: string; template: TemplateKind; templateSettings?: TemplateSettings; initialContent?: string }) => Promise<void> }) => {
  const [template, setTemplate] = useState<TemplateKind>("blank");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [minWords, setMinWords] = useState(500);
  const [maxWords, setMaxWords] = useState(800);
  const [wordCount, setWordCount] = useState(60000);
  const [genre, setGenre] = useState("thriller");
  const [nsfw, setNsfw] = useState(false);
  const [stylePrompt, setStylePrompt] = useState("");
  const [initial, setInitial] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const templateSettings: TemplateSettings | undefined =
        template === "tweet" ? { prompt } : template === "article" ? { prompt, minWords, maxWords } : template === "novel" ? { prompt, wordCount, genre, nsfw, stylePrompt: stylePrompt || undefined } : undefined;
      await onCreate({ title: title || undefined, template, templateSettings, initialContent: template === "blank" ? initial : undefined });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const needsPrompt = template !== "blank";
  return (
    <Modal title="New session" onClose={onClose}>
      <div className="template-grid">
        {TEMPLATES.map((one) => (
          <div key={one.kind} className={`template${template === one.kind ? " active" : ""}`} onClick={() => setTemplate(one.kind)}>
            <div className="name">{one.name}</div>
            <div className="small-text muted">{one.blurb}</div>
          </div>
        ))}
      </div>
      <div className="field">
        <label>Title (optional)</label>
        <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Derived from your prompt if left empty" />
      </div>
      {needsPrompt && (
        <div className="field">
          <label>Prompt ({prompt.length}/{promptMax})</label>
          <textarea value={prompt} maxLength={promptMax} onChange={(event) => setPrompt(event.target.value)} placeholder={template === "novel" ? "The story concept: premise, characters you already have in mind, the ending you want…" : "What should it say?"} />
        </div>
      )}
      {template === "blank" && (
        <div className="field">
          <label>Start with text (optional)</label>
          <textarea value={initial} onChange={(event) => setInitial(event.target.value)} placeholder="Paste text to edit, or leave empty" />
        </div>
      )}
      {template === "article" && (
        <div className="row">
          <div className="field grow">
            <label>Minimum words</label>
            <input type="number" min={500} max={1000} value={minWords} onChange={(event) => setMinWords(Number(event.target.value))} />
          </div>
          <div className="field grow">
            <label>Maximum words</label>
            <input type="number" min={500} max={1000} value={maxWords} onChange={(event) => setMaxWords(Number(event.target.value))} />
          </div>
        </div>
      )}
      {template === "novel" && (
        <>
          <div className="row">
            <div className="field grow">
              <label>Target word count</label>
              <input type="number" min={5000} step={1000} value={wordCount} onChange={(event) => setWordCount(Number(event.target.value))} />
            </div>
            <div className="field grow">
              <label>Genre</label>
              <input type="text" value={genre} onChange={(event) => setGenre(event.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>Narrative voice and style notes (optional)</label>
            <textarea value={stylePrompt} onChange={(event) => setStylePrompt(event.target.value)} placeholder="First person, present tense, dry humour…" />
          </div>
          <div className="field">
            <label>
              <input type="checkbox" checked={nsfw} onChange={(event) => setNsfw(event.target.checked)} /> Allow explicit scenes
            </label>
          </div>
        </>
      )}
      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || (needsPrompt && prompt.trim() === "")} onClick={submit}>Create</button>
      </div>
    </Modal>
  );
};

export const SettingsDialog = ({ settings, onClose, onSaved }: { settings: RedactedSettings; onClose: () => void; onSaved: (settings: RedactedSettings) => void }) => {
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...settings, research: { ...settings.research }, lint: settings.lint });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = draft.provider as ProviderKind;

  useEffect(() => {
    let cancelled = false;
    setModels([]);
    setModelsError(null);
    api.models(provider)
      .then((result) => !cancelled && setModels(result.models))
      .catch((cause) => !cancelled && setModelsError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const set = (key: string, value: unknown) => setDraft((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setBusy(true);
    try {
      const result = await api.updateSettings(draft);
      onSaved(result.settings);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const selected = models.find((model) => model.id === draft.model);
  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="row">
        <div className="field grow">
          <label>Provider</label>
          <select value={provider} onChange={(event) => set("provider", event.target.value)}>
            <option value="ollama">Ollama (local)</option>
            <option value="openrouter">OpenRouter (remote)</option>
          </select>
        </div>
        <div className="field grow">
          <label>Model {models.length > 0 ? `(${models.length} available)` : ""}</label>
          <input type="text" list="models" value={String(draft.model ?? "")} onChange={(event) => set("model", event.target.value)} placeholder={provider === "ollama" ? "qwen3.8:27b" : "anthropic/claude-sonnet-5"} />
          <datalist id="models">
            {models.map((model) => (
              <option key={model.id} value={model.id}>{model.name}</option>
            ))}
          </datalist>
          {modelsError && <div className="small-text error">{modelsError}</div>}
          {selected?.pricing && <div className="small-text muted">{selected.pricing.prompt === 0 && selected.pricing.completion === 0 ? "Free" : `$${(selected.pricing.prompt * 1e6).toFixed(2)} / $${(selected.pricing.completion * 1e6).toFixed(2)} per million tokens in / out`}{selected.contextLength ? ` · ${formatTokens(selected.contextLength)} context` : ""}</div>}
        </div>
      </div>
      {provider === "ollama" ? (
        <div className="row">
          <div className="field grow">
            <label>Ollama URL</label>
            <input type="text" value={String(draft.ollamaUrl ?? "")} onChange={(event) => set("ollamaUrl", event.target.value)} />
          </div>
          <div className="field grow">
            <label>Context window (tokens)</label>
            <input type="number" value={Number(draft.ollamaContextTokens ?? 32768)} onChange={(event) => set("ollamaContextTokens", Number(event.target.value))} />
          </div>
        </div>
      ) : (
        <div className="field">
          <label>OpenRouter API key {settings.hasOpenrouterKey ? "(saved; leave as is to keep)" : ""}</label>
          <input type="password" value={String(draft.openrouterKey ?? "")} onChange={(event) => set("openrouterKey", event.target.value)} placeholder="sk-or-…" />
        </div>
      )}
      <div className="row">
        <div className="field grow">
          <label>SearXNG URL (research search)</label>
          <input type="text" value={String(draft.searxngUrl ?? "")} onChange={(event) => set("searxngUrl", event.target.value)} />
        </div>
        <div className="field grow">
          <label>Serper key (optional hosted search){settings.hasSerperKey ? " · saved" : ""}</label>
          <input type="password" value={String(draft.serperKey ?? "")} onChange={(event) => set("serperKey", event.target.value)} />
        </div>
      </div>
      <div className="row">
        <div className="field grow">
          <label>Re-lint after idle (ms)</label>
          <input type="number" min={250} step={250} value={Number(draft.lintIdleMs ?? 750)} onChange={(event) => set("lintIdleMs", Number(event.target.value))} />
        </div>
        <div className="field grow">
          <label>Context budget per AI call (tokens)</label>
          <input type="number" min={1000} step={1000} value={Number(draft.contextBudgetTokens ?? 12000)} onChange={(event) => set("contextBudgetTokens", Number(event.target.value))} />
        </div>
        <div className="field grow">
          <label>Default research budget (USD)</label>
          <input type="number" min={0} step={0.5} value={Number((draft.research as { budgetUsd: number }).budgetUsd)} onChange={(event) => set("research", { ...(draft.research as object), budgetUsd: Number(event.target.value) })} />
        </div>
      </div>
      <div className="field">
        <label>Style rules</label>
        <RulesEditor config={draft.lint as TextoicConfig} onChange={(lint) => set("lint", lint)} />
      </div>
      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy} onClick={save}>Save</button>
      </div>
    </Modal>
  );
};

export const EstimateView = ({ estimate }: { estimate: CostEstimate }) => (
  <div className="estimate">
    <div className="row">
      <div className="grow">
        <div className="small-text muted">Estimated cost · {estimate.provider} · {estimate.model}</div>
        <div className="total">{estimate.known ? formatUsd(estimate.usd) : "unknown"}</div>
        <div className="small-text muted">{estimate.calls} model call{estimate.calls === 1 ? "" : "s"} · about {formatTokens(estimate.inputTokens)} tokens in, up to {formatTokens(estimate.outputTokens)} out</div>
      </div>
    </div>
    {estimate.note && <p className="small-text">{estimate.note}</p>}
    {estimate.breakdown.length > 1 && (
      <table>
        <thead>
          <tr><th>Stage</th><th>In</th><th>Out (max)</th><th>USD</th></tr>
        </thead>
        <tbody>
          {estimate.breakdown.slice(0, 12).map((line, index) => (
            <tr key={index}><td>{line.stage}</td><td>{formatTokens(line.inputTokens)}</td><td>{formatTokens(line.outputTokens)}</td><td>{formatUsd(line.usd)}</td></tr>
          ))}
          {estimate.breakdown.length > 12 && <tr><td colSpan={4} className="muted">… {estimate.breakdown.length - 12} more</td></tr>}
        </tbody>
      </table>
    )}
    <p className="small-text muted">Token counts are estimated at four characters per token; output is priced at the maximum the model may write. Final cost is recorded in the audit log.</p>
  </div>
);

export const CostDialog = ({ title, estimate, error, onClose, onConfirm, children }: { title: string; estimate: CostEstimate | null; error: string | null; onClose: () => void; onConfirm: () => void; children?: ReactNode }) => (
  <Modal title={title} onClose={onClose}>
    {children}
    {error && <div className="error">{error}</div>}
    {!estimate && !error && <div className="muted">Estimating…</div>}
    {estimate && <EstimateView estimate={estimate} />}
    <div className="actions">
      <button className="ghost" onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!estimate} onClick={onConfirm}>Run</button>
    </div>
  </Modal>
);

export const RewriteDialog = ({ rewrite, onClose, onApply }: { rewrite: Rewrite; onClose: () => void; onApply: () => Promise<void> }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="AI rewrite" onClose={onClose} wide>
      <div className="rewrite">
        <div className="row small-text muted" style={{ marginBottom: 8 }}>
          <span>Before: {rewrite.before.length} style issue{rewrite.before.length === 1 ? "" : "s"}</span>
          <span>After: {rewrite.after.length}</span>
          {!rewrite.accepted && <span className="badge bad">rejected: {rewrite.reason}</span>}
        </div>
        <div className="before">{rewrite.original}</div>
        <div style={{ height: 8 }} />
        <div className="after">{rewrite.replacement || "(empty)"}</div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button className="ghost" onClick={onClose}>Discard</button>
        <button
          className="primary"
          disabled={busy || rewrite.replacement === ""}
          onClick={async () => {
            setBusy(true);
            try {
              await onApply();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
              setBusy(false);
            }
          }}
        >
          Apply to document
        </button>
      </div>
    </Modal>
  );
};

const RewriteAllItem = ({ rewrite, chosen, onToggle }: { rewrite: Rewrite; chosen: boolean; onToggle: () => void }) => (
  <div className="rewrite" style={{ marginBottom: 10 }}>
    <label className="row small-text muted" style={{ marginBottom: 8 }}>
      <input type="checkbox" checked={chosen} disabled={rewrite.replacement === ""} onChange={onToggle} />
      <span>Before: {rewrite.before.length} · After: {rewrite.after.length}</span>
      {!rewrite.accepted && <span className="badge bad">rejected: {rewrite.reason}</span>}
    </label>
    <div className="before">{rewrite.original}</div>
    <div style={{ height: 8 }} />
    <div className="after">{rewrite.replacement || "(empty)"}</div>
  </div>
);

export const RewriteAllDialog = ({ rewrites, onClose, onApply }: { rewrites: Rewrite[]; onClose: () => void; onApply: (indexes: number[]) => Promise<void> }) => {
  const [chosen, setChosen] = useState(() => new Set(rewrites.flatMap((rewrite, index) => (rewrite.accepted ? [index] : []))));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (index: number) => setChosen((current) => {
    const next = new Set(current);
    if (!next.delete(index)) {
      next.add(index);
    }

    return next;
  });
  return (
    <Modal title="Rewrite all issues" onClose={onClose} wide>
      {rewrites.length === 0 ? <div className="empty">No paragraph had style issues.</div> : rewrites.map((rewrite, index) => <RewriteAllItem key={rewrite.start} rewrite={rewrite} chosen={chosen.has(index)} onToggle={() => toggle(index)} />)}
      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button className="ghost" onClick={onClose}>Discard</button>
        <button
          className="primary"
          disabled={busy || chosen.size === 0}
          onClick={async () => {
            setBusy(true);
            try {
              await onApply([...chosen]);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
              setBusy(false);
            }
          }}
        >
          Apply {chosen.size} rewrite{chosen.size === 1 ? "" : "s"}
        </button>
      </div>
    </Modal>
  );
};

export const ConfirmDialog = ({ title, message, confirmLabel, onClose, onConfirm }: { title: string; message: ReactNode; confirmLabel: string; onClose: () => void; onConfirm: () => void }) => (
  <Modal title={title} onClose={onClose}>
    <div>{message}</div>
    <div className="actions">
      <button className="ghost" onClick={onClose}>Cancel</button>
      <button className="primary" onClick={onConfirm}>{confirmLabel}</button>
    </div>
  </Modal>
);
