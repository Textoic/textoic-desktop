import type { Job } from "@textoic/core/types";
import { api, formatUsd } from "../api";

const label = (job: Job) => job.action.replace(/\./gu, " › ");

export const JobsBar = ({ jobs, onDismiss }: { jobs: Job[]; onDismiss: (jobId: string) => void }) => {
  if (jobs.length === 0) {
    return null;
  }

  return (
    <div className="jobs">
      {jobs.map((job) => {
        const percent = job.progress.total > 0 ? Math.round((job.progress.done / job.progress.total) * 100) : 0;
        const active = job.status === "queued" || job.status === "running";
        return (
          <div className="job" key={job.id}>
            <div className="row">
              <span className="grow">
                <strong>{label(job)}</strong>{" "}
                <span className={`badge ${job.status === "done" ? "ok" : job.status === "failed" ? "bad" : job.status === "cancelled" ? "warn" : "ai"}`}>{job.status}</span>
              </span>
              {active ? (
                <button className="small ghost" onClick={() => void api.cancelJob(job.id)}>Cancel</button>
              ) : (
                <button className="small ghost" onClick={() => onDismiss(job.id)}>×</button>
              )}
            </div>
            <div className="small-text muted">
              {job.status === "failed" ? job.error : job.progress.message ?? job.progress.step}
              {job.spentUsd > 0 ? ` · spent ${formatUsd(job.spentUsd)}` : ""}
            </div>
            {active && (
              <div className="bar">
                <span style={{ width: `${Math.max(4, percent)}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
