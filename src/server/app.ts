import type { AppState, Settings } from '../shared/protocol.js';
import { loadConfig, VERSION, type DaemonConfig } from './config.js';
import { Store } from './store.js';
import { Hub } from './hub.js';
import { ProviderRegistry } from './providers/registry.js';
import { ThreadManager } from './threads.js';
import { AgentRouter } from './agents.js';
import { Scheduler } from './scheduler.js';
import { TelegramBridge } from './telegram.js';

const SECRET_MASK = '••••';

export class App {
  readonly version = VERSION;
  readonly config: DaemonConfig;
  readonly store: Store;
  readonly hub = new Hub();
  readonly providers: ProviderRegistry;
  readonly threads: ThreadManager;
  readonly agents: AgentRouter;
  readonly scheduler: Scheduler;
  readonly telegram: TelegramBridge;
  private port = 0;

  constructor(config: DaemonConfig = loadConfig(), opts: { mock?: boolean } = {}) {
    this.config = config;
    this.store = new Store(config.dbPath);
    const env = () => this.childEnv();
    this.providers = new ProviderRegistry(env, { mock: opts.mock ?? process.env.JOGGER_MOCK !== '0' });
    this.threads = new ThreadManager({
      config,
      store: this.store,
      hub: this.hub,
      providers: this.providers,
      mcpUrl: () => `http://127.0.0.1:${this.port || config.port}/mcp`,
      childEnv: env,
    });
    this.agents = new AgentRouter(this.threads, this.store, this.providers);
    this.scheduler = new Scheduler(this.store, this.hub, this.threads);
    this.telegram = new TelegramBridge(this.store, this.hub, this.threads);
  }

  setPort(port: number) {
    this.port = port;
  }

  /** Environment for agent processes. API keys are removed by default so the CLIs use your subscription login. */
  childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    if (this.store.settings().stripApiKeys) {
      for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[k];
    }
    for (const k of Object.keys(env)) if (k.startsWith('JOGGER_')) delete env[k];
    env.JOGGER = '1';
    return env;
  }

  publicSettings(): Settings {
    const s = this.store.settings();
    const t = s.telegram.botToken;
    return { ...s, telegram: { ...s.telegram, botToken: t ? SECRET_MASK + t.slice(-4) : '' } };
  }

  /** Merge a settings patch from the UI, ignoring masked secrets sent back unchanged. */
  mergeSettings(patch: Partial<Settings>): Settings {
    const cur = this.store.settings();
    const tg = { ...(patch.telegram ?? {}) } as Partial<Settings['telegram']>;
    if (typeof tg.botToken === 'string' && tg.botToken.startsWith(SECRET_MASK)) delete tg.botToken;
    const next: Settings = {
      ...cur,
      ...patch,
      keybindings: { ...cur.keybindings, ...(patch.keybindings ?? {}) },
      telegram: { ...cur.telegram, ...tg },
    };
    this.store.putSettings(next);
    return next;
  }

  state(): AppState {
    return {
      projects: this.store.projects(),
      threads: this.threads.threads(),
      personas: this.store.personas(),
      providers: this.providers.list(),
      schedules: this.scheduler.list(),
      settings: this.publicSettings(),
      pendingApprovals: this.threads.pendingApprovals(),
      telegram: this.telegram.status,
      version: this.version,
    };
  }

  async start() {
    this.scheduler.start();
    await this.telegram.start();
    void this.providers.refresh().then((providers) => this.hub.broadcast({ type: 'providers', providers }));
  }

  async shutdown() {
    this.scheduler.stop();
    await this.telegram.stop();
    await this.threads.shutdown();
    await this.providers.shutdown();
  }
}
