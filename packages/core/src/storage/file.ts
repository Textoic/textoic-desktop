import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AuditEntry,
  ContextCollection,
  ContextItem,
  Document,
  FactCheckRun,
  ResearchRecord,
  Session,
  Settings,
} from "../types.js";
import { pageOf, type AuditListOptions, type Storage } from "./storage.js";

const SAFE = /^[A-Za-z0-9_-]+$/u;

const safe = (segment: string) => {
  if (!SAFE.test(segment)) {
    throw new Error(`Unsafe storage key: ${segment}`);
  }

  return segment;
};

const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw cause;
  }
};

const writeAtomically = async (path: string, content: string) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
};

const writeJson = (path: string, value: unknown) =>
  writeAtomically(path, JSON.stringify(value, null, 2));

const jsonFilesIn = async <T>(directory: string): Promise<T[]> => {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }

  const loaded: (T | null)[] = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<T>(join(directory, name))),
  );
  return loaded.filter((one): one is T => one !== null);
};

const parseLines = (content: string): AuditEntry[] =>
  content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AuditEntry);

export class FileStorage implements Storage {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private path(...segments: string[]) {
    return join(this.root, ...segments);
  }

  private sessionDir(sessionId: string) {
    return this.path("sessions", safe(sessionId));
  }

  readonly settings = {
    get: () => readJson<Settings>(this.path("settings.json")),
    set: (settings: Settings) => writeJson(this.path("settings.json"), settings),
  };

  readonly sessions = {
    list: async (): Promise<Session[]> => {
      let names: string[];
      try {
        names = await readdir(this.path("sessions"));
      } catch {
        return [];
      }

      const loaded = await Promise.all(
        names.map((name) =>
          readJson<Session>(this.path("sessions", name, "session.json")),
        ),
      );
      return loaded.filter((one): one is Session => one !== null);
    },
    get: (id: string) => readJson<Session>(join(this.sessionDir(id), "session.json")),
    put: (session: Session) =>
      writeJson(join(this.sessionDir(session.id), "session.json"), session),
    remove: (id: string) => rm(this.sessionDir(id), { recursive: true, force: true }),
  };

  readonly documents = {
    get: (sessionId: string, id: string) =>
      readJson<Document>(
        join(this.sessionDir(sessionId), "documents", `${safe(id)}.json`),
      ),
    put: (document: Document) =>
      writeJson(
        join(
          this.sessionDir(document.sessionId),
          "documents",
          `${safe(document.id)}.json`,
        ),
        document,
      ),
    remove: (sessionId: string, id: string) =>
      rm(join(this.sessionDir(sessionId), "documents", `${safe(id)}.json`), {
        force: true,
      }),
    list: (sessionId: string) =>
      jsonFilesIn<Document>(join(this.sessionDir(sessionId), "documents")),
  };

  readonly blobs = {
    has: (hash: string) => exists(this.path("blobs", `${safe(hash)}.txt`)),
    get: async (hash: string) => {
      try {
        return await readFile(this.path("blobs", `${safe(hash)}.txt`), "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }

        throw cause;
      }
    },
    put: async (hash: string, text: string) => {
      const path = this.path("blobs", `${safe(hash)}.txt`);
      if (!(await exists(path))) {
        await writeAtomically(path, text);
      }
    },
  };

  readonly context = {
    get: (id: string) =>
      readJson<ContextItem>(this.path("context", "items", `${safe(id)}.json`)),
    put: (item: ContextItem) =>
      writeJson(this.path("context", "items", `${safe(item.id)}.json`), item),
    list: () => jsonFilesIn<ContextItem>(this.path("context", "items")),
    getCollection: (id: string) =>
      readJson<ContextCollection>(
        this.path("context", "collections", `${safe(id)}.json`),
      ),
    putCollection: (collection: ContextCollection) =>
      writeJson(
        this.path("context", "collections", `${safe(collection.id)}.json`),
        collection,
      ),
  };

  private auditPath(sessionId: string) {
    return join(this.sessionDir(sessionId), "audit.jsonl");
  }

  private async auditEntries(sessionId: string): Promise<AuditEntry[]> {
    try {
      return parseLines(await readFile(this.auditPath(sessionId), "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw cause;
    }
  }

  readonly audit = {
    append: async (entry: AuditEntry) => {
      const path = this.auditPath(entry.sessionId);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
    },
    replaceLast: async (sessionId: string, entry: AuditEntry) => {
      const entries = await this.auditEntries(sessionId);
      entries.splice(entries.length - 1, 1, entry);
      await writeAtomically(
        this.auditPath(sessionId),
        entries.map((one) => JSON.stringify(one)).join("\n") + "\n",
      );
    },
    last: async (sessionId: string) => {
      const entries = await this.auditEntries(sessionId);
      return entries[entries.length - 1] ?? null;
    },
    list: async (sessionId: string, options?: AuditListOptions) =>
      pageOf(await this.auditEntries(sessionId), options),
    get: async (sessionId: string, id: string) =>
      (await this.auditEntries(sessionId)).find((entry) => entry.id === id) ??
      null,
  };

  readonly factChecks = {
    put: (run: FactCheckRun) =>
      writeJson(
        join(this.sessionDir(run.sessionId), "factchecks", `${safe(run.id)}.json`),
        run,
      ),
    get: (sessionId: string, id: string) =>
      readJson<FactCheckRun>(
        join(this.sessionDir(sessionId), "factchecks", `${safe(id)}.json`),
      ),
    list: (sessionId: string) =>
      jsonFilesIn<FactCheckRun>(join(this.sessionDir(sessionId), "factchecks")),
  };

  readonly research = {
    put: (record: ResearchRecord) =>
      writeJson(
        join(this.sessionDir(record.sessionId), "research", `${safe(record.id)}.json`),
        record,
      ),
    list: (sessionId: string) =>
      jsonFilesIn<ResearchRecord>(join(this.sessionDir(sessionId), "research")),
  };
}
