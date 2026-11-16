import type { ProviderInfo } from '../../shared/protocol.js';
import type { ProviderAdapter } from './types.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { MockAdapter } from './mock.js';

export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();
  private info = new Map<string, ProviderInfo>();

  constructor(env: () => Record<string, string>, opts: { mock: boolean }) {
    this.register(new ClaudeAdapter());
    this.register(new CodexAdapter(env));
    if (opts.mock) this.register(new MockAdapter());
  }

  /** Third-party adapters call this; see docs/ADAPTERS.md. */
  register(adapter: ProviderAdapter) {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ProviderAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`Unknown provider "${id}". Known: ${[...this.adapters.keys()].join(', ')}`);
    return a;
  }

  has(id: string) {
    return this.adapters.has(id);
  }

  list(): ProviderInfo[] {
    return [...this.adapters.values()].map(
      (a) =>
        this.info.get(a.id) ?? {
          id: a.id,
          label: a.label,
          available: false,
          version: null,
          error: 'Checking…',
          models: a.models(),
          defaultModel: a.defaultModel,
          capabilities: a.capabilities,
        },
    );
  }

  async refresh(): Promise<ProviderInfo[]> {
    await Promise.all(
      [...this.adapters.values()].map(async (a) => {
        const c = await a.check();
        if (c.ok && a instanceof CodexAdapter) await a.warm();
        this.info.set(a.id, {
          id: a.id,
          label: a.label,
          available: c.ok,
          version: c.version,
          error: c.error,
          models: a.models(),
          defaultModel: a.defaultModel,
          capabilities: a.capabilities,
        });
      }),
    );
    return this.list();
  }

  async shutdown() {
    await Promise.all([...this.adapters.values()].map((a) => a.shutdown?.()));
  }
}
