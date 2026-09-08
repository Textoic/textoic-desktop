import type { LintIssue } from "@textoic/core/types";
import {
  CodeAction,
  CodeActionKind,
  Diagnostic,
  DiagnosticSeverity,
  TextEdit,
  type Range,
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

export const SOURCE = "textoic";

export interface FixData {
  ruleId: string;
  fixes: { range: [number, number]; text: string }[];
}

export const rangeOf = (document: TextDocument, start: number, end: number): Range => ({
  start: document.positionAt(start),
  end: document.positionAt(Math.max(start, end)),
});

export const toDiagnostic = (document: TextDocument, issue: LintIssue): Diagnostic => {
  const data: FixData = {
    ruleId: issue.id,
    fixes: (issue.suggestions ?? []).map((suggestion) => ({ range: suggestion.range, text: suggestion.text })),
  };
  return {
    range: rangeOf(document, issue.start, issue.end),
    message: issue.message,
    severity: DiagnosticSeverity.Warning,
    source: SOURCE,
    code: issue.id,
    data,
  };
};

const overlaps = (one: Range, other: Range) =>
  !(one.end.line < other.start.line || (one.end.line === other.start.line && one.end.character < other.start.character)) &&
  !(other.end.line < one.start.line || (other.end.line === one.start.line && other.end.character < one.start.character));

export const codeActionsFor = (document: TextDocument, diagnostics: Diagnostic[], range: Range): CodeAction[] =>
  diagnostics
    .filter((diagnostic) => diagnostic.source === SOURCE && overlaps(diagnostic.range, range))
    .flatMap((diagnostic) => {
      const data = diagnostic.data as FixData | undefined;
      return (data?.fixes ?? []).map((fix) => {
        const edit = TextEdit.replace(rangeOf(document, fix.range[0], fix.range[1]), fix.text);
        const label = fix.text === "" ? `Delete "${document.getText(edit.range).trim()}"` : `Replace with "${fix.text}"`;
        return CodeAction.create(
          `${label} (${data?.ruleId ?? "textoic"})`,
          { changes: { [document.uri]: [edit] } },
          CodeActionKind.QuickFix,
        );
      });
    })
    .map((action, _index, all) => {
      const duplicates = all.filter((other) => other.title === action.title);
      return duplicates[0] === action ? action : null;
    })
    .filter((action): action is CodeAction => action !== null);
