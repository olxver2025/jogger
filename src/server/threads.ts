import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalMode,
  Attachment,
  CreateThreadBody,
  EventBody,
  MessageOrigin,
  PendingApproval,
  Project,
  Thread,
  ThreadEvent,
  UpdateThreadBody,
} from '../shared/protocol.js';
import type { AdapterEvent, AgentSession, ApprovalRequest } from './providers/types.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { Store } from './store.js';
import type { Hub } from './hub.js';
import type { DaemonConfig } from './config.js';
import { newId } from './config.js';
import { mimeFor, slug } from './util.js';
import { createWorktree } from './worktree.js';

/** Context carried by a turn so agent-to-agent calls can detect loops and depth. */
export interface TurnContext {
  hops: number;
  /** Agent request this turn is answering, if any. */
  requestId: string | null;
}

interface QueueItem {
  text: string;
  attachments: Attachment[];
  origin: MessageOrigin;
  ctx: TurnContext;
}

export interface TurnResult {
  status: 'completed' | 'interrupted' | 'failed';
  text: string;
  attachments: Attachment[];
  error?: string;
}

interface ActiveTurn {
  turnId: string | null;
  origin: MessageOrigin;
  ctx: TurnContext;
  messages: { itemId: string; text: string; final: boolean }[];
  attachments: Attachment[];
}

interface Live {
  session: AgentSession;
  token: string;
}

interface Pending {
  approval: PendingApproval;
  resolve: (d: ApprovalDecision) => void;
}

export interface ThreadManagerDeps {
  config: DaemonConfig;
  store: Store;
  hub: Hub;
  providers: ProviderRegistry;
  mcpUrl: () => string;
  childEnv: () => Record<string, string>;
}

const TOOL_MERGE_KEYS = ['kind', 'name', 'title', 'input', 'output', 'exitCode'] as const;

export class ThreadManager {
  private live = new Map<string, Live>();
  private tokens = new Map<string, string>(); // token -> threadId
  private queues = new Map<string, QueueItem[]>();
  private active = new Map<string, ActiveTurn>();
  private pending = new Map<string, Pending>();
  private tools = new Map<string, Map<string, Extract<EventBody, { type: 'tool' }>>>();
  /** Listeners waiting for a specific agent request to finish (requestId -> callback). */
  private requestWaiters = new Map<string, (r: TurnResult) => void>();
  /** Hook the agent router installs to build each thread's instructions. */
  instructionsFor: (t: Thread) => string = () => '';
  /** Hook for notifying the Telegram bridge etc. about finished turns. */
  onTurnDone: ((thread: Thread, origin: MessageOrigin, result: TurnResult) => void)[] = [];

  constructor(private d: ThreadManagerDeps) {
    // Turns that were running when the daemon stopped can't continue.
    for (const t of d.store.threads()) {
      if (t.status !== 'idle' || t.queued) {
        const wasBusy = t.status === 'running' || t.status === 'waiting' || t.status === 'starting';
        t.status = 'idle';
        t.queued = 0;
        d.store.putThread(t);
        if (wasBusy) d.store.appendEvent(t.id, { type: 'notice', text: 'Jogger restarted while this thread was working. Send a message to continue.' });
      }
    }
  }

  // ---------- projects
  createProject(dir: string, name?: string): Project {
    const abs = path.resolve(dir.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`${abs} is not a folder.`);
    const existing = this.d.store.projects().find((p) => p.path === abs);
    if (existing) return existing;
    const p: Project = { id: newId('p'), name: name?.trim() || path.basename(abs), path: abs, createdAt: Date.now() };
    this.d.store.putProject(p);
    this.d.hub.broadcast({ type: 'project', project: p });
    return p;
  }

  removeProject(id: string) {
    for (const t of this.d.store.threads().filter((t) => t.projectId === id)) void this.deleteThread(t.id);
    this.d.store.deleteProject(id);
    this.d.hub.broadcast({ type: 'project.removed', projectId: id });
  }

  // ---------- threads
  thread(id: string): Thread {
    const t = this.d.store.thread(id);
    if (!t) throw new Error(`No thread ${id}`);
    return t;
  }

  threads(): Thread[] {
    return this.d.store.threads();
  }

  uniqueHandle(base: string, exceptId?: string): string {
    const taken = new Set(this.d.store.threads().filter((t) => t.id !== exceptId && !t.archived).map((t) => t.handle.toLowerCase()));
    const root = slug(base, 20);
    if (!taken.has(root)) return root;
    for (let i = 2; ; i++) if (!taken.has(`${root}-${i}`)) return `${root}-${i}`;
  }

  async createThread(
    body: CreateThreadBody & { kind?: Thread['kind']; parentThreadId?: string | null; origin?: MessageOrigin; ctx?: TurnContext },
  ): Promise<Thread> {
    const project = this.d.store.project(body.projectId);
    if (!project) throw new Error('Unknown project');
    const persona = body.personaId ? this.d.store.persona(body.personaId) : null;
    const provider = body.provider ?? persona?.provider ?? 'claude';
    const adapter = this.d.providers.get(provider);
    const model = body.model ?? persona?.model ?? adapter.defaultModel;
    const mode: ApprovalMode = body.mode ?? persona?.mode ?? 'ask';
    const handle = this.uniqueHandle(body.handle || persona?.handle || provider);
    const id = newId('t');
    let cwd = project.path;
    let worktree = null;
    if (body.worktree) {
      worktree = await createWorktree(project.path, this.d.config.worktreesDir, `${handle}-${id.slice(-4)}`);
      cwd = worktree.path;
    }
    const now = Date.now();
    const t: Thread = {
      id,
      projectId: project.id,
      title: body.title?.trim() || '',
      handle,
      provider,
      model,
      mode,
      personaId: persona?.id ?? null,
      cwd,
      worktree,
      kind: body.kind ?? 'user',
      parentThreadId: body.parentThreadId ?? null,
      providerSessionId: null,
      status: 'idle',
      queued: 0,
      archived: false,
      createdAt: now,
      updatedAt: now,
      lastEventAt: now,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
    this.d.store.putThread(t);
    this.d.hub.broadcast({ type: 'thread', thread: t });
    if (worktree) this.append(t.id, { type: 'notice', text: `Working in a new worktree on branch ${worktree.branch} at ${worktree.path}` });
    if (body.prompt?.trim()) {
      const atts = (body.attachmentIds ?? []).map((a) => this.d.store.attachment(a)).filter(Boolean) as Attachment[];
      this.enqueue(t.id, { text: body.prompt, attachments: atts, origin: body.origin ?? { kind: 'user' }, ctx: body.ctx ?? { hops: 0, requestId: null } });
    }
    return this.thread(t.id);
  }

  async updateThread(id: string, patch: UpdateThreadBody): Promise<Thread> {
    const t = this.thread(id);
    if (patch.title !== undefined) t.title = patch.title.trim();
    if (patch.handle !== undefined && patch.handle.trim()) t.handle = this.uniqueHandle(patch.handle, id);
    if (patch.archived !== undefined) t.archived = patch.archived;
    const live = this.live.get(id);
    if (patch.mode && patch.mode !== t.mode) {
      t.mode = patch.mode;
      await live?.session.setMode(patch.mode);
      this.append(id, { type: 'notice', text: `Approval mode set to ${patch.mode}.` });
    }
    if (patch.model !== undefined && patch.model !== t.model) {
      t.model = patch.model;
      if (live?.session.setModel) await live.session.setModel(patch.model);
      else await this.dropSession(id);
      this.append(id, { type: 'notice', text: `Model set to ${patch.model || 'default'}.` });
    }
    this.save(t);
    return t;
  }

  async deleteThread(id: string) {
    await this.interrupt(id).catch(() => {});
    // Anyone waiting on this thread (queued or running requests) gets an answer now, not at their timeout.
    this.clearQueue(id);
    if (this.active.has(id)) this.finishTurn(id, { status: 'interrupted', error: 'the thread was deleted' });
    await this.dropSession(id);
    this.queues.delete(id);
    this.d.store.deleteThread(id);
    this.d.hub.broadcast({ type: 'thread.removed', threadId: id });
  }

  events(id: string, after = 0): ThreadEvent[] {
    return this.d.store.events(id, after);
  }

  threadForToken(token: string): Thread | null {
    const id = this.tokens.get(token);
    return id ? this.d.store.thread(id) : null;
  }

  activeContext(threadId: string): TurnContext {
    return this.active.get(threadId)?.ctx ?? { hops: 0, requestId: null };
  }

  isBusy(threadId: string): boolean {
    return this.active.has(threadId) || (this.queues.get(threadId)?.length ?? 0) > 0;
  }

  // ---------- messages and turns
  sendUserMessage(threadId: string, text: string, attachmentIds: string[] = [], origin: MessageOrigin = { kind: 'user' }) {
    const atts = attachmentIds.map((a) => this.d.store.attachment(a)).filter(Boolean) as Attachment[];
    this.enqueue(threadId, { text, attachments: atts, origin, ctx: { hops: 0, requestId: null } });
  }

  /** Queue a message from another agent. Resolves with the reply once the turn finishes. */
  deliverAgentMessage(threadId: string, item: QueueItem): Promise<TurnResult> {
    return new Promise((resolve) => {
      if (item.ctx.requestId) this.requestWaiters.set(item.ctx.requestId, resolve);
      this.enqueue(threadId, item);
    });
  }

  cancelRequest(requestId: string) {
    this.requestWaiters.delete(requestId);
  }

  private enqueue(threadId: string, item: QueueItem) {
    const t = this.thread(threadId);
    const q = this.queues.get(threadId) ?? [];
    q.push(item);
    this.queues.set(threadId, q);
    if (!t.title && item.origin.kind !== 'reply') t.title = item.text.replace(/\s+/g, ' ').trim().slice(0, 60);
    t.queued = q.length;
    if (t.archived) t.archived = false;
    this.save(t);
    void this.pump(threadId);
  }

  private async pump(threadId: string) {
    if (this.active.has(threadId)) return;
    const q = this.queues.get(threadId);
    const item = q?.shift();
    if (!item) return;
    const t = this.thread(threadId);
    t.queued = q!.length;
    const turn: ActiveTurn = { turnId: null, origin: item.origin, ctx: item.ctx, messages: [], attachments: [] };
    this.active.set(threadId, turn);
    this.append(threadId, { type: 'user.message', text: item.text, attachments: item.attachments, origin: item.origin });
    t.status = 'starting';
    this.save(t);
    try {
      const live = await this.ensureSession(t);
      const images = item.attachments.filter((a) => a.mime.startsWith('image/')).map((a) => a.path);
      const others = item.attachments.filter((a) => !a.mime.startsWith('image/'));
      let text = item.text;
      if (item.origin.kind === 'agent') {
        text =
          `[Message from agent @${item.origin.handle} via Jogger${item.origin.mode === 'ask' ? '. They are waiting for your answer: your final message this turn is sent back to them' : ''}. Images or files you generate this turn are delivered to them automatically; do not save, copy or re-encode them yourself]\n\n` +
          text;
      } else if (item.origin.kind === 'reply') {
        text = `[Reply from agent @${item.origin.handle} to your earlier message]\n\n` + text;
      } else if (item.origin.kind === 'schedule') {
        text = `[Scheduled task "${item.origin.name}" — nobody may be watching; finish without asking questions]\n\n` + text;
      } else if (item.origin.kind === 'telegram') {
        text = `[Sent from Telegram by ${item.origin.from}; keep the final answer short]\n\n` + text;
      }
      if (others.length) text += `\n\nAttached files:\n${others.map((a) => `- ${a.path}`).join('\n')}`;
      await live.session.send({ text, images });
      const cur = this.thread(threadId);
      if (cur.status === 'starting') {
        cur.status = 'running';
        this.save(cur);
      }
    } catch (err) {
      const message = (err as Error).message;
      this.append(threadId, { type: 'error', message });
      this.append(threadId, { type: 'turn.completed', turnId: turn.turnId ?? 'unstarted', status: 'failed', error: message });
      this.finishTurn(threadId, { status: 'failed', error: message });
      await this.dropSession(threadId);
    }
  }

  private async ensureSession(t: Thread): Promise<Live> {
    const existing = this.live.get(t.id);
    if (existing) return existing;
    const adapter = this.d.providers.get(t.provider);
    const token = crypto.randomBytes(24).toString('base64url');
    const persona = t.personaId ? this.d.store.persona(t.personaId) : null;
    const instructions = [this.instructionsFor(t), persona?.systemPrompt].filter(Boolean).join('\n\n');
    const session = adapter.createSession({
      threadId: t.id,
      cwd: t.cwd,
      model: t.model,
      mode: t.mode,
      instructions,
      resumeId: t.providerSessionId,
      mcp: { url: this.d.mcpUrl(), token },
      env: this.d.childEnv(),
      emit: (ev) => this.onAdapterEvent(t.id, ev),
      requestApproval: (req) => this.requestApproval(t.id, req),
      saveAttachment: (f) => this.saveAttachment({ ...f, sourceThreadId: t.id }),
    });
    const live = { session, token };
    this.live.set(t.id, live);
    this.tokens.set(token, t.id);
    return live;
  }

  private async dropSession(threadId: string) {
    const live = this.live.get(threadId);
    if (!live) return;
    this.live.delete(threadId);
    this.tokens.delete(live.token);
    await live.session.close().catch(() => {});
  }

  private onAdapterEvent(threadId: string, ev: AdapterEvent) {
    const turn = this.active.get(threadId);
    switch (ev.type) {
      case 'session': {
        const t = this.thread(threadId);
        t.providerSessionId = ev.providerSessionId;
        this.d.store.putThread(t);
        return;
      }
      case 'delta':
        this.d.hub.broadcast({ type: 'delta', threadId, itemId: ev.itemId, kind: ev.kind, text: ev.text });
        return;
      case 'turn.started':
        if (turn) turn.turnId = ev.turnId;
        this.append(threadId, { type: 'turn.started', turnId: ev.turnId });
        return;
      case 'assistant.message': {
        if (!ev.text.trim()) return;
        if (turn) {
          const existing = turn.messages.find((m) => m.itemId === ev.itemId);
          if (existing) existing.text = ev.text;
          else turn.messages.push({ itemId: ev.itemId, text: ev.text, final: !!ev.final });
        }
        this.append(threadId, ev);
        return;
      }
      case 'reasoning':
        this.append(threadId, ev);
        return;
      case 'tool': {
        const map = this.tools.get(threadId) ?? new Map();
        this.tools.set(threadId, map);
        const prev = map.get(ev.itemId);
        let merged: Extract<EventBody, { type: 'tool' }> = { ...ev };
        if (prev) {
          merged = { ...prev, status: ev.status };
          for (const k of TOOL_MERGE_KEYS) {
            const v = ev[k];
            if (v === undefined || v === '' || (k === 'kind' && v === 'other')) continue;
            (merged as any)[k] = v;
          }
        }
        map.set(ev.itemId, merged);
        this.append(threadId, merged);
        return;
      }
      case 'attachment':
        turn?.attachments.push(ev.attachment);
        this.append(threadId, ev);
        return;
      case 'usage': {
        const t = this.thread(threadId);
        t.usage.inputTokens += ev.inputTokens;
        t.usage.outputTokens += ev.outputTokens;
        t.usage.costUsd += ev.costUsd;
        this.d.store.putThread(t);
        this.append(threadId, ev);
        return;
      }
      case 'turn.completed':
        this.append(threadId, ev);
        this.finishTurn(threadId, { status: ev.status, error: ev.error });
        return;
      case 'error':
        this.append(threadId, ev);
        return;
      case 'closed':
        if (ev.error) this.append(threadId, { type: 'notice', text: `Agent process stopped: ${ev.error}. It will resume on the next message.` });
        if (this.active.has(threadId)) {
          const error = ev.error ?? 'session closed';
          this.append(threadId, { type: 'turn.completed', turnId: turn?.turnId ?? 'closed', status: 'failed', error });
          this.finishTurn(threadId, { status: 'failed', error });
        }
        void this.dropSession(threadId);
        return;
    }
  }

  private finishTurn(threadId: string, r: { status: TurnResult['status']; error?: string }) {
    const turn = this.active.get(threadId);
    // Tools the provider never closed (interrupts, crashes) get a final state so the UI stops spinning.
    for (const tool of this.tools.get(threadId)?.values() ?? []) {
      if (tool.status !== 'running') continue;
      if (r.status === 'completed') this.append(threadId, { ...tool, status: 'done' });
      else this.append(threadId, { ...tool, status: 'failed', output: tool.output ?? (r.status === 'interrupted' ? 'Stopped' : 'Did not finish') });
    }
    this.active.delete(threadId);
    this.tools.delete(threadId);
    // Any approvals still open for this thread are moot now.
    for (const [id, p] of this.pending) if (p.approval.threadId === threadId) this.resolveApproval(id, 'deny', 'turn ended');
    const t = this.d.store.thread(threadId);
    if (!t) return;
    t.status = 'idle';
    t.queued = this.queues.get(threadId)?.length ?? 0;
    this.save(t);
    if (turn) {
      const final = [...turn.messages].reverse().find((m) => m.final) ?? turn.messages[turn.messages.length - 1];
      const result: TurnResult = {
        status: r.status,
        text: final?.text ?? (r.status === 'completed' ? '' : `(turn ${r.status}${r.error ? ': ' + r.error : ''})`),
        attachments: turn.attachments,
        error: r.error,
      };
      if (turn.ctx.requestId) {
        const w = this.requestWaiters.get(turn.ctx.requestId);
        this.requestWaiters.delete(turn.ctx.requestId);
        w?.(result);
      }
      for (const fn of this.onTurnDone) {
        try {
          fn(t, turn.origin, result);
        } catch {
          /* listener errors must not break the thread */
        }
      }
    }
    setImmediate(() => void this.pump(threadId));
  }

  async interrupt(threadId: string, seen = new Set<string>()) {
    if (seen.has(threadId)) return;
    seen.add(threadId);
    const live = this.live.get(threadId);
    for (const [id, p] of this.pending) if (p.approval.threadId === threadId) this.resolveApproval(id, 'deny', 'interrupted');
    // Stopping an agent also stops the work it is waiting on through ask_agent.
    const asked = (o: MessageOrigin) => o.kind === 'agent' && o.mode === 'ask' && o.threadId === threadId;
    for (const [other, q] of this.queues) {
      const keep: QueueItem[] = [];
      for (const item of q) {
        if (!asked(item.origin)) {
          keep.push(item);
          continue;
        }
        const w = item.ctx.requestId ? this.requestWaiters.get(item.ctx.requestId) : undefined;
        if (item.ctx.requestId) this.requestWaiters.delete(item.ctx.requestId);
        w?.({ status: 'interrupted', text: '(stopped before it started)', attachments: [] });
      }
      if (keep.length !== q.length) {
        this.queues.set(other, keep);
        const t = this.d.store.thread(other);
        if (t) {
          t.queued = keep.length;
          this.save(t);
        }
      }
    }
    for (const [other, turn] of this.active) if (other !== threadId && asked(turn.origin)) await this.interrupt(other, seen);
    if (live && this.active.has(threadId)) await live.session.interrupt();
  }

  /** Clear queued messages that haven't started yet. */
  clearQueue(threadId: string) {
    const q = this.queues.get(threadId) ?? [];
    for (const item of q) {
      if (item.ctx.requestId) {
        const w = this.requestWaiters.get(item.ctx.requestId);
        this.requestWaiters.delete(item.ctx.requestId);
        w?.({ status: 'interrupted', text: '(the user cleared this message before it ran)', attachments: [] });
      }
    }
    this.queues.set(threadId, []);
    const t = this.thread(threadId);
    t.queued = 0;
    this.save(t);
  }

  // ---------- approvals
  private requestApproval(threadId: string, req: ApprovalRequest): Promise<ApprovalDecision> {
    const t = this.thread(threadId);
    const turn = this.active.get(threadId);
    const unattended = turn && (turn.origin.kind === 'schedule' || (t.kind === 'helper' && turn.origin.kind === 'agent'));
    if (unattended && this.d.store.settings().unattendedApprovals === 'deny') {
      this.append(threadId, { type: 'notice', text: `Denied automatically (unattended run): ${req.title}` });
      return Promise.resolve('deny');
    }
    const requestId = newId('a');
    const approval: PendingApproval = { requestId, threadId, ...req, createdAt: Date.now() };
    return new Promise((resolve) => {
      this.pending.set(requestId, { approval, resolve });
      this.broadcastApprovals();
      this.append(threadId, { type: 'approval.request', requestId, ...req });
      t.status = 'waiting';
      this.save(t);
    });
  }

  resolveApproval(requestId: string, decision: ApprovalDecision, by = 'you') {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    this.append(p.approval.threadId, { type: 'approval.resolved', requestId, decision, by });
    const t = this.d.store.thread(p.approval.threadId);
    if (t && t.status === 'waiting' && ![...this.pending.values()].some((x) => x.approval.threadId === t.id)) {
      t.status = this.active.has(t.id) ? 'running' : 'idle';
      this.save(t);
    }
    p.resolve(decision);
    this.broadcastApprovals();
    return true;
  }

  pendingApprovals(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.approval);
  }

  private broadcastApprovals() {
    this.d.hub.broadcast({ type: 'approvals', pendingApprovals: this.pendingApprovals() });
  }

  // ---------- attachments
  async saveAttachment(f: { path?: string; data?: Buffer; name: string; mime?: string; sourceThreadId?: string | null }): Promise<Attachment> {
    const id = newId('f');
    const name = path.basename(f.name).replace(/[^\w.\- ]+/g, '_') || 'file';
    const dir = path.join(this.d.config.attachmentsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, name);
    if (f.path) await fs.promises.copyFile(f.path, dest);
    else await fs.promises.writeFile(dest, f.data ?? Buffer.alloc(0));
    const a: Attachment = {
      id,
      name,
      mime: f.mime ?? mimeFor(name),
      size: fs.statSync(dest).size,
      path: dest,
      url: `/api/attachments/${id}/${encodeURIComponent(name)}`,
      sourceThreadId: f.sourceThreadId ?? null,
    };
    this.d.store.putAttachment(a);
    return a;
  }

  /** Record an attachment against the thread's current turn (used by share_file). */
  addTurnAttachment(threadId: string, a: Attachment) {
    this.active.get(threadId)?.attachments.push(a);
    this.append(threadId, { type: 'attachment', attachment: a });
  }

  append(threadId: string, body: EventBody): ThreadEvent {
    const ev = this.d.store.appendEvent(threadId, body);
    const t = this.d.store.thread(threadId);
    if (t) {
      t.lastEventAt = ev.ts;
      this.d.store.putThread(t);
    }
    this.d.hub.broadcast({ type: 'event', event: ev });
    return ev;
  }

  private save(t: Thread) {
    t.updatedAt = Date.now();
    this.d.store.putThread(t);
    this.d.hub.broadcast({ type: 'thread', thread: t });
  }

  async shutdown() {
    await Promise.all([...this.live.keys()].map((id) => this.dropSession(id)));
  }
}
