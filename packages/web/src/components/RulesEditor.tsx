import { casesOf, ruleCatalog, type RuleInfo } from "@textoic/enlint/catalog";
import {
  ignoredCasesIn,
  severityIn,
  withIgnoredCase,
  withoutIgnoredCase,
  withSeverity,
  type Severity,
  type TextoicConfig,
} from "@textoic/enlint-lsp/config";
import { useMemo, useState } from "react";

const severities: Severity[] = ["off", "hint", "info", "warn", "error"];

const CaseSearch = ({ rule, ignored, onIgnore }: { rule: string; ignored: string[]; onIgnore: (key: string) => void }) => {
  const [query, setQuery] = useState("");
  const cases = useMemo(() => casesOf(rule), [rule]);
  const matches = query.trim() === ""
    ? []
    : cases
        .filter(({ key, label }) => !ignored.includes(key) && `${key} ${label}`.toLowerCase().includes(query.trim().toLowerCase()))
        .slice(0, 12);
  return (
    <div className="case-search">
      <input type="search" placeholder={`Search ${cases.length} cases to ignore`} value={query} onChange={(event) => setQuery(event.target.value)} />
      {matches.map((match) => (
        <div key={match.key} className="row case-row">
          <span className="grow">
            {match.label} <span className="muted">→ {match.suggestions.join(", ")}</span>
          </span>
          <button className="small ghost" onClick={() => onIgnore(match.key)}>Ignore</button>
        </div>
      ))}
    </div>
  );
};

const RuleRow = ({ rule, config, onChange }: { rule: RuleInfo; config: TextoicConfig; onChange: (config: TextoicConfig) => void }) => {
  const [open, setOpen] = useState(false);
  const configured = severityIn(config, rule.id);
  const ignored = ignoredCasesIn(config, rule.id);
  return (
    <div className="rule">
      <div className="row">
        <button className="link grow" onClick={() => setOpen(!open)}>
          <strong>{rule.name}</strong> <span className="muted">{rule.summary}</span>
        </button>
        <select value={configured ?? "default"} onChange={(event) => onChange(withSeverity(config, rule.id, event.target.value === "default" ? (rule.enabledByDefault ? "warn" : "off") : (event.target.value as Severity)))}>
          <option value="default">default ({rule.enabledByDefault ? "on" : "off"})</option>
          {severities.map((severity) => (
            <option key={severity} value={severity}>{severity}</option>
          ))}
        </select>
      </div>
      {open && (
        <div className="rule-details">
          <p>{rule.description}</p>
          <ul>
            {rule.examples.map((example) => (
              <li key={example.text}>
                “{example.text}”{example.suggestion ? <span className="muted"> → {example.suggestion}</span> : null}
              </li>
            ))}
          </ul>
          {rule.hasCases && (
            <>
              <div className="small-text muted">Ignored cases</div>
              <div className="row wrap">
                {ignored.length === 0 && <span className="small-text muted">None.</span>}
                {ignored.map((key) => (
                  <span key={key} className="chip">
                    {key} <button className="link" aria-label={`Stop ignoring ${key}`} onClick={() => onChange(withoutIgnoredCase(config, rule.id, key))}>×</button>
                  </span>
                ))}
              </div>
              <CaseSearch rule={rule.id} ignored={ignored} onIgnore={(key) => onChange(withIgnoredCase(config, rule.id, key))} />
            </>
          )}
        </div>
      )}
    </div>
  );
};

export const RulesEditor = ({ config, onChange }: { config: TextoicConfig; onChange: (config: TextoicConfig) => void }) => (
  <div className="rules-editor">
    {ruleCatalog.map((rule) => (
      <RuleRow key={rule.id} rule={rule} config={config} onChange={onChange} />
    ))}
  </div>
);
