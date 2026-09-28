import type { BlueprintStep, CostEstimate, Document, FactCheckRun, FactFinding, Job, NovelState, Rewrite, Session, TemplateKind, TemplateSettings } from "@textoic/core/types";
import type { EditorView } from "@codemirror/view";
import { withIgnoredCase, withSeverity, type TextoicConfig } from "@textoic/enlint-lsp/config";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, formatUsd, subscribeJobs, type RedactedSettings } from "./api";
import { ConfirmDialog, CostDialog, NewSessionDialog, RewriteDialog, SettingsDialog } from "./components/Dialogs";
import { JobsBar } from "./components/JobsBar";
import { NovelPanel } from "./components/NovelPanel";
import { AuditPanel, ContextPanel, FactCheckHistory, IssuesPanel, ResearchPanel } from "./components/Panels";
import { Sidebar } from "./components/Sidebar";
import { Editor, toEditorDiagnostics, type EditorDiagnostic } from "./editor";
import { LspClient, type LintStats, type LspDiagnostic } from "./lsp-client";

type Tab = "issues" | "context" | "research" | "audit" | "novel" | "session";

type PendingAction = { action: string; params: Record<string, unknown>; title: string; estimate: CostEstimate | null; error: string | null };

const uriFor = (sessionId: string, documentId: string) => `textoic://${sessionId}/${documentId}.md`;

export const App = () => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [settings, setSettings] = useState<RedactedSettings | null>(null);
  const [rules, setRules] = useState<{ rules: string[]; ruleDefaults: Record<string, boolean>; promptMaxChars: number }>({ rules: [], ruleDefaults: {}, promptMaxChars: 2000 });
  const [tab, setTab] = useState<Tab>("issues");
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [lspState, setLspState] = useState("connecting");
  const [lspDiagnostics, setLspDiagnostics] = useState<Record<string, LspDiagnostic[]>>({});
  const [stats, setStats] = useState<LintStats | null>(null);
  const [findings, setFindings] = useState<FactFinding[]>([]);
  const [selection, setSelection] = useState<[number, number]>([0, 0]);
  const [dialog, setDialog] = useState<"new" | "settings" | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [rewrite, setRewrite] = useState<(Rewrite & { jobId: string; documentId: string }) | null>(null);
  const [confirmResearch, setConfirmResearch] = useState(false);
  const [auditVersion, setAuditVersion] = useState(0);
  const [editorKey, setEditorKey] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [editorDiagnostics, setEditorDiagnostics] = useState<EditorDiagnostic[]>([]);
  const viewRef = useRef<EditorView | null>(null);
  const lspRef = useRef<LspClient | null>(null);
  const dirty = useRef<{ documentId: string; content: string } | null>(null);
  const saveTimer = useRef<number | null>(null);

  const activeDocument = useMemo(() => documents.find((document) => document.id === activeDocumentId) ?? null, [documents, activeDocumentId]);
  const uri = session && activeDocument ? uriFor(session.id, activeDocument.id) : null;

  const loadSessions = useCallback(async () => {
    const result = await api.sessions();
    setSessions(result.sessions);
    return result.sessions;
  }, []);

  const loadSettings = useCallback(async () => {
    const result = await api.settings();
    setSettings(result.settings);
    setRules({ rules: result.rules, ruleDefaults: result.ruleDefaults, promptMaxChars: result.promptMaxChars });
  }, []);

  const openSession = useCallback(async (sessionId: string, preferDocumentId?: string) => {
    const result = await api.session(sessionId);
    setSession(result.session);
    setDocuments(result.documents);
    const wanted = preferDocumentId ?? result.session.activeDocumentId ?? result.documents[0]?.id ?? null;
    setActiveDocumentId(wanted);
    setFindings([]);
    setTab((current) => (result.session.template === "novel" && current === "issues" && result.documents.length === 0 ? "novel" : current));
  }, []);

  const refreshDocuments = useCallback(async (sessionId: string) => {
    const result = await api.session(sessionId);
    setSession(result.session);
    setDocuments(result.documents);
    return result;
  }, []);

  useEffect(() => {
    void loadSettings();
    void loadSessions().then((all) => {
      const first = all.find((one) => !one.archived);
      if (first) {
        void openSession(first.id);
      }
    });
  }, [loadSessions, loadSettings, openSession]);

  useEffect(() => {
    const client = new LspClient({
      onDiagnostics: (docUri, _version, diagnostics) => setLspDiagnostics((current) => ({ ...current, [docUri]: diagnostics })),
      onStats: (received) => setStats(received),
      onState: setLspState,
    });
    lspRef.current = client;
    return () => client.dispose();
  }, []);

  useEffect(() => {
    if (!uri || !activeDocument) {
      setEditorDiagnostics([]);
      return;
    }

    void lspRef.current?.openDocument(uri, activeDocument.content);
    setEditorKey(`${activeDocument.id}:${activeDocument.updatedAt}`);
    return () => {
      lspRef.current?.closeDocument(uri);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, activeDocument?.id, activeDocument?.updatedAt]);

  const updateLint = useCallback(
    async (edit: (config: TextoicConfig) => TextoicConfig) => {
      if (!settings) {
        return;
      }

      const result = await api.updateSettings({ lint: edit(settings.lint) });
      setSettings(result.settings);
    },
    [settings],
  );

  const diagnosticHandlers = useMemo(
    () => ({
      onIgnoreCase: (rule: string, key: string) => void updateLint((config) => withIgnoredCase(config, rule, key)),
      onDisableRule: (rule: string) => void updateLint((config) => withSeverity(config, rule, "off")),
    }),
    [updateLint],
  );

  useEffect(() => {
    if (!uri) {
      return;
    }

    setEditorDiagnostics(toEditorDiagnostics(viewRef.current, lspDiagnostics[uri] ?? [], diagnosticHandlers));
  }, [lspDiagnostics, uri, editorKey, diagnosticHandlers]);

  const flushSave = useCallback(async () => {
    const change = dirty.current;
    if (!change || !session) {
      return;
    }

    dirty.current = null;
    try {
      const result = await api.saveDocument(session.id, change.documentId, { content: change.content });
      setDocuments((current) => current.map((document) => (document.id === result.document.id ? { ...result.document, updatedAt: document.updatedAt } : document)));
      setAuditVersion((version) => version + 1);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }, [session]);

  const onEditorChange = useCallback(
    (text: string) => {
      if (!uri || !activeDocument) {
        return;
      }

      lspRef.current?.changeDocument(uri, text);
      dirty.current = { documentId: activeDocument.id, content: text };
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
      }

      saveTimer.current = window.setTimeout(() => void flushSave(), 1500);
    },
    [uri, activeDocument, flushSave],
  );

  useEffect(() => {
    if (!session) {
      return;
    }

    return subscribeJobs(session.id, (job) => {
      setJobs((current) => {
        const previous = current[job.id];
        const finishedNow = job.status === "done" && previous?.status !== "done";
        if (finishedNow) {
          void onJobDone(job);
        }

        return { ...current, [job.id]: job };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  const onJobDone = async (job: Job) => {
    if (!session) {
      return;
    }

    const result = (job.result ?? {}) as Record<string, unknown>;
    setAuditVersion((version) => version + 1);
    if (job.action === "lint.rewrite" && result.rewrite) {
      const proposed = result.rewrite as Rewrite & { documentId: string };
      setRewrite({ ...proposed, jobId: job.id });
    } else if (job.action === "factcheck.run" && Array.isArray(result.findings)) {
      setFindings(result.findings as FactFinding[]);
      setTab("issues");
    } else if (job.action === "context.explore" && typeof result.brief === "string") {
      setNotice(`Brief ready (${result.cached ? "cached" : `${result.steps} steps`}): ${(result.brief as string).slice(0, 300)}…`);
    }

    const changed = Array.isArray(result.documentIds) ? (result.documentIds as string[]) : [];
    const refreshed = await refreshDocuments(session.id);
    if (changed.length > 0) {
      await flushSave();
      setActiveDocumentId(changed[changed.length - 1]);
    } else if (job.action === "novel.testChapter" && typeof result.documentId === "string") {
      setActiveDocumentId(result.documentId);
    }

    void refreshed;
    void loadSessions();
  };

  const startAction = async (action: string, params: Record<string, unknown>, title: string) => {
    if (!session) {
      return;
    }

    await flushSave();
    setPending({ action, params, title, estimate: null, error: null });
    try {
      const result = await api.estimate(session.id, action, params);
      setPending((current) => (current && current.action === action ? { ...current, estimate: result.estimate } : current));
    } catch (cause) {
      setPending((current) => (current && current.action === action ? { ...current, error: cause instanceof Error ? cause.message : String(cause) } : current));
    }
  };

  const confirmAction = async () => {
    if (!session || !pending) {
      return;
    }

    try {
      const result = await api.run(session.id, pending.action, pending.params);
      setJobs((current) => ({ ...current, [result.job.id]: result.job }));
      setPending(null);
    } catch (cause) {
      setPending({ ...pending, error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const createSession = async (input: { title?: string; template: TemplateKind; templateSettings?: TemplateSettings; initialContent?: string }) => {
    const created = await api.createSession(input);
    setDialog(null);
    await loadSessions();
    await openSession(created.session.id);
    if (input.template === "tweet" || input.template === "article") {
      const settingsOf = input.templateSettings as { prompt: string; minWords?: number; maxWords?: number };
      void startAction(
        input.template === "tweet" ? "generate.tweet" : "generate.article",
        { prompt: settingsOf.prompt, minWords: settingsOf.minWords, maxWords: settingsOf.maxWords, documentId: created.documents[0]?.id },
        input.template === "tweet" ? "Generate tweet" : "Generate article",
      );
    } else if (input.template === "novel") {
      setTab("novel");
      void startAction("novel.blueprint", {}, "Generate novel blueprint");
    }
  };

  const regenerate = () => {
    if (!session || !activeDocument) {
      return;
    }

    const settingsOf = session.templateSettings as { prompt?: string; minWords?: number; maxWords?: number } | undefined;
    const prompt = window.prompt("Prompt for the model (max 2000 characters):", settingsOf?.prompt ?? "");
    if (!prompt) {
      return;
    }

    if (session.template === "article") {
      void startAction("generate.article", { prompt, minWords: settingsOf?.minWords, maxWords: settingsOf?.maxWords, documentId: activeDocument.id }, "Generate article");
    } else {
      void startAction("generate.tweet", { prompt, documentId: activeDocument.id }, "Generate tweet");
    }
  };

  const factCheck = async () => {
    if (!session || !activeDocument) {
      return;
    }

    const research = await api.research(session.id);
    if (!research.hasResearch) {
      setConfirmResearch(true);
      return;
    }

    void startAction("factcheck.run", { documentId: activeDocument.id }, "Fact-check document");
  };

  const jumpTo = (from: number, to: number) => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    const length = view.state.doc.length;
    view.dispatch({ selection: { anchor: Math.min(from, length), head: Math.min(to, length) }, scrollIntoView: true });
    view.focus();
  };

  const exportDocument = (format: "markdown" | "text") => {
    if (session && activeDocument) {
      window.open(api.exportUrl(session.id, activeDocument.id, format), "_blank");
    }
  };

  const copyDocument = async () => {
    const text = viewRef.current?.state.doc.toString() ?? activeDocument?.content ?? "";
    await navigator.clipboard.writeText(text);
    setNotice("Copied to clipboard.");
  };

  const addDocument = async () => {
    if (!session) {
      return;
    }

    const created = await api.createDocument(session.id, { title: `Document ${documents.length + 1}`, content: "" });
    await refreshDocuments(session.id);
    setActiveDocumentId(created.document.id);
  };

  const uploadDocuments = async (files: FileList | null) => {
    if (!session || !files || files.length === 0) {
      return;
    }

    try {
      const result = await api.uploadDocuments(session.id, [...files]);
      await refreshDocuments(session.id);
      setActiveDocumentId(result.documents[result.documents.length - 1]?.id ?? null);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const renameDocument = async (title: string) => {
    if (!session || !activeDocument || title.trim() === "" || title === activeDocument.title) {
      return;
    }

    await api.saveDocument(session.id, activeDocument.id, { title });
    await refreshDocuments(session.id);
  };

  const deleteDocument = async () => {
    if (!session || !activeDocument || !window.confirm(`Delete "${activeDocument.title}"?`)) {
      return;
    }

    await api.deleteDocument(session.id, activeDocument.id);
    const refreshed = await refreshDocuments(session.id);
    setActiveDocumentId(refreshed.documents[0]?.id ?? null);
  };

  const applyRewrite = async () => {
    if (!session || !rewrite) {
      return;
    }

    await api.applyRewrite(session.id, rewrite.documentId, rewrite.jobId);
    setRewrite(null);
    await refreshDocuments(session.id);
    setAuditVersion((version) => version + 1);
  };

  const novelState = session?.novel ?? null;
  const activeJobs = Object.values(jobs).filter((job) => job.sessionId === session?.id);
  const lastCost = activeJobs.filter((job) => job.status === "done").sort((one, other) => (other.finishedAt ?? "").localeCompare(one.finishedAt ?? ""))[0];
  const hasSelection = selection[0] !== selection[1];

  return (
    <div className="app">
      <Sidebar sessions={sessions} activeId={session?.id ?? null} onSelect={(id) => void flushSave().then(() => openSession(id))} onNew={() => setDialog("new")} onSettings={() => setDialog("settings")} lspState={lspState} provider={settings ? `${settings.provider} · ${settings.model || "no model"}` : ""} />

      <main className="main">
        {session ? (
          <>
            <div className="toolbar">
              <div className="doc-tabs">
                {documents.map((document) => (
                  <span key={document.id} className={`doc-tab${document.id === activeDocumentId ? " active" : ""}`} onClick={() => void flushSave().then(() => setActiveDocumentId(document.id))}>{document.title}</span>
                ))}
                <span className="doc-tab" onClick={() => void addDocument()} title="New document in this session">+</span>
                <label className="doc-tab" title="Upload .txt, .md, .docx or .html as a new document">↑ upload<input type="file" multiple style={{ display: "none" }} onChange={(event) => void uploadDocuments(event.target.files)} /></label>
              </div>
              <span className="grow" />
              {(session.template === "tweet" || session.template === "article") && activeDocument && <button className="small" onClick={regenerate}>Generate…</button>}
              {activeDocument && <button className="small" onClick={() => void startAction("lint.rewrite", { documentId: activeDocument.id, start: selection[0], end: selection[1] }, hasSelection ? "Rewrite selection with AI" : "Rewrite paragraph with AI")}>{hasSelection ? "Rewrite selection" : "Rewrite ¶"}</button>}
              {activeDocument && <button className="small" onClick={() => void factCheck()}>Fact-check</button>}
              {activeDocument && <button className="small" onClick={() => void lspRef.current?.relint(uri ?? "")}>Re-lint</button>}
              {activeDocument && (
                <>
                  <button className="small ghost" onClick={() => exportDocument("markdown")}>.md</button>
                  <button className="small ghost" onClick={() => exportDocument("text")}>.txt</button>
                  <button className="small ghost" onClick={() => void copyDocument()}>Copy</button>
                </>
              )}
            </div>
            {activeDocument && (
              <div className="toolbar" style={{ paddingTop: 4, paddingBottom: 4 }}>
                <input className="title-input grow" type="text" defaultValue={activeDocument.title} key={activeDocument.id} onBlur={(event) => void renameDocument(event.target.value)} />
                <span className="small-text muted">{activeDocument.wordCount} words</span>
                <button className="small ghost" onClick={() => void deleteDocument()}>Delete</button>
              </div>
            )}
            <div className="editor-wrap">
              {activeDocument ? (
                <Editor key={editorKey} docKey={editorKey} initialText={activeDocument.content} onChange={onEditorChange} onSelection={(from, to) => setSelection([from, to])} diagnostics={editorDiagnostics} onReady={(view) => { viewRef.current = view; setEditorDiagnostics(toEditorDiagnostics(view, (uri && lspDiagnostics[uri]) || [], diagnosticHandlers)); }} />
              ) : (
                <div className="empty" style={{ paddingTop: 80 }}>
                  {session.template === "novel" ? "Build and approve the blueprint in the Novel panel, then generate a test chapter." : "No document. Add one with +."}
                </div>
              )}
            </div>
            <div className="statusbar">
              <span>{editorDiagnostics.length} style issue{editorDiagnostics.length === 1 ? "" : "s"}</span>
              {stats && stats.uri === uri && <span>re-parsed {stats.parsedBlocks}/{stats.parsedBlocks + stats.reusedBlocks} blocks in {stats.durationMs} ms</span>}
              <span>linter: {lspState}</span>
              {settings && <span>{settings.provider} · {settings.model || "no model set"}</span>}
              {lastCost && <span>last action: {formatUsd(lastCost.spentUsd)}</span>}
              {notice && <span className="grow" style={{ textAlign: "right", cursor: "pointer" }} onClick={() => setNotice(null)}>{notice}</span>}
            </div>
          </>
        ) : (
          <div className="empty" style={{ paddingTop: 120 }}>Create a session to get started.</div>
        )}
      </main>

      <aside className="panel">
        <div className="tabs">
          {(["issues", "context", "research", "audit", ...(novelState ? ["novel"] : []), "session"] as Tab[]).map((one) => (
            <span key={one} className={`tab${tab === one ? " active" : ""}`} onClick={() => setTab(one)}>{one === "issues" ? `Issues${editorDiagnostics.length ? ` (${editorDiagnostics.length})` : ""}` : one[0].toUpperCase() + one.slice(1)}</span>
          ))}
        </div>
        <div className="panel-body">
          {session && tab === "issues" && (
            <>
              <IssuesPanel diagnostics={editorDiagnostics} findings={findings} onJump={jumpTo} hasSelection={hasSelection} onRewrite={() => activeDocument && void startAction("lint.rewrite", { documentId: activeDocument.id, start: selection[0], end: selection[1] }, "Rewrite with AI")} onFactCheck={() => void factCheck()} />
              <FactCheckHistory session={session} version={auditVersion} onSelect={(run: FactCheckRun) => setFindings(run.findings)} />
            </>
          )}
          {session && tab === "context" && (
            <ContextPanel session={session} sessions={sessions} onChanged={() => void refreshDocuments(session.id).then(() => setAuditVersion((version) => version + 1))} onDigest={() => void startAction("context.digest", {}, "Digest context items")} onExplore={() => { const task = window.prompt("What is the brief for? Describe the writing task:"); if (task) void startAction("context.explore", { task }, "Explore context"); }} />
          )}
          {session && tab === "research" && settings && (
            <ResearchPanel session={session} document={activeDocument} defaults={settings.research} onRun={(params) => void startAction("research.run", params, "Deep research")} />
          )}
          {session && tab === "audit" && <AuditPanel session={session} version={auditVersion} />}
          {session && tab === "novel" && novelState && (
            <NovelPanel sessionId={session.id} novel={novelState} onGenerate={(steps?: BlueprintStep[]) => void startAction("novel.blueprint", steps ? { steps } : {}, "Generate blueprint sections")} onTestChapter={() => void startAction("novel.testChapter", {}, "Generate test chapter")} onSaved={(novel: NovelState) => { setSession((current) => (current ? { ...current, novel } : current)); setAuditVersion((version) => version + 1); }} />
          )}
          {session && tab === "session" && (
            <div>
              <div className="panel-section">
                <h3>Session</h3>
                <div className="field"><label>Title</label><input type="text" defaultValue={session.title} key={session.id} onBlur={(event) => void api.updateSession(session.id, { title: event.target.value }).then(() => loadSessions()).then(() => refreshDocuments(session.id))} /></div>
                <div className="small-text muted">Template: {session.template}. Created {new Date(session.createdAt).toLocaleString()}.</div>
                {session.templateSettings && "prompt" in session.templateSettings && <p className="small-text">Prompt: {session.templateSettings.prompt}</p>}
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="small ghost" onClick={() => void api.updateSession(session.id, { archived: !session.archived }).then(() => loadSessions()).then(() => refreshDocuments(session.id))}>{session.archived ? "Restore" : "Archive"}</button>
                  <button className="small danger" onClick={() => { if (window.confirm("Delete this session and all its documents? Context items stay in the shared store.")) void api.deleteSession(session.id).then(() => { setSession(null); setDocuments([]); return loadSessions(); }); }}>Delete</button>
                </div>
              </div>
              <div className="panel-section">
                <h3>Documents · {documents.length}</h3>
                <div className="list">
                  {documents.map((document) => (
                    <div key={document.id} className="card clickable" onClick={() => setActiveDocumentId(document.id)}>
                      <div className="head"><span className="name">{document.title}</span><span className="small-text muted">{document.wordCount} words</span></div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>

      <JobsBar jobs={activeJobs.filter((job) => job.status !== "done" || Date.now() - Date.parse(job.finishedAt ?? job.createdAt) < 60_000)} onDismiss={(jobId) => setJobs((current) => { const next = { ...current }; delete next[jobId]; return next; })} />

      {dialog === "new" && <NewSessionDialog promptMax={rules.promptMaxChars} onClose={() => setDialog(null)} onCreate={createSession} />}
      {dialog === "settings" && settings && <SettingsDialog settings={settings} onClose={() => setDialog(null)} onSaved={(saved) => { setSettings(saved); setDialog(null); }} />}
      {pending && <CostDialog title={pending.title} estimate={pending.estimate} error={pending.error} onClose={() => setPending(null)} onConfirm={() => void confirmAction()} />}
      {rewrite && <RewriteDialog rewrite={rewrite} onClose={() => setRewrite(null)} onApply={applyRewrite} />}
      {confirmResearch && session && (
        <ConfirmDialog
          title="No research in this session"
          message={<p>Fact-checking compares claims against a deep-research report attached to the session, and there is none yet. Generate one now? You can set the topic and budget in the Research panel first.</p>}
          confirmLabel="Open research"
          onClose={() => setConfirmResearch(false)}
          onConfirm={() => { setConfirmResearch(false); setTab("research"); }}
        />
      )}
    </div>
  );
};
