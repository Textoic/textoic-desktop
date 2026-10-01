import { ruleCatalog } from "@textoic/enlint/catalog";
import type { Scope } from "@textoic/enlint-lsp/fixes";
import { groupedByRule, overlapping } from "@textoic/enlint-lsp/issues";
import type { EditorView } from "@codemirror/view";
import { useState } from "react";
import type { VisibleRange } from "../editor";
import type { LspDiagnostic } from "../lsp-client";

export type IssueMode = "inView" | "byType";

export interface IssueHandlers {
  onJump: (from: number, to: number) => void;
  onRewrite: (from: number, to: number) => void;
  onIgnoreInstance: (rule: string, from: number, to: number) => void;
  onIgnoreCase: (rule: string, key: string) => void;
  onDisableRule: (rule: string) => void;
  onApplyAll: (scope: Scope, label: string) => void;
}

interface Issue {
  rule: string;
  case?: string;
  message: string;
  quote: string;
  start: number;
  end: number;
}

const ruleNames = new Map(ruleCatalog.map(({ id, name }) => [id as string, name]));

const nameOf = (rule: string) => ruleNames.get(rule) ?? rule;

const offsetIn = (view: EditorView, { line, character }: { line: number; character: number }) => {
  const target = view.state.doc.line(Math.min(view.state.doc.lines, line + 1));
  return Math.min(target.to, target.from + character);
};

const issueOf = (view: EditorView) => (diagnostic: LspDiagnostic): Issue => {
  const start = offsetIn(view, diagnostic.range.start);
  const end = offsetIn(view, diagnostic.range.end);
  return {
    rule: diagnostic.data?.rule ?? String(diagnostic.code ?? ""),
    ...(diagnostic.data?.case === undefined ? {} : { case: diagnostic.data.case }),
    message: diagnostic.message,
    quote: view.state.sliceDoc(start, end),
    start,
    end,
  };
};

const byPosition = (one: Issue, other: Issue) => one.start - other.start;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

type CaseCounts = Map<string, number>;

const caseKey = (rule: string, key: string) => `${rule}::${key}`;

const countCases = (issues: Issue[]): CaseCounts =>
  issues.reduce((counts, issue) => (issue.case === undefined ? counts : counts.set(caseKey(issue.rule, issue.case), (counts.get(caseKey(issue.rule, issue.case)) ?? 0) + 1)), new Map<string, number>());

const IssueCard = ({ issue, showRule, handlers, cases }: { issue: Issue; showRule: boolean; handlers: IssueHandlers; cases: CaseCounts }) => (
  <div className="card issue">
    <div className="clickable" onClick={() => handlers.onJump(issue.start, issue.end)}>
      <div className="issue-quote">“{issue.quote}”</div>
      {showRule && <div className="issue-rule">{nameOf(issue.rule)}</div>}
      <div className="small-text muted">{issue.message}</div>
    </div>
    <div className="issue-actions">
      <button className="link" onClick={() => handlers.onRewrite(issue.start, issue.end)}>Rewrite</button>
      <button className="link" onClick={() => handlers.onIgnoreInstance(issue.rule, issue.start, issue.end)}>Ignore this one</button>
      {issue.case !== undefined && (cases.get(caseKey(issue.rule, issue.case)) ?? 0) > 1 && <button className="link" onClick={() => handlers.onApplyAll({ rule: issue.rule, case: issue.case }, `“${issue.case ?? ""}”`)}>Apply all “{issue.case}” ({cases.get(caseKey(issue.rule, issue.case))})</button>}
      {issue.case !== undefined && <button className="link" onClick={() => handlers.onIgnoreCase(issue.rule, issue.case ?? "")}>Ignore “{issue.case}” everywhere</button>}
      <button className="link" onClick={() => handlers.onDisableRule(issue.rule)}>Turn off rule</button>
    </div>
  </div>
);

const Groups = ({ issues, handlers, cases }: { issues: Issue[]; handlers: IssueHandlers; cases: CaseCounts }) => {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (rule: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(rule)) {
        next.add(rule);
      }

      return next;
    });
  return (
    <div className="list">
      {groupedByRule([...issues].sort(byPosition), nameOf).map(({ rule, issues: members }) => (
        <div key={rule} className="issue-group">
          <div className="row issue-group-head">
            <button className="link grow group-toggle" aria-expanded={!collapsed.has(rule)} onClick={() => toggle(rule)}>
              {collapsed.has(rule) ? "▸" : "▾"} {nameOf(rule)} <span className="badge">{members.length}</span>
            </button>
            <button className="link" onClick={() => handlers.onApplyAll({ rule }, nameOf(rule))}>Apply all</button>
            <button className="link" onClick={() => handlers.onDisableRule(rule)}>Turn off</button>
          </div>
          {!collapsed.has(rule) && members.map((issue) => <IssueCard key={`${issue.start}-${issue.end}`} issue={issue} showRule={false} handlers={handlers} cases={cases} />)}
        </div>
      ))}
    </div>
  );
};

const emptyNote = (mode: IssueMode, total: number) =>
  total === 0 ? "No style issues found. Issues appear a few seconds after you stop typing." : mode === "inView" ? `Nothing in view. ${plural(total, "issue")} elsewhere; scroll or switch to By type.` : null;

export const StyleIssues = ({ diagnostics, view, visible, mode, onMode, handlers, ignoredCount, onRestore }: { diagnostics: LspDiagnostic[]; view: EditorView | null; visible: VisibleRange | null; mode: IssueMode; onMode: (mode: IssueMode) => void; handlers: IssueHandlers; ignoredCount: number; onRestore: () => void }) => {
  const issues = view ? diagnostics.map(issueOf(view)) : [];
  const shown = mode === "inView" ? (visible ? overlapping(issues, { start: visible.from, end: visible.to }).sort(byPosition) : []) : issues;
  const note = shown.length === 0 ? emptyNote(mode, issues.length) : null;
  const cases = countCases(issues);
  return (
    <div>
      <div className="segmented" role="radiogroup" aria-label="Show issues">
        <button role="radio" aria-checked={mode === "inView"} className={mode === "inView" ? "active" : ""} onClick={() => onMode("inView")}>In view</button>
        <button role="radio" aria-checked={mode === "byType"} className={mode === "byType" ? "active" : ""} onClick={() => onMode("byType")}>By type</button>
      </div>
      {note && <div className="empty">{note}</div>}
      {shown.length > 0 && (mode === "inView" ? <div className="list">{shown.map((issue) => <IssueCard key={`${issue.rule}-${issue.start}`} issue={issue} showRule handlers={handlers} cases={cases} />)}</div> : <Groups issues={shown} handlers={handlers} cases={cases} />)}
      {ignoredCount > 0 && (
        <div className="small-text muted" style={{ marginTop: 8 }}>
          {plural(ignoredCount, "ignored instance")} in this document. <button className="link" onClick={onRestore}>Show them again</button>
        </div>
      )}
    </div>
  );
};
