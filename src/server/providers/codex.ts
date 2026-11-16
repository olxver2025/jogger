import fs from 'node:fs';
import os from 'node:os';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import type { ApprovalMode, ToolKind } from '../../shared/protocol.js';
import type { AgentSession, ProviderAdapter, SessionOptions, UserInput } from './types.js';
import { truncate } from './types.js';
import { which } from '../util.js';

// Talks to `codex app-server` over stdio JSON-RPC. One child process serves every Codex
// thread; each thread gets its own Jogger MCP token through the per-thread config override.
// Protocol types come from `codex app-server generate-ts` (codex-cli 0.162); only the fields
// used here are relied on.

const run = promisify(execFile);

const MODE_MAP: Record<ApprovalMode, { approvalPolicy: string; sandbox: string; sandboxPolicy: unknown }> = {
  ask: { approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
  auto: {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  },
  full: { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } },
};

type Json = any;

class CodexHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; method: string }>();
  private buf = '';
  private ready: Promise<void> | null = null;
  readonly sessions = new Map<string, CodexSession>(); // codex thread id -> session
  models: { id: string; label: string }[] = [];

  constructor(private bin: string, private env: () => Record<string, string>) {}

  async ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.boot().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  private async boot() {
    const child = spawn(this.bin, ['app-server'], { cwd: os.homedir(), env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => this.onData(d));
    child.stderr.on('data', () => {}); // codex logs noisily to stderr; protocol errors arrive as messages
    child.on('exit', (code) => {
      this.child = null;
      this.ready = null;
      for (const p of this.pending.values()) p.reject(new Error(`codex app-server exited (${code})`));
      this.pending.clear();
      for (const s of this.sessions.values()) s.hostDied(`codex app-server exited (${code})`);
      this.sessions.clear();
    });
    child.on('error', () => {});
    await this.request('initialize', { clientInfo: { name: 'jogger', title: 'Jogger', version: '0.1.0' }, capabilities: null });
    this.notify('initialized');
    try {
      const res = await this.request('model/list', { limit: 50 });
      this.models = (res?.data ?? []).filter((m: Json) => !m.hidden).map((m: Json) => ({ id: m.model ?? m.id, label: m.displayName ?? m.id }));
    } catch {
      /* older app-servers lack model/list */
    }
  }

  request(method: string, params: Json): Promise<Json> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('codex app-server is not running'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  notify(method: string, params?: Json) {
    this.child?.stdin.write(JSON.stringify(params === undefined ? { method } : { method, params }) + '\n');
  }

  respond(id: number | string, result: Json) {
    this.child?.stdin.write(JSON.stringify({ id, result }) + '\n');
  }

  private onData(d: string) {
    this.buf += d;
    let n: number;
    while ((n = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, n);
      this.buf = this.buf.slice(n + 1);
      if (!line.trim()) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && !msg.method) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
        continue;
      }
      const threadId: string | undefined = msg.params?.threadId;
      const session = threadId ? this.sessions.get(threadId) : undefined;
      if (msg.id != null && msg.method) {
        if (session) void session.onServerRequest(msg.id, msg.method, msg.params);
        else this.respond(msg.id, declineFor(msg.method));
        continue;
      }
      session?.onNotification(msg.method, msg.params);
    }
  }

  async shutdown() {
    this.child?.kill();
  }
}

function declineFor(method: string): Json {
  if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null };
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  return { decision: 'decline' };
}

function commandKind(item: Json): ToolKind {
  const actions: Json[] = item.commandActions ?? [];
  if (actions.length && actions.every((a) => a.type === 'read')) return 'read';
  if (actions.length && actions.every((a) => a.type === 'search' || a.type === 'listFiles')) return 'search';
  return 'command';
}

function unwrapShell(cmd: string): string {
  const m = cmd.match(/^\/bin\/(?:ba|z)?sh -l?c "(.*)"$/s) ?? cmd.match(/^\/bin\/(?:ba|z)?sh -l?c '(.*)'$/s);
  return m ? m[1].replace(/\\"/g, '"') : cmd;
}

class CodexSession implements AgentSession {
  private codexThreadId: string | null = null;
  private turnId: string | null = null;
  private turnStarted = 0;
  private dead = false;
  private modeDirty = false;
  private modelDirty = false;

  constructor(private host: CodexHost, private opts: SessionOptions) {}

  private threadConfig() {
    const o = this.opts;
    return {
      model: o.model || undefined,
      cwd: o.cwd,
      approvalPolicy: MODE_MAP[o.mode].approvalPolicy,
      sandbox: MODE_MAP[o.mode].sandbox,
      developerInstructions: o.instructions,
      config: {
        mcp_servers: {
          jogger: {
            url: o.mcp.url,
            http_headers: { Authorization: `Bearer ${o.mcp.token}` },
            tool_timeout_sec: 3600,
            startup_timeout_sec: 20,
          },
        },
      },
    };
  }

  private async ensureThread() {
    if (this.codexThreadId) return;
    await this.host.ensure();
    let res: Json;
    if (this.opts.resumeId) {
      try {
        res = await this.host.request('thread/resume', { threadId: this.opts.resumeId, ...this.threadConfig() });
      } catch (err) {
        this.opts.emit({ type: 'error', message: `Could not resume the Codex thread, starting a new one: ${(err as Error).message}` });
        res = await this.host.request('thread/start', this.threadConfig());
      }
    } else {
      res = await this.host.request('thread/start', this.threadConfig());
    }
    this.codexThreadId = res.thread.id;
    this.host.sessions.set(res.thread.id, this);
    if (res.thread.id !== this.opts.resumeId) this.opts.emit({ type: 'session', providerSessionId: res.thread.id });
  }

  async send(input: UserInput) {
    if (this.dead) throw new Error('Codex session has ended');
    await this.ensureThread();
    const items: Json[] = [{ type: 'text', text: input.text, text_elements: [] }];
    for (const p of input.images) items.push({ type: 'localImage', path: p });
    const params: Json = { threadId: this.codexThreadId, input: items };
    if (this.modeDirty) {
      params.approvalPolicy = MODE_MAP[this.opts.mode].approvalPolicy;
      params.sandboxPolicy = MODE_MAP[this.opts.mode].sandboxPolicy;
      this.modeDirty = false;
    }
    if (this.modelDirty) {
      params.model = this.opts.model || null;
      this.modelDirty = false;
    }
    this.turnStarted = Date.now();
    const res = await this.host.request('turn/start', params);
    this.turnId = res.turn.id;
    this.opts.emit({ type: 'turn.started', turnId: res.turn.id });
  }

  async interrupt() {
    if (!this.codexThreadId || !this.turnId) return;
    await this.host.request('turn/interrupt', { threadId: this.codexThreadId, turnId: this.turnId }).catch(() => {});
  }

  async setMode(mode: ApprovalMode) {
    this.opts.mode = mode;
    this.modeDirty = true;
  }

  async setModel(model: string) {
    this.opts.model = model;
    this.modelDirty = true;
  }

  async close() {
    this.dead = true;
    if (this.codexThreadId) {
      this.host.sessions.delete(this.codexThreadId);
      await this.host.request('thread/unsubscribe', { threadId: this.codexThreadId }).catch(() => {});
    }
  }

  hostDied(reason: string) {
    if (this.dead) return;
    this.dead = true;
    if (this.turnId) this.opts.emit({ type: 'turn.completed', turnId: this.turnId, status: 'failed', error: reason });
    this.turnId = null;
    this.opts.emit({ type: 'closed', error: reason });
  }

  // ---- incoming
  async onServerRequest(id: number | string, method: string, p: Json) {
    const o = this.opts;
    try {
      switch (method) {
        case 'mcpServer/elicitation/request': {
          if (p.serverName === 'jogger') return this.host.respond(id, { action: 'accept', content: {}, _meta: null });
          const tool = p._meta?.tool_title ?? p._meta?.tool_name ?? p.message ?? 'a tool';
          const d = await o.requestApproval({
            title: `MCP server ${p.serverName} wants to run ${tool}`,
            detail: truncate(JSON.stringify(p._meta?.tool_params ?? p.requestedSchema ?? {}, null, 2), 3000) ?? '',
            toolName: `mcp:${p.serverName}`,
            canAllowSession: false,
          });
          return this.host.respond(id, d === 'deny' ? { action: 'decline', content: null, _meta: null } : { action: 'accept', content: {}, _meta: null });
        }
        case 'item/commandExecution/requestApproval':
        case 'execCommandApproval': {
          const cmd = Array.isArray(p.command) ? p.command.join(' ') : p.command ?? '';
          const d = await o.requestApproval({
            title: p.reason ? `Run a command: ${p.reason}` : 'Run a command',
            detail: unwrapShell(cmd || this.pendingCommand.get(p.itemId) || ''),
            toolName: 'shell',
            canAllowSession: true,
          });
          return this.host.respond(id, { decision: d === 'allow' ? 'accept' : d === 'allow_session' ? 'acceptForSession' : 'decline' });
        }
        case 'item/fileChange/requestApproval':
        case 'applyPatchApproval': {
          const changes = this.pendingChanges.get(p.itemId) ?? [];
          const d = await o.requestApproval({
            title: p.reason ? `Edit files: ${p.reason}` : `Edit ${changes.length || ''} file${changes.length === 1 ? '' : 's'}`.replace('  ', ' '),
            detail: truncate(changes.map((c: Json) => `${c.path}\n${c.diff ?? ''}`).join('\n\n'), 6000) ?? '',
            toolName: 'apply_patch',
            canAllowSession: true,
          });
          return this.host.respond(id, { decision: d === 'allow' ? 'accept' : d === 'allow_session' ? 'acceptForSession' : 'decline' });
        }
        case 'item/permissions/requestApproval': {
          const d = await o.requestApproval({
            title: `Grant extra permissions${p.reason ? ': ' + p.reason : ''}`,
            detail: truncate(JSON.stringify(p.permissions, null, 2), 3000) ?? '',
            toolName: 'permissions',
            canAllowSession: true,
          });
          if (d === 'deny') return this.host.respond(id, { permissions: {}, scope: 'turn' });
          return this.host.respond(id, { permissions: p.permissions ?? {}, scope: d === 'allow_session' ? 'session' : 'turn' });
        }
        default:
          return this.host.respond(id, declineFor(method));
      }
    } catch {
      this.host.respond(id, declineFor(method));
    }
  }

  private pendingCommand = new Map<string, string>();
  private pendingChanges = new Map<string, Json[]>();

  onNotification(method: string, p: Json) {
    const emit = this.opts.emit;
    switch (method) {
      case 'item/agentMessage/delta':
        return emit({ type: 'delta', itemId: p.itemId, kind: 'text', text: p.delta });
      case 'item/reasoning/summaryTextDelta':
        return emit({ type: 'delta', itemId: p.itemId, kind: 'reasoning', text: p.delta });
      case 'item/started':
      case 'item/completed':
        return this.onItem(p.item, method === 'item/completed');
      case 'thread/tokenUsage/updated': {
        const last = p.tokenUsage?.last;
        if (last) this.lastUsage = last;
        return;
      }
      case 'error':
        if (!p.willRetry) emit({ type: 'error', message: p.error?.message ?? 'Codex error' });
        return;
      case 'turn/completed': {
        const t = p.turn;
        const status = t.status === 'interrupted' ? 'interrupted' : t.status === 'failed' ? 'failed' : 'completed';
        if (this.lastUsage) {
          emit({
            type: 'usage',
            inputTokens: this.lastUsage.inputTokens ?? this.lastUsage.input_tokens ?? 0,
            outputTokens: this.lastUsage.outputTokens ?? this.lastUsage.output_tokens ?? 0,
            costUsd: 0,
          });
          this.lastUsage = null;
        }
        emit({
          type: 'turn.completed',
          turnId: t.id,
          status,
          error: t.error?.message,
          durationMs: t.durationMs ?? Date.now() - this.turnStarted,
        });
        if (this.turnId === t.id) this.turnId = null;
        return;
      }
      default:
        return;
    }
  }
  private lastUsage: Json = null;

  private async onItem(item: Json, done: boolean) {
    const emit = this.opts.emit;
    switch (item.type) {
      case 'agentMessage':
        if (done) emit({ type: 'assistant.message', itemId: item.id, text: item.text ?? '', final: item.phase === 'final_answer' });
        return;
      case 'reasoning':
        if (done && item.summary?.length) emit({ type: 'reasoning', itemId: item.id, text: item.summary.join('\n\n') });
        return;
      case 'commandExecution': {
        const cmd = unwrapShell(item.command ?? '');
        this.pendingCommand.set(item.id, cmd);
        const failed = item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0);
        emit({
          type: 'tool',
          itemId: item.id,
          kind: commandKind(item),
          name: 'shell',
          title: cmd,
          input: { command: cmd, cwd: item.cwd },
          output: truncate(item.aggregatedOutput ?? undefined),
          exitCode: item.exitCode,
          status: !done ? 'running' : item.status === 'declined' ? 'denied' : failed ? 'failed' : 'done',
        });
        if (done) this.pendingCommand.delete(item.id);
        return;
      }
      case 'fileChange': {
        const changes: Json[] = item.changes ?? [];
        this.pendingChanges.set(item.id, changes);
        emit({
          type: 'tool',
          itemId: item.id,
          kind: 'file',
          name: 'apply_patch',
          title: changes.map((c) => c.path).join(', ') || 'file change',
          input: { files: changes.map((c) => ({ path: c.path, kind: c.kind?.type ?? c.kind })) },
          output: truncate(changes.map((c) => c.diff).join('\n'), 12000),
          status: !done ? 'running' : item.status === 'declined' ? 'denied' : item.status === 'failed' ? 'failed' : 'done',
        });
        if (done) this.pendingChanges.delete(item.id);
        return;
      }
      case 'mcpToolCall': {
        const result = item.result?.content
          ?.map((c: Json) => (c.type === 'text' ? c.text : `[${c.type}]`))
          .join('\n');
        emit({
          type: 'tool',
          itemId: item.id,
          kind: item.server === 'jogger' ? 'agent' : 'mcp',
          name: `${item.server}.${item.tool}`,
          title: item.server === 'jogger' ? `${item.tool}${item.arguments?.to ? ' → ' + item.arguments.to : ''}` : `${item.server} · ${item.tool}`,
          input: item.arguments,
          output: truncate(item.error?.message ?? result),
          status: !done ? 'running' : item.status === 'failed' || item.error ? 'failed' : 'done',
        });
        return;
      }
      case 'webSearch':
        emit({
          type: 'tool',
          itemId: item.id,
          kind: 'web',
          name: 'web_search',
          title: item.query ?? item.action?.query ?? 'web search',
          status: done ? 'done' : 'running',
        });
        return;
      case 'imageGeneration': {
        emit({
          type: 'tool',
          itemId: item.id,
          kind: 'image',
          name: 'image_generation',
          title: item.revisedPrompt ?? 'Generating image',
          status: !done ? 'running' : item.status === 'completed' ? 'done' : 'failed',
          output: item.failure ? JSON.stringify(item.failure) : undefined,
        });
        if (done && item.status === 'completed') {
          try {
            const name = `image-${item.id.slice(-8)}.png`;
            const att =
              item.savedPath && fs.existsSync(item.savedPath)
                ? await this.opts.saveAttachment({ path: item.savedPath, name: item.savedPath.split('/').pop() ?? name })
                : await this.opts.saveAttachment({ data: Buffer.from(item.result, 'base64'), name, mime: 'image/png' });
            emit({ type: 'attachment', attachment: att });
          } catch (err) {
            emit({ type: 'error', message: `Could not save the generated image: ${(err as Error).message}` });
          }
        }
        return;
      }
      case 'contextCompaction':
        if (done) emit({ type: 'tool', itemId: item.id, kind: 'other', name: 'compaction', title: 'Compacted the conversation', status: 'done' });
        return;
      default:
        return;
    }
  }
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = 'codex';
  readonly label = 'Codex';
  readonly defaultModel = '';
  readonly capabilities = { imageInput: true, imageGeneration: true, webSearch: true, resume: true };
  private bin: string | null;
  private host: CodexHost | null = null;

  constructor(private env: () => Record<string, string>) {
    this.bin = process.env.JOGGER_CODEX_BIN ?? which('codex');
  }

  models() {
    const known = this.host?.models ?? [];
    return known.length ? known : [{ id: '', label: 'Default (from ~/.codex/config.toml)' }];
  }

  async check() {
    if (!this.bin) return { ok: false, version: null, error: 'codex CLI not found on PATH. Install Codex and run `codex login`.' };
    try {
      const { stdout } = await run(this.bin, ['--version'], { timeout: 15000 });
      return { ok: true, version: stdout.trim().split(/\s+/).pop() ?? null, error: null };
    } catch (err) {
      return { ok: false, version: null, error: (err as Error).message };
    }
  }

  /** Boot the app-server early so the model list is populated. */
  async warm() {
    if (!this.bin) return;
    this.host ??= new CodexHost(this.bin, this.env);
    await this.host.ensure().catch(() => {});
  }

  createSession(opts: SessionOptions): AgentSession {
    if (!this.bin) throw new Error('codex CLI not found on PATH');
    this.host ??= new CodexHost(this.bin, this.env);
    return new CodexSession(this.host, opts);
  }

  async shutdown() {
    await this.host?.shutdown();
  }
}
