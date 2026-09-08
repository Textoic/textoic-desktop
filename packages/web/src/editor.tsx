import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { lintGutter, setDiagnostics, type Action, type Diagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { LspDiagnostic } from "./lsp-client";

export interface EditorDiagnostic {
  from: number;
  to: number;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  source: string;
  actions?: Action[];
}

export interface EditorHandle {
  view: EditorView;
}

interface EditorProps {
  docKey: string;
  initialText: string;
  onChange: (text: string) => void;
  onSelection?: (from: number, to: number) => void;
  diagnostics: EditorDiagnostic[];
  onReady?: (view: EditorView) => void;
  readOnly?: boolean;
}

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "15px", backgroundColor: "var(--paper)" },
  ".cm-scroller": { fontFamily: "'Iowan Old Style', 'Palatino Linotype', Georgia, serif", lineHeight: "1.7", padding: "0 0 40vh 0" },
  ".cm-content": { padding: "24px 32px", maxWidth: "76ch", caretColor: "var(--ink)" },
  ".cm-line": { padding: "0" },
  ".cm-gutters": { backgroundColor: "var(--paper)", border: "none", color: "var(--muted)" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-lintRange-warning": { backgroundImage: "none", borderBottom: "2px solid var(--warn)" },
  ".cm-lintRange-error": { backgroundImage: "none", borderBottom: "2px solid var(--bad)" },
  ".cm-lintRange-info": { backgroundImage: "none", borderBottom: "2px dotted var(--ok)" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: "6px", fontFamily: "system-ui, sans-serif", fontSize: "13px" },
  ".cm-tooltip-lint": { maxWidth: "420px" },
  ".cm-diagnosticAction": { backgroundColor: "var(--accent)", borderRadius: "4px", padding: "2px 8px" },
});

export const toEditorDiagnostics = (view: EditorView | null, diagnostics: LspDiagnostic[]): EditorDiagnostic[] => {
  if (!view) {
    return [];
  }

  const doc = view.state.doc;
  const offset = (position: { line: number; character: number }) => {
    const line = doc.line(Math.min(doc.lines, position.line + 1));
    return Math.min(line.to, line.from + position.character);
  };
  return diagnostics.map((diagnostic) => ({
    from: offset(diagnostic.range.start),
    to: offset(diagnostic.range.end),
    message: `${diagnostic.message}${diagnostic.code ? `  [${diagnostic.code}]` : ""}`,
    severity: "warning",
    source: "style",
    actions: (diagnostic.data?.fixes ?? []).slice(0, 4).map((fix) => ({
      name: fix.text === "" ? "Delete" : `Use "${fix.text}"`,
      apply: (editor: EditorView, _from: number, _to: number) => {
        editor.dispatch({ changes: { from: fix.range[0], to: fix.range[1], insert: fix.text } });
      },
    })),
  }));
};

export const Editor = ({ docKey, initialText, onChange, onSelection, diagnostics, onReady, readOnly }: EditorProps) => {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSelectionRef = useRef(onSelection);
  onChangeRef.current = onChange;
  onSelectionRef.current = onSelection;

  useEffect(() => {
    if (!host.current) {
      return;
    }

    const extensions: Extension[] = [
      lineNumbers(),
      history(),
      markdown(),
      syntaxHighlighting(defaultHighlightStyle),
      highlightSelectionMatches(),
      lintGutter(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      placeholder("Paste or write your text here. Style issues appear a few seconds after you stop typing."),
      EditorView.lineWrapping,
      theme,
      readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly ?? false)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }

        if (update.selectionSet || update.docChanged) {
          const range = update.state.selection.main;
          onSelectionRef.current?.(range.from, range.to);
        }
      }),
    ];
    const view = new EditorView({ state: EditorState.create({ doc: initialText, extensions }), parent: host.current });
    viewRef.current = view;
    onReady?.(view);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    const length = view.state.doc.length;
    const mapped: Diagnostic[] = diagnostics
      .filter((diagnostic) => diagnostic.from <= length)
      .map((diagnostic) => ({ ...diagnostic, to: Math.min(diagnostic.to, length) }));
    view.dispatch(setDiagnostics(view.state, mapped));
  }, [diagnostics]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly ?? false)) });
  }, [readOnly]);

  return <div className="editor" ref={host} />;
};
