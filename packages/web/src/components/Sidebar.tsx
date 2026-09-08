import type { Session } from "@textoic/core/types";
import { useState } from "react";
import { timeAgo } from "../api";

const TEMPLATE_LABEL: Record<Session["template"], string> = { blank: "text", tweet: "tweet", article: "article", novel: "novel" };

export const Sidebar = ({ sessions, activeId, onSelect, onNew, onSettings, lspState, provider }: { sessions: Session[]; activeId: string | null; onSelect: (id: string) => void; onNew: () => void; onSettings: () => void; lspState: string; provider: string }) => {
  const [showArchived, setShowArchived] = useState(false);
  const visible = sessions.filter((session) => showArchived || !session.archived);
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="row">
          <span className="brand grow">Textoic</span>
          <button className="primary small" onClick={onNew}>+ New</button>
        </div>
        <div className="small-text muted" style={{ marginTop: 4 }}>Sessions</div>
      </div>
      <div className="session-list">
        {visible.length === 0 && <div className="empty small-text">No sessions yet. Start one to paste text or generate from a template.</div>}
        {visible.map((session) => (
          <div key={session.id} className={`session-item${session.id === activeId ? " active" : ""}`} onClick={() => onSelect(session.id)}>
            <div className="title">{session.title}</div>
            <div className="small-text muted">
              {TEMPLATE_LABEL[session.template]} · {session.documentIds.length} doc{session.documentIds.length === 1 ? "" : "s"} · {session.contextItemIds.length} ctx · {timeAgo(session.updatedAt)}
              {session.archived ? " · archived" : ""}
            </div>
          </div>
        ))}
      </div>
      <div className="sidebar-foot">
        <label className="small-text"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>
        <div className="row" style={{ marginTop: 6 }}>
          <button className="ghost small grow" onClick={onSettings}>Settings</button>
        </div>
        <div className="small-text muted" style={{ marginTop: 6 }}>{provider} · linter {lspState}</div>
      </div>
    </aside>
  );
};
