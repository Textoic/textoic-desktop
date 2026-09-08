import { EventEmitter } from "node:events";
import type { CostEstimate, Job, JobProgress } from "../types.js";
import { id, now } from "../util.js";

export type JobListener = (job: Job) => void;

const KEEP_FINISHED = 200;

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  create(action: string, sessionId: string | undefined, estimate?: CostEstimate): Job {
    const job: Job = {
      id: id(),
      sessionId,
      action,
      status: "queued",
      createdAt: now(),
      progress: { step: "queued", done: 0, total: 1 },
      estimate,
      spentUsd: 0,
    };
    this.jobs.set(job.id, job);
    this.controllers.set(job.id, new AbortController());
    this.emit(job);
    this.prune();
    return job;
  }

  signal(jobId: string): AbortSignal {
    return this.controllers.get(jobId)?.signal ?? new AbortController().signal;
  }

  get(jobId: string): Job | null {
    return this.jobs.get(jobId) ?? null;
  }

  list(sessionId?: string): Job[] {
    return [...this.jobs.values()]
      .filter((job) => sessionId === undefined || job.sessionId === sessionId)
      .sort((one, other) => other.createdAt.localeCompare(one.createdAt));
  }

  update(jobId: string, patch: Partial<Job>): Job | null {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }

    Object.assign(job, patch);
    this.emit(job);
    return job;
  }

  progress(jobId: string, progress: JobProgress) {
    this.update(jobId, { progress });
  }

  spend(jobId: string, spentUsd: number) {
    const job = this.jobs.get(jobId);
    if (job && job.spentUsd !== spentUsd) {
      this.update(jobId, { spentUsd });
    }
  }

  cancel(jobId: string): boolean {
    const controller = this.controllers.get(jobId);
    const job = this.jobs.get(jobId);
    if (!controller || !job || job.status === "done" || job.status === "failed") {
      return false;
    }

    controller.abort(new Error("cancelled"));
    this.update(jobId, { status: "cancelled", finishedAt: now(), progress: { ...job.progress, step: "cancelled" } });
    return true;
  }

  subscribe(listener: JobListener): () => void {
    this.emitter.on("job", listener);
    return () => this.emitter.off("job", listener);
  }

  private emit(job: Job) {
    this.emitter.emit("job", structuredClone(job));
  }

  private prune() {
    const finished = [...this.jobs.values()]
      .filter((job) => job.status === "done" || job.status === "failed" || job.status === "cancelled")
      .sort((one, other) => (one.finishedAt ?? "").localeCompare(other.finishedAt ?? ""));
    while (finished.length > KEEP_FINISHED) {
      const oldest = finished.shift() as Job;
      this.jobs.delete(oldest.id);
      this.controllers.delete(oldest.id);
    }
  }
}
