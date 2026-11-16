import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Attachment, Thread } from '../shared/protocol.js';
import { MODE_RANK } from '../shared/protocol.js';
import type { ThreadManager, TurnResult } from './threads.js';
import type { Store } from './store.js';
import type { ProviderRegistry } from './providers/registry.js';
import { newId } from './config.js';

type ToolResult = { content: any[]; isError?: boolean };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], isError });

/**
 * Agent-to-agent messaging. Every agent session gets Jogger's MCP server with these tools,
 * authenticated by a per-thread token, so the router always knows who is calling.
 */
export class AgentRouter {
  /** threadId -> threadId it is blocked on (an ask_agent in flight). Used for deadlock checks. */
  private waitsFor = new Map<string, Set<string>>();

  constructor(
    private threads: ThreadManager,
    private store: Store,
    private providers: ProviderRegistry,
  ) {
    threads.instructionsFor = (t) => this.instructions(t);
  }

  instructions(t: Thread): string {
    const others = this.peers(t)
      .slice(0, 12)
      .map((p) => `@${p.handle} (${this.providers.has(p.provider) ? this.providers.get(p.provider).label : p.provider})`)
      .join(', ');
    return [
      `You are running inside Jogger as the agent @${t.handle}. Jogger runs several coding agents from different providers side by side, and they can message each other through the "jogger" MCP tools.`,
      `- list_agents shows who is available and what each can do. ${others ? `Right now: ${others}.` : ''}`,
      `- ask_agent sends a request and waits for the answer (text plus any files, such as generated images). Use it when another agent can do something you can't — for example Codex can generate images and Claude cannot — or for a second opinion. You can also address a provider ("codex", "claude") or a persona to start a fresh helper.`,
      `- send_message is fire-and-forget; the reply arrives later as a new message in this thread.`,
      `- share_file attaches a file you made so the user and other agents see it.`,
      `- memory_list / memory_read / memory_write hold notes shared by every agent in this project. Check memory when you start on something unfamiliar, and save durable facts (decisions, conventions, where things are) as you learn them.`,
      `Messages from other agents are marked "[Message from agent @name via Jogger]". Your final message in that turn is the reply.`,
    ].join('\n');
  }

  private peers(t: Thread): Thread[] {
    return this.threads.threads().filter((x) => x.id !== t.id && x.projectId === t.projectId && !x.archived);
  }

  // ---------- target resolution
  private async resolveTarget(caller: Thread, to: string, forceNew: boolean): Promise<{ thread: Thread; spawned: boolean }> {
    const key = to.trim().replace(/^@/, '').toLowerCase();
    const peers = this.threads.threads().filter((x) => x.id !== caller.id && !x.archived);
    if (!forceNew) {
      const byHandle =
        peers.find((x) => x.handle.toLowerCase() === key && x.projectId === caller.projectId) ??
        peers.find((x) => x.handle.toLowerCase() === key) ??
        peers.find((x) => x.id === to.trim());
      if (byHandle) return { thread: byHandle, spawned: false };
    }
    const persona = this.store.personas().find((p) => p.handle.toLowerCase() === key || p.name.toLowerCase() === key);
    const provider = persona?.provider ?? (this.providers.has(key) ? key : null);
    if (!provider) {
      const names = peers.filter((p) => p.projectId === caller.projectId).map((p) => '@' + p.handle);
      throw new Error(
        `No agent called "${to}". Available: ${names.join(', ') || 'none'}. You can also name a provider (${this.providers
          .list()
          .filter((p) => p.available)
          .map((p) => p.id)
          .join(', ')}) or a persona (${this.store
          .personas()
          .map((p) => p.handle)
          .join(', ')}) to start a helper.`,
      );
    }
    // A helper never gets more autonomy than the agent that started it.
    const wanted = persona?.mode ?? caller.mode;
    const mode = MODE_RANK[wanted] <= MODE_RANK[caller.mode] ? wanted : caller.mode;
    const thread = await this.threads.createThread({
      projectId: caller.projectId,
      provider,
      personaId: persona?.id ?? null,
      model: persona?.model,
      mode,
      handle: persona?.handle ?? provider,
      title: `Helper for @${caller.handle}`,
      kind: 'helper',
      parentThreadId: caller.id,
    });
    // Helpers share the caller's working folder, so files they write land where the caller can see them.
    if (thread.cwd !== caller.cwd) {
      thread.cwd = caller.cwd;
      this.store.putThread(thread);
    }
    return { thread: this.threads.thread(thread.id), spawned: true };
  }

  private wouldDeadlock(caller: string, target: string): boolean {
    if (caller === target) return true;
    const seen = new Set<string>();
    const stack = [target];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === caller) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of this.waitsFor.get(n) ?? []) stack.push(m);
    }
    return false;
  }

  private collectFiles(caller: Thread, paths: string[] | undefined): Promise<Attachment[]> {
    return Promise.all(
      (paths ?? []).map(async (p) => {
        const abs = path.resolve(caller.cwd, p);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`File not found: ${p}`);
        return this.threads.saveAttachment({ path: abs, name: path.basename(abs), sourceThreadId: caller.id });
      }),
    );
  }

  // ---------- tool implementations
  async listAgents(caller: Thread) {
    const providers = this.providers.list();
    const label = (id: string) => providers.find((p) => p.id === id);
    const lines = this.peers(caller).map((t) => {
      const p = label(t.provider);
      const caps = p ? Object.entries(p.capabilities).filter(([, v]) => v).map(([k]) => k).join(', ') : '';
      return `- @${t.handle}: ${p?.label ?? t.provider}${t.model ? ' ' + t.model : ''}, ${t.status}${this.threads.isBusy(t.id) ? ' (busy, requests queue)' : ''}${t.title ? `, working on "${t.title}"` : ''}${caps ? ` [${caps}]` : ''}`;
    });
    const personas = this.store
      .personas()
      .map((p) => `- ${p.handle}: ${p.name} — ${p.description || label(p.provider)?.label || p.provider}`);
    const prov = providers.filter((p) => p.available).map((p) => `- ${p.id}: ${p.label}${p.capabilities.imageGeneration ? ' (can generate images)' : ''}`);
    return text(
      [
        `You are @${caller.handle}.`,
        `Agents in this project:\n${lines.join('\n') || '(none yet)'}`,
        `Personas you can start as a helper (pass the handle as "to"):\n${personas.join('\n')}`,
        `Providers you can start as a helper:\n${prov.join('\n')}`,
      ].join('\n\n'),
    );
  }

  async ask(caller: Thread, args: { to: string; message: string; files?: string[]; save_to?: string; new_helper?: boolean; timeout_minutes?: number }): Promise<ToolResult> {
    const ctx = this.threads.activeContext(caller.id);
    const max = this.store.settings().maxAgentDepth;
    if (ctx.hops + 1 > max) return text(`Refused: this request is already ${ctx.hops} hops deep (limit ${max}). Answer with what you have.`, true);
    const { thread: target, spawned } = await this.resolveTarget(caller, args.to, !!args.new_helper);
    if (this.wouldDeadlock(caller.id, target.id))
      return text(`Refused: @${target.handle} is waiting on you (directly or through other agents). Reply to it instead of asking it.`, true);
    const files = await this.collectFiles(caller, args.files);
    const requestId = newId('r');
    this.threads.append(caller.id, {
      type: 'agent.outbound',
      requestId,
      toThreadId: target.id,
      toHandle: target.handle,
      text: args.message,
      mode: 'ask',
      spawned,
    });
    const set = this.waitsFor.get(caller.id) ?? new Set();
    set.add(target.id);
    this.waitsFor.set(caller.id, set);
    const timeoutMs = Math.min(Math.max(args.timeout_minutes ?? 30, 1), 120) * 60_000;
    let timer: NodeJS.Timeout | undefined;
    let result: TurnResult;
    try {
      result = await Promise.race([
        this.threads.deliverAgentMessage(target.id, {
          text: args.message,
          attachments: files,
          origin: { kind: 'agent', threadId: caller.id, handle: caller.handle, requestId, mode: 'ask' },
          ctx: { hops: ctx.hops + 1, requestId },
        }),
        new Promise<TurnResult>((resolve) => {
          timer = setTimeout(() => resolve({ status: 'failed', text: '', attachments: [], error: 'timed out' }), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      set.delete(target.id);
      if (!set.size) this.waitsFor.delete(caller.id);
      this.threads.cancelRequest(requestId);
    }
    const ok = result.status === 'completed';
    const saved: string[] = [];
    if (args.save_to && result.attachments.length) {
      const dir = path.resolve(caller.cwd, args.save_to);
      const inside = dir === caller.cwd || dir.startsWith(caller.cwd + path.sep);
      if (inside) {
        fs.mkdirSync(dir, { recursive: true });
        for (const a of result.attachments) {
          const dest = path.join(dir, a.name);
          fs.copyFileSync(a.path, dest);
          saved.push(path.relative(caller.cwd, dest));
        }
      }
    }
    this.threads.append(caller.id, {
      type: 'agent.reply',
      requestId,
      fromThreadId: target.id,
      fromHandle: target.handle,
      text: result.text || result.error || '',
      attachments: result.attachments,
      ok,
    });
    const content: any[] = [
      {
        type: 'text',
        text: ok
          ? `@${target.handle} replied:\n\n${result.text || '(no text)'}`
          : `@${target.handle} did not finish (${result.status}${result.error ? ': ' + result.error : ''}).${result.text ? '\n\nPartial answer:\n' + result.text : ''}`,
      },
    ];
    if (result.attachments.length) {
      content.push({
        type: 'text',
        text:
          `Files from @${target.handle}:\n` +
          result.attachments.map((a, i) => `- ${a.name} (${a.mime}, ${a.size} bytes): ${saved[i] ? saved[i] + ' (copied into your folder)' : a.path}`).join('\n') +
          (saved.length ? '' : '\nPass save_to (a folder relative to your working directory) to have files copied into your project.'),
      });
      for (const a of result.attachments) {
        if (/^image\/(png|jpeg|gif|webp)$/.test(a.mime) && a.size < 4_500_000) {
          content.push({ type: 'image', data: fs.readFileSync(a.path).toString('base64'), mimeType: a.mime });
        }
      }
    }
    return { content, isError: !ok };
  }

  async send(caller: Thread, args: { to: string; message: string; files?: string[]; new_helper?: boolean; expect_reply?: boolean }): Promise<ToolResult> {
    const ctx = this.threads.activeContext(caller.id);
    const max = this.store.settings().maxAgentDepth;
    if (ctx.hops + 1 > max) return text(`Refused: this conversation between agents is ${ctx.hops} hops deep (limit ${max}).`, true);
    const { thread: target, spawned } = await this.resolveTarget(caller, args.to, !!args.new_helper);
    if (target.id === caller.id) return text('You cannot message yourself.', true);
    const files = await this.collectFiles(caller, args.files);
    const requestId = newId('r');
    this.threads.append(caller.id, {
      type: 'agent.outbound',
      requestId,
      toThreadId: target.id,
      toHandle: target.handle,
      text: args.message,
      mode: 'send',
      spawned,
    });
    const expectReply = args.expect_reply !== false;
    void this.threads
      .deliverAgentMessage(target.id, {
        text: args.message + (expectReply ? '' : '\n\n(No reply needed.)'),
        attachments: files,
        origin: { kind: 'agent', threadId: caller.id, handle: caller.handle, requestId, mode: 'send' },
        ctx: { hops: ctx.hops + 1, requestId },
      })
      .then((result) => {
        if (!expectReply || !this.store.thread(caller.id)) return;
        this.threads.append(caller.id, {
          type: 'agent.reply',
          requestId,
          fromThreadId: target.id,
          fromHandle: target.handle,
          text: result.text || result.error || '',
          attachments: result.attachments,
          ok: result.status === 'completed',
        });
        // The reply lands as a new turn for the caller, one hop deeper.
        if (ctx.hops + 2 <= max)
          void this.threads.deliverAgentMessage(caller.id, {
            text: result.text || `(no text; status ${result.status})`,
            attachments: result.attachments,
            origin: { kind: 'reply', threadId: target.id, handle: target.handle, requestId },
            ctx: { hops: ctx.hops + 2, requestId: null },
          });
      });
    return text(`Sent to @${target.handle}${spawned ? ' (started a new helper)' : ''}.${expectReply ? ' Its reply will arrive as a new message in this thread; you do not need to wait.' : ''}`);
  }

  async shareFile(caller: Thread, args: { path: string; caption?: string }): Promise<ToolResult> {
    const [att] = await this.collectFiles(caller, [args.path]);
    this.threads.addTurnAttachment(caller.id, att);
    if (args.caption) this.threads.append(caller.id, { type: 'notice', text: args.caption });
    return text(`Shared ${att.name}. It is shown to the user and included in your reply to any agent waiting on you.`);
  }

  memoryList(caller: Thread, query?: string): ToolResult {
    const all = this.store.memory(caller.projectId);
    const q = query?.toLowerCase();
    const hits = q ? all.filter((m) => m.key.toLowerCase().includes(q) || m.content.toLowerCase().includes(q)) : all;
    if (!hits.length) return text(q ? `No memory matches "${query}".` : 'Project memory is empty.');
    return text(hits.map((m) => `- ${m.key} (by ${m.updatedBy}): ${m.content.length > 160 ? m.content.slice(0, 160) + '…' : m.content}`).join('\n'));
  }

  memoryRead(caller: Thread, key: string): ToolResult {
    const m = this.store.memory(caller.projectId).find((x) => x.key === key);
    return m ? text(m.content) : text(`No memory called "${key}".`, true);
  }

  memoryWrite(caller: Thread, key: string, content: string): ToolResult {
    this.store.putMemory({ projectId: caller.projectId, key: key.trim(), content, updatedAt: Date.now(), updatedBy: '@' + caller.handle });
    return text(`Saved "${key}".`);
  }

  memoryDelete(caller: Thread, key: string): ToolResult {
    this.store.deleteMemory(caller.projectId, key);
    return text(`Deleted "${key}".`);
  }

  // ---------- MCP server
  private buildServer(caller: Thread): McpServer {
    const s = new McpServer(
      { name: 'jogger', version: '0.1.0' },
      { instructions: `Jogger agent-to-agent tools. You are @${caller.handle}.` },
    );
    const safe =
      <A,>(fn: (a: A) => Promise<ToolResult> | ToolResult) =>
      async (a: A) => {
        try {
          return await fn(a);
        } catch (err) {
          return text((err as Error).message, true);
        }
      };
    const me = () => this.threads.thread(caller.id);
    s.registerTool(
      'list_agents',
      { description: 'List the other agents (threads) in this project, the personas and providers you can start as helpers, and what each can do.', inputSchema: {} },
      safe(() => this.listAgents(me())),
    );
    s.registerTool(
      'ask_agent',
      {
        description:
          'Ask another agent to do something and wait for its answer. Returns its final message plus any files it produced (images are included inline). "to" is an agent handle like "codex" or "artist", a persona handle, or a provider id to start a helper.',
        inputSchema: {
          to: z.string().describe('Agent handle (e.g. "codex"), persona handle (e.g. "artist"), or provider id'),
          message: z.string().describe('What you need. Be specific; the other agent has none of your context.'),
          files: z.array(z.string()).optional().describe('Paths (relative to your working directory) to send along'),
          save_to: z.string().optional().describe('Folder, relative to your working directory, to copy returned files into'),
          new_helper: z.boolean().optional().describe('Always start a fresh helper instead of messaging an existing thread'),
          timeout_minutes: z.number().optional().describe('Give up after this many minutes (default 30, max 120)'),
        },
      },
      safe((a) => this.ask(me(), a)),
    );
    s.registerTool(
      'send_message',
      {
        description: 'Send a message to another agent without waiting. Its reply (if any) arrives later as a new message in your thread.',
        inputSchema: {
          to: z.string(),
          message: z.string(),
          files: z.array(z.string()).optional(),
          new_helper: z.boolean().optional(),
          expect_reply: z.boolean().optional().describe('Default true. Set false for notifications that need no answer.'),
        },
      },
      safe((a) => this.send(me(), a)),
    );
    s.registerTool(
      'share_file',
      {
        description: 'Attach a file from your working directory to this conversation so the user sees it and any agent waiting on you receives it.',
        inputSchema: { path: z.string(), caption: z.string().optional() },
      },
      safe((a) => this.shareFile(me(), a)),
    );
    s.registerTool(
      'memory_list',
      { description: 'List project memory shared by all agents, optionally filtered by a search term.', inputSchema: { query: z.string().optional() } },
      safe((a) => this.memoryList(me(), a.query)),
    );
    s.registerTool('memory_read', { description: 'Read one project memory entry in full.', inputSchema: { key: z.string() } }, safe((a) => this.memoryRead(me(), a.key)));
    s.registerTool(
      'memory_write',
      {
        description: 'Create or replace a project memory entry. Use short kebab-case keys like "test-command" or "auth-design".',
        inputSchema: { key: z.string(), content: z.string() },
      },
      safe((a) => this.memoryWrite(me(), a.key, a.content)),
    );
    s.registerTool('memory_delete', { description: 'Delete a project memory entry.', inputSchema: { key: z.string() } }, safe((a) => this.memoryDelete(me(), a.key)));
    return s;
  }

  /** Handle POST/GET/DELETE /mcp. Stateless: a fresh server per request, identity from the bearer token. */
  async handleHttp(req: http.IncomingMessage, res: http.ServerResponse, body: unknown) {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const caller = token ? this.threads.threadForToken(token) : null;
    if (!caller) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown agent token' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = this.buildServer(caller);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
