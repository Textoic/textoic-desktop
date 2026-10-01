import type { AuditEntry, Document, FactCheckRun, FactFinding, ResearchRecord, Session } from "@textoic/core/types";
import { useEffect, useState, type ReactNode } from "react";
import { api, formatTokens, formatUsd, timeAgo, type ContextView } from "../api";
import type { EditorDiagnostic } from "../editor";
import { useAsync } from "../hooks";
import { EstimateView } from "./Dialogs";

export const IssuesPanel = ({ diagnostics, findings, styleIssues, onJump, onRewrite, onApplyAll, onFactCheck, hasSelection }: { diagnostics: EditorDiagnostic[]; findings: FactFinding[]; styleIssues: ReactNode; onJump: (from: number, to: number) => void; onRewrite: () => void; onApplyAll: () => void; onFactCheck: () => void; hasSelection: boolean }) => (
  <div>
    <div className="panel-section">
      <h3 style={{ marginBottom: 6 }}>Style · {diagnostics.length}</h3>
      <div className="row" style={{ marginBottom: 8, flexWrap: "wrap" }}>
        <button className="small" onClick={onRewrite} title="Ask the model to rewrite the selected passage (or the paragraph at the cursor) fixing the listed issues">{hasSelection ? "Rewrite selection with AI" : "Rewrite paragraph with AI"}</button>
        <button className="small" disabled={diagnostics.length === 0} onClick={onApplyAll} title="Apply every exact fix in the document, and optionally rewrite the rest with AI">Apply all…</button>
      </div>
      {styleIssues}
    </div>
    <div className="panel-section">
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 className="grow" style={{ margin: 0 }}>Facts · {findings.length}</h3>
        <button className="small" onClick={onFactCheck}>Fact-check document</button>
      </div>
      {findings.length === 0 ? (
        <div className="empty">Run a fact-check to compare the document's claims against your research and context.</div>
      ) : (
        <div className="list">
          {findings.map((finding) => (
            <div key={finding.id} className={`card clickable issue ${finding.verdict}`} onClick={() => onJump(finding.start, finding.end)}>
              <div className="head">
                <span className={`badge ${finding.verdict === "supported" ? "ok" : finding.verdict === "contradicted" ? "bad" : ""}`}>{finding.verdict}</span>
                <span className="small-text muted">{Math.round(finding.confidence * 100)}%</span>
              </div>
              <div className="quote small-text">“{finding.quote}”</div>
              <p className="small-text">{finding.explanation}</p>
              {finding.evidence.length > 0 && <div className="small-text muted">Evidence: {finding.evidence.map((one) => one.itemName).filter((name, index, all) => all.indexOf(name) === index).join(", ")}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  </div>
);

export const ContextPanel = ({ session, sessions, onChanged, onDigest, onExplore }: { session: Session; sessions: Session[]; onChanged: () => void; onDigest: () => void; onExplore: () => void }) => {
  const context = useAsync(() => api.context(session.id), [session.id, session.contextItemIds.join(",")]);
  const [pasteName, setPasteName] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [folder, setFolder] = useState("");
  const [importFrom, setImportFrom] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [preview, setPreview] = useState<{ item: ContextView; text: string } | null>(null);

  const run = async (label: string, task: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await task();
      await context.refresh();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const upload = (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }

    void run("upload", () => api.uploadContext(session.id, [...files]));
  };

  const items = context.value?.items ?? [];
  const others = sessions.filter((one) => one.id !== session.id);
  return (
    <div>
      {error && <div className="error small-text" style={{ marginBottom: 8 }}>{error}</div>}
      <div className="panel-section">
        <h3>
          Attached · {items.length} item{items.length === 1 ? "" : "s"} · {formatTokens(context.value?.totalTokens ?? 0)} tokens
        </h3>
        <p className="small-text muted">
          Everything here is passed to the model with each AI action, within a budget of {formatTokens(context.value?.budgetTokens ?? 0)} tokens: small items in full, the rest as digests and retrieved excerpts.
        </p>
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="small" disabled={items.length === 0 || busy !== null} onClick={onDigest} title="Write a reusable one-paragraph card per item; cached by content and model">Digest items</button>
          <button className="small" disabled={items.length === 0 || busy !== null} onClick={onExplore} title="Let the model explore the corpus and write a brief for a task">Explore for a brief</button>
        </div>
        {items.length === 0 ? (
          <div className="empty">No context yet. Add files, paste text, point at a folder, or import from another session.</div>
        ) : (
          <div className="list">
            {items.map((item) => (
              <div key={item.id} className="card">
                <div className="head">
                  <span className="name">{item.name}</span>
                  <span className="small-text muted">{item.kind} · {formatTokens(item.tokens)} tok</span>
                </div>
                {item.digest && <p className="small-text">{item.digest}</p>}
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="small ghost" onClick={() => void api.contextText(item.id).then((result) => setPreview({ item, text: result.text }))}>View</button>
                  <button className="small ghost" onClick={() => void run("remove", () => api.removeContext(session.id, item.id))}>Remove</button>
                  {item.source.type === "research" && <span className="badge ok">research</span>}
                  {item.source.type === "session" && <span className="badge">imported</span>}
                  {item.source.type === "folder" && <span className="badge">folder</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="panel-section">
        <h3>Add files</h3>
        <div
          className={`dropzone${over ? " over" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            upload(event.dataTransfer.files);
          }}
        >
          Drop .md, .txt, .docx, .html, code or data files here, or <label style={{ display: "inline", textDecoration: "underline", cursor: "pointer" }}>browse<input type="file" multiple style={{ display: "none" }} onChange={(event) => upload(event.target.files)} /></label>
        </div>
      </div>
      <div className="panel-section">
        <h3>Paste text</h3>
        <input type="text" placeholder="Name" value={pasteName} onChange={(event) => setPasteName(event.target.value)} style={{ marginBottom: 6 }} />
        <textarea placeholder="Paste reference text" value={pasteText} onChange={(event) => setPasteText(event.target.value)} />
        <button className="small" style={{ marginTop: 6 }} disabled={pasteText.trim() === "" || busy !== null} onClick={() => void run("paste", async () => { await api.pasteContext(session.id, pasteName, pasteText); setPasteText(""); setPasteName(""); })}>Add</button>
      </div>
      <div className="panel-section">
        <h3>Folder on this machine</h3>
        <p className="small-text muted">Indexes every text, Markdown, code and data file under the path (skipping node_modules, build output and files over 1 MB).</p>
        <div className="row">
          <input type="text" placeholder="C:\\projects\\my-app" value={folder} onChange={(event) => setFolder(event.target.value)} />
          <button className="small" disabled={folder.trim() === "" || busy !== null} onClick={() => void run("folder", () => api.folderContext(session.id, folder))}>Index</button>
        </div>
      </div>
      <div className="panel-section">
        <h3>Import from another session</h3>
        <div className="row">
          <select value={importFrom} onChange={(event) => setImportFrom(event.target.value)}>
            <option value="">Pick a session…</option>
            {others.map((one) => (
              <option key={one.id} value={one.id}>{one.title}</option>
            ))}
          </select>
          <button className="small" disabled={importFrom === "" || busy !== null} onClick={() => void run("import", () => api.importContext(session.id, importFrom))}>Import</button>
        </div>
        <p className="small-text muted">Brings that session's context items and its documents. Anything already indexed is reused, not reprocessed.</p>
      </div>
      {busy && <div className="small-text muted">Working ({busy})…</div>}
      {preview && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPreview(null)}>
          <div className="modal" style={{ width: "min(900px, 94vw)" }}>
            <h2>{preview.item.name}</h2>
            <pre className="diff" style={{ maxHeight: "70vh" }}>{preview.text}</pre>
            <div className="actions"><button onClick={() => setPreview(null)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
};

export const ResearchPanel = ({ session, document, defaults, onRun }: { session: Session; document: Document | null; defaults: { budgetUsd: number; effort: "low" | "medium" | "high" }; onRun: (params: { topic: string; budgetUsd: number; effort: string }) => void }) => {
  const research = useAsync(() => api.research(session.id), [session.id, session.contextItemIds.join(",")]);
  const [topic, setTopic] = useState("");
  const [budget, setBudget] = useState(defaults.budgetUsd);
  const [effort, setEffort] = useState<string>(defaults.effort);
  useEffect(() => {
    if (topic === "" && document) {
      setTopic(document.title === "Untitled" ? "" : document.title);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document?.id]);

  return (
    <div>
      <div className="panel-section">
        <h3>Deep research</h3>
        <p className="small-text muted">Searches the web through SearXNG (or Serper), reads the sources and writes a cited report that becomes context for generation and fact-checking. Inference never exceeds the budget.</p>
        <div className="field">
          <label>Topic or question</label>
          <textarea value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="What should the report cover?" />
        </div>
        <div className="row">
          <div className="field grow">
            <label>Max inference budget (USD)</label>
            <input type="number" min={0} step={0.25} value={budget} onChange={(event) => setBudget(Number(event.target.value))} />
          </div>
          <div className="field grow">
            <label>Depth</label>
            <select value={effort} onChange={(event) => setEffort(event.target.value)}>
              <option value="low">Low · 2 searches, fast</option>
              <option value="medium">Medium · 4 searches, counter-evidence</option>
              <option value="high">High · 6 searches, history and methods</option>
            </select>
          </div>
        </div>
        <button className="primary" disabled={topic.trim() === ""} onClick={() => onRun({ topic, budgetUsd: budget, effort })}>Research</button>
      </div>
      <div className="panel-section">
        <h3>Reports in this session</h3>
        {(research.value?.records ?? []).length === 0 ? (
          <div className="empty">No research yet.</div>
        ) : (
          <div className="list">
            {(research.value?.records ?? []).map((record: ResearchRecord) => (
              <div key={record.id} className="card">
                <div className="head">
                  <span className="name">{record.topic}</span>
                  <span className="small-text muted">{timeAgo(record.at)}</span>
                </div>
                <div className="small-text muted">{record.sources} sources · {record.effort} effort · {record.model} · spent {formatUsd(record.spentUsd)} · {record.stopReason}</div>
                {record.limitations.length > 0 && <details className="small-text"><summary>{record.limitations.length} limitation{record.limitations.length === 1 ? "" : "s"}</summary><ul>{record.limitations.slice(0, 12).map((one, index) => <li key={index}>{one}</li>)}</ul></details>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const DiffView = ({ diff }: { diff: string }) => (
  <div className="diff">
    {diff.split("\n").map((line, index) => (
      <div key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : ""}>{line || " "}</div>
    ))}
  </div>
);

export const AuditPanel = ({ session, version }: { session: Session; version: number }) => {
  const audit = useAsync(() => api.audit(session.id), [session.id, version]);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useAsync(async () => (open ? api.auditEntry(session.id, open) : null), [open, session.id]);
  const entries = audit.value?.entries ?? [];
  return (
    <div>
      <div className="panel-section">
        <h3>Audit log · {entries.length}</h3>
        <p className="small-text muted">Every change with who made it. AI entries carry the prompt, parameters, usage and cost.</p>
        {entries.length === 0 ? (
          <div className="empty">Nothing yet.</div>
        ) : (
          <div className="list">
            {entries.map((entry: AuditEntry) => (
              <div key={entry.id} className="card clickable" onClick={() => setOpen(open === entry.id ? null : entry.id)}>
                <div className="head">
                  <span>
                    <span className={`badge ${entry.actor.kind === "ai" ? "ai" : ""}`}>{entry.actor.kind === "ai" ? `AI · ${entry.actor.model}` : entry.actor.kind}</span>{" "}
                    <span className="small-text mono">{entry.action}</span>
                  </span>
                  <span className="small-text muted">{timeAgo(entry.at)}</span>
                </div>
                <p className="small-text">{entry.summary}</p>
                {entry.ai && <div className="small-text muted">{entry.ai.calls.length} call{entry.ai.calls.length === 1 ? "" : "s"} · {formatTokens(entry.ai.totalInputTokens)} in / {formatTokens(entry.ai.totalOutputTokens)} out · {formatUsd(entry.ai.totalUsd)}{entry.ai.estimate ? ` (estimated ${formatUsd(entry.ai.estimate.usd)})` : ""}</div>}
                {open === entry.id && detail.value?.entry && (
                  <div onClick={(event) => event.stopPropagation()} style={{ marginTop: 8 }}>
                    {detail.value.entry.diff && <DiffView diff={detail.value.entry.diff} />}
                    {detail.value.entry.ai && (
                      <details style={{ marginTop: 8 }}>
                        <summary className="small-text">Prompts and parameters</summary>
                        {detail.value.entry.ai.params && <pre className="diff">{JSON.stringify(detail.value.entry.ai.params, null, 2)}</pre>}
                        {detail.value.entry.ai.estimate && <EstimateView estimate={detail.value.entry.ai.estimate} />}
                        {detail.value.entry.ai.calls.map((call, index) => (
                          <details key={index} style={{ marginTop: 6 }}>
                            <summary className="small-text">{call.stage} · {call.model} · {call.usage.inputTokens} in / {call.usage.outputTokens} out · {formatUsd(call.costUsd)} · {call.durationMs} ms · temp {call.params.temperature ?? "default"}{call.params.json ? " · JSON" : ""}</summary>
                            {call.messages.map((message, messageIndex) => (
                              <pre key={messageIndex} className="diff"><strong>{message.role}</strong>{"\n"}{message.content}</pre>
                            ))}
                            <pre className="diff"><strong>output</strong>{"\n"}{call.output}</pre>
                          </details>
                        ))}
                      </details>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export const FactCheckHistory = ({ session, version, onSelect }: { session: Session; version: number; onSelect: (run: FactCheckRun) => void }) => {
  const runs = useAsync(() => api.factChecks(session.id), [session.id, version]);
  const list = (runs.value?.runs ?? []).sort((one, other) => other.at.localeCompare(one.at));
  return list.length === 0 ? null : (
    <div className="panel-section">
      <h3>Previous fact-checks</h3>
      <div className="list">
        {list.map((run) => (
          <div key={run.id} className="card clickable" onClick={() => onSelect(run)}>
            <div className="head"><span className="name">{run.claims} claims</span><span className="small-text muted">{timeAgo(run.at)}</span></div>
            <div className="small-text muted">{run.findings.filter((finding) => finding.verdict === "contradicted").length} contradicted · {run.findings.filter((finding) => finding.verdict === "supported").length} supported · {run.model}</div>
          </div>
        ))}
      </div>
    </div>
  );
};
