export interface BlueprintFinding {
  path: string[];
  before: string;
  after: string | null;
  reason: string;
  references: string[];
}

export interface BlueprintReviewRound {
  findings: BlueprintFinding[];
  applied: boolean;
  error?: string;
}

export interface BlueprintReviewReport {
  status: "passed" | "needs-review";
  stopReason: "clean" | "limit" | "blocked" | "cycle";
  rounds: BlueprintReviewRound[];
}

export const REVIEW_MAX_EDITS = 2;
export const REVIEW_OUTPUT_TOKENS = 8000;

export const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "before", "after", "reason", "references"],
        properties: {
          path: { type: "array", items: { type: "string" }, minItems: 1 },
          before: { type: "string" },
          after: { type: ["string", "null"] },
          reason: { type: "string" },
          references: { type: "array", items: { type: "string" }, minItems: 1 },
        },
      },
    },
  },
};

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (item: unknown) => typeof item === "string" && item.trim() !== "",
  );

export const reviewFindingsFrom = (value: unknown): BlueprintFinding[] => {
  const raw = value as { findings?: unknown } | null;
  if (!Array.isArray(raw?.findings))
    throw new Error("Invalid blueprint review findings");
  return raw.findings.map((value: unknown) => {
    const finding = value as BlueprintFinding | null;
    if (
      !finding ||
      !strings(finding.path) ||
      !strings(finding.references) ||
      typeof finding.before !== "string" ||
      typeof finding.reason !== "string" ||
      !finding.reason.trim() ||
      !(
        finding.after === null ||
        (typeof finding.after === "string" && finding.after.trim() !== "")
      )
    ) {
      throw new Error("Invalid blueprint review suggestion");
    }
    return finding;
  });
};

const leafOwner = (value: unknown, path: string[]) => {
  let owner = value;
  for (const key of path.slice(0, -1)) {
    if (
      owner === null ||
      typeof owner !== "object" ||
      !Object.hasOwn(owner, key)
    )
      throw new Error("Review path is absent");
    owner = (owner as Record<string, unknown>)[key];
  }
  if (owner === null || typeof owner !== "object")
    throw new Error("Review path has no owner");
  return owner as Record<string, unknown>;
};

export const applyReviewFindings = <T>(
  value: T,
  findings: BlueprintFinding[],
  canEdit: (path: string[]) => boolean,
): T => {
  const result = structuredClone(value);
  const paths = new Set<string>();
  for (const finding of findings) {
    const path = finding.path;
    const key = path.at(-1) ?? "";
    const encoded = JSON.stringify(path);
    if (
      paths.has(encoded) ||
      path.some(
        (key) =>
          !/^(?:[A-Za-z][A-Za-z0-9]*|\d+)$/u.test(key) ||
          ["__proto__", "prototype", "constructor"].includes(key),
      ) ||
      key === "id" ||
      !canEdit(path)
    )
      throw new Error(`Review cannot edit ${path.join(".")}`);
    const owner = leafOwner(result, path);
    if (
      !Object.hasOwn(owner, key) ||
      typeof owner[key] !== "string" ||
      owner[key] !== finding.before
    )
      throw new Error(`Review anchor changed: ${path.join(".")}`);
    if (finding.after === null || finding.after === finding.before)
      throw new Error(`Review has no supported edit: ${path.join(".")}`);
    owner[key] = finding.after;
    paths.add(encoded);
  }
  return result;
};

type ReviewOptions<T> = {
  initial: T;
  review: (value: T, round: number) => Promise<BlueprintFinding[]>;
  canEdit: (path: string[]) => boolean;
  validate: (value: T, findings: BlueprintFinding[]) => void;
  onRound?: (value: T, report: BlueprintReviewReport) => Promise<void>;
  maxEdits?: number;
  signal?: AbortSignal;
};

const editedValue = <T>(
  options: ReviewOptions<T>,
  value: T,
  findings: BlueprintFinding[],
) => {
  const candidate = applyReviewFindings(value, findings, options.canEdit);
  options.validate(candidate, findings);
  return candidate;
};

export const reviewEditLoop = async <T>(options: ReviewOptions<T>) => {
  const maxEdits = options.maxEdits ?? REVIEW_MAX_EDITS;
  if (!Number.isInteger(maxEdits) || maxEdits < 0 || maxEdits > 4)
    throw new Error("Review edits must be between zero and four");
  let value = structuredClone(options.initial);
  const seen = new Set([JSON.stringify(value)]);
  const report: BlueprintReviewReport = {
    status: "needs-review",
    stopReason: "limit",
    rounds: [],
  };
  for (let round = 0; round <= maxEdits; round += 1) {
    options.signal?.throwIfAborted();
    const findings = reviewFindingsFrom({
      findings: await options.review(structuredClone(value), round),
    });
    options.signal?.throwIfAborted();
    const entry: BlueprintReviewRound = { findings, applied: false };
    report.rounds.push(entry);
    if (findings.length === 0) {
      report.status = "passed";
      report.stopReason = "clean";
    } else if (round < maxEdits) {
      try {
        const candidate = editedValue(options, value, findings);
        if (seen.has(JSON.stringify(candidate))) {
          report.stopReason = "cycle";
        } else {
          value = candidate;
          seen.add(JSON.stringify(candidate));
          entry.applied = true;
        }
      } catch (cause) {
        entry.error = String(cause);
        report.stopReason = "blocked";
      }
    }
    await options.onRound?.(structuredClone(value), structuredClone(report));
    if (!entry.applied) break;
  }
  return { value, report };
};
