import { resolve } from "node:path";
import { builtinActions, type ActionDeps } from "./actions/definitions.js";
import { JobRegistry } from "./actions/jobs.js";
import { ActionRunner, type ProviderFactory } from "./actions/runner.js";
import { AuditService } from "./audit/service.js";
import { ContextService } from "./context/store.js";
import { FactCheckService } from "./factcheck/service.js";
import { LintService } from "./lint/service.js";
import { listModels, providerFrom, type ProviderChoice } from "./providers/index.js";
import { ResearchService } from "./research/service.js";
import { SessionService } from "./sessions/service.js";
import { defaultSettings, isRedactedKey, mergeSettings } from "./settings.js";
import { FileStorage } from "./storage/file.js";
import type { Storage } from "./storage/storage.js";
import type { ModelInfo, ProviderKind, Settings } from "./types.js";

export interface TextoicOptions {
  dataDir?: string;
  storage?: Storage;
  fetchFn?: typeof fetch;
  providerFactory?: ProviderFactory;
}

export class Textoic {
  readonly dataDir: string;
  readonly storage: Storage;
  readonly audit: AuditService;
  readonly sessions: SessionService;
  readonly context: ContextService;
  readonly lint: LintService;
  readonly research: ResearchService;
  readonly factcheck: FactCheckService;
  readonly jobs: JobRegistry;
  readonly actions: ActionRunner;
  private readonly fetchFn: typeof fetch;
  private readonly factory: ProviderFactory;
  private cachedSettings: Settings | null = null;

  constructor(options: TextoicOptions = {}) {
    this.dataDir = resolve(options.dataDir ?? process.env.TEXTOIC_DATA ?? "data");
    this.storage = options.storage ?? new FileStorage(this.dataDir);
    this.fetchFn = options.fetchFn ?? fetch;
    this.factory = options.providerFactory ?? ((settings, choice) => providerFrom(settings, choice, this.fetchFn));
    this.audit = new AuditService(this.storage, () => this.cachedSettings?.auditCoalesceMs ?? defaultSettings().auditCoalesceMs);
    this.sessions = new SessionService(this.storage, this.audit);
    this.context = new ContextService(this.storage, this.audit);
    this.lint = new LintService(() => this.settings());
    this.research = new ResearchService(this.storage, this.context, this.dataDir);
    this.factcheck = new FactCheckService(this.storage, this.context);
    this.jobs = new JobRegistry();
    const deps: ActionDeps = {
      storage: this.storage,
      settings: () => this.settings(),
      sessions: this.sessions,
      context: this.context,
      audit: this.audit,
      lint: this.lint,
      research: this.research,
      factcheck: this.factcheck,
    };
    this.actions = new ActionRunner(deps, this.jobs, this.factory);
    builtinActions.forEach((action) => this.actions.register(action));
  }

  async settings(): Promise<Settings> {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    const stored = await this.storage.settings.get();
    this.cachedSettings = stored ? mergeSettings(defaultSettings(), stored) : defaultSettings();
    return this.cachedSettings;
  }

  async updateSettings(patch: Record<string, unknown>): Promise<Settings> {
    const current = await this.settings();
    const cleaned = { ...patch };
    if (isRedactedKey(cleaned.openrouterKey)) {
      delete cleaned.openrouterKey;
    }

    if (isRedactedKey(cleaned.serperKey)) {
      delete cleaned.serperKey;
    }

    const next = mergeSettings(current, cleaned);
    await this.storage.settings.set(next);
    this.cachedSettings = next;
    return next;
  }

  async models(kind?: ProviderKind): Promise<ModelInfo[]> {
    const settings = await this.settings();
    return listModels(settings, kind ?? settings.provider, this.fetchFn);
  }

  async provider(choice: ProviderChoice = {}) {
    return this.factory(await this.settings(), choice);
  }
}

export const createTextoic = (options: TextoicOptions = {}) => new Textoic(options);
