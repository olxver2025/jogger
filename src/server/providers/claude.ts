import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query, type Query, type SDKMessage, type SDKUserMessage, type PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalMode, ToolKind } from '../../shared/protocol.js';
import type { AgentSession, ProviderAdapter, SessionOptions, UserInput } from './types.js';
import { truncate } from './types.js';
import { which } from '../util.js';

const run = promisify(execFile);

const MODE_MAP: Record<ApprovalMode, PermissionMode> = {
  ask: 'default',
  auto: 'acceptEdits',
  full: 'bypassPermissions',
};

export function claudeToolKind(name: string): ToolKind {
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') return 'command';
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') return 'file';
  if (name === 'Read') return 'read';
  if (name === 'Grep' || name === 'Glob' || name === 'ToolSearch') return 'search';
  if (name === 'WebFetch' || name === 'WebSearch') return 'web';
  if (name.startsWith('mcp__jogger__')) return 'agent';
  if (name.startsWith('mcp__')) return 'mcp';
  if (name === 'Task' || name === 'Agent') return 'agent';
  return 'other';
}

export function claudeToolTitle(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (name) {
    case 'Bash':
      return s('command');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return s('file_path');
    case 'Grep':
      return `grep ${s('pattern')}${s('path') ? ' in ' + s('path') : ''}`;
    case 'Glob':
      return s('pattern');
    case 'WebFetch':
      return s('url');
    case 'WebSearch':
      return s('query');
    case 'Task':
    case 'Agent':
      return s('description') || s('prompt').slice(0, 80);
    default:
      if (name.startsWith('mcp__jogger__')) {
        const tool = name.slice('mcp__jogger__'.length);
        return `${tool}${s('to') ? ' → ' + s('to') : ''}`;
      }
      return name;
  }
}

function describeInput(input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string' && typeof input.new_string === 'string')
    return `${input.file_path}\n--- replace\n${truncate(String(input.old_string ?? ''), 1500)}\n+++ with\n${truncate(input.new_string, 1500)}`;
  if (typeof input.file_path === 'string' && typeof input.content === 'string')
    return `${input.file_path}\n${truncate(input.content, 3000)}`;
  return truncate(JSON.stringify(input, null, 2), 3000) ?? '';
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : c?.type === 'tool_reference' ? `loaded ${c.tool_name}` : ''))
      .filter(Boolean)
      .join('\n');
  return '';
}

class ClaudeSession implements AgentSession {
  private q: Query | null = null;
  private pushMsg: ((m: SDKUserMessage) => void) | null = null;
  private backlog: SDKUserMessage[] = [];
  private closed = false;
  private turnId: string | null = null;
  private turnStarted = 0;
  private interrupted = false;
  private turnCounter = 0;
  private sessionId: string | null;
  private streamMsgId: string | null = null;
  private streamBlockKinds = new Map<number, 'text' | 'reasoning'>();

  constructor(private opts: SessionOptions, private bin: string | undefined) {
    this.sessionId = opts.resumeId;
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.backlog.shift() ?? (await new Promise<SDKUserMessage>((r) => (this.pushMsg = r)));
      this.pushMsg = null;
      yield next;
    }
  }

  private start() {
    const o = this.opts;
    this.q = query({
      prompt: this.input(),
      options: {
        cwd: o.cwd,
        model: o.model || undefined,
        env: o.env,
        pathToClaudeCodeExecutable: this.bin,
        permissionMode: MODE_MAP[o.mode],
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        resume: o.resumeId ?? undefined,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: o.instructions },
        mcpServers: {
          jogger: {
            type: 'http',
            url: o.mcp.url,
            headers: { Authorization: `Bearer ${o.mcp.token}` },
            timeout: 3_600_000,
            alwaysLoad: true,
          },
        },
        canUseTool: async (toolName, input, ctx) => {
          if (toolName.startsWith('mcp__jogger__')) return { behavior: 'allow', updatedInput: input };
          const decision = await o.requestApproval({
            title: (ctx as any).title ?? `${toolName}: ${claudeToolTitle(toolName, input)}`,
            detail: describeInput(input),
            toolName,
            canAllowSession: !!ctx.suggestions?.length,
          });
          if (decision === 'deny') return { behavior: 'deny', message: 'The user denied this tool call.' };
          return {
            behavior: 'allow',
            updatedInput: input,
            updatedPermissions: decision === 'allow_session' ? ctx.suggestions : undefined,
          };
        },
      },
    });
    void this.pump(this.q);
  }

  private async pump(q: Query) {
    try {
      for await (const m of q) this.handle(m);
      if (!this.closed) this.opts.emit({ type: 'closed', error: 'Claude process ended' });
    } catch (err) {
      if (this.closed) return;
      const message = err instanceof Error ? err.message : String(err);
      if (this.turnId) this.opts.emit({ type: 'turn.completed', turnId: this.turnId, status: 'failed', error: message });
      this.turnId = null;
      this.opts.emit({ type: 'closed', error: message });
    }
  }

  private handle(m: SDKMessage) {
    const emit = this.opts.emit;
    const anyM = m as any;
    // Messages from Claude's own subagents: show tool calls only, keep text out of the main transcript.
    const nested = anyM.parent_tool_use_id != null;
    switch (m.type) {
      case 'system':
        if (anyM.subtype === 'init' && anyM.session_id && anyM.session_id !== this.sessionId) {
          this.sessionId = anyM.session_id;
          emit({ type: 'session', providerSessionId: anyM.session_id });
        }
        return;
      case 'stream_event': {
        if (nested) return;
        const ev = anyM.event;
        if (ev?.type === 'message_start') {
          this.streamMsgId = ev.message?.id ?? null;
          this.streamBlockKinds.clear();
        } else if (ev?.type === 'content_block_start') {
          const t = ev.content_block?.type;
          if (t === 'text') this.streamBlockKinds.set(ev.index, 'text');
          else if (t === 'thinking') this.streamBlockKinds.set(ev.index, 'reasoning');
        } else if (ev?.type === 'content_block_delta' && this.streamMsgId) {
          const kind = this.streamBlockKinds.get(ev.index);
          const text = ev.delta?.type === 'text_delta' ? ev.delta.text : ev.delta?.type === 'thinking_delta' ? ev.delta.thinking : null;
          if (kind && text) emit({ type: 'delta', itemId: `${this.streamMsgId}:${ev.index}`, kind, text });
        }
        return;
      }
      case 'assistant': {
        const msg = anyM.message;
        const blocks: any[] = msg?.content ?? [];
        // With partial messages on, each content block arrives as its own assistant message
        // sharing the message id; find the block's index from the stream.
        blocks.forEach((b, i) => {
          const index = this.blockIndex(msg.id, b, i);
          const itemId = `${msg.id}:${index}`;
          if (b.type === 'text' && !nested) emit({ type: 'assistant.message', itemId, text: b.text });
          else if (b.type === 'thinking' && b.thinking && !nested) emit({ type: 'reasoning', itemId, text: b.thinking });
          else if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
            const input = (b.input ?? {}) as Record<string, unknown>;
            emit({
              type: 'tool',
              itemId: b.id,
              kind: claudeToolKind(b.name),
              name: b.name,
              title: claudeToolTitle(b.name, input),
              input,
              status: 'running',
            });
          }
        });
        return;
      }
      case 'user': {
        const content = anyM.message?.content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          if (b?.type !== 'tool_result') continue;
          const text = toolResultText(b.content);
          const denied = b.is_error && /denied|rejected/i.test(text);
          emit({
            type: 'tool',
            itemId: b.tool_use_id,
            kind: 'other',
            name: '',
            title: '',
            output: truncate(text),
            status: denied ? 'denied' : b.is_error ? 'failed' : 'done',
          });
        }
        return;
      }
      case 'result': {
        const r = anyM;
        const u = r.usage ?? {};
        emit({
          type: 'usage',
          inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          costUsd: r.total_cost_usd ?? 0,
        });
        const turnId = this.turnId ?? `t${this.turnCounter}`;
        const status = this.interrupted ? 'interrupted' : r.is_error || r.subtype !== 'success' ? 'failed' : 'completed';
        emit({
          type: 'turn.completed',
          turnId,
          status,
          error: status === 'failed' ? (r.errors?.join('\n') || r.result || r.subtype) : undefined,
          durationMs: r.duration_ms ?? Date.now() - this.turnStarted,
        });
        this.turnId = null;
        this.interrupted = false;
        this.seenBlocks.clear();
        return;
      }
      default:
        return;
    }
  }

  private seenBlocks = new Map<string, number>();
  /** Blocks of one API message arrive in order, often one per SDK message; count them so ids match the stream's block index. */
  private blockIndex(msgId: string, _b: unknown, _i: number): number {
    const n = this.seenBlocks.get(msgId) ?? 0;
    this.seenBlocks.set(msgId, n + 1);
    return n;
  }

  async send(input: UserInput) {
    if (!this.q) this.start();
    this.turnCounter++;
    this.turnId = `t${Date.now().toString(36)}${this.turnCounter}`;
    this.turnStarted = Date.now();
    this.interrupted = false;
    this.opts.emit({ type: 'turn.started', turnId: this.turnId });
    const content: any[] = [];
    for (const img of input.images) {
      const ext = path.extname(img).slice(1).toLowerCase();
      const media = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
      content.push({ type: 'image', source: { type: 'base64', media_type: media, data: fs.readFileSync(img).toString('base64') } });
    }
    content.push({ type: 'text', text: input.text });
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    } as SDKUserMessage;
    if (this.pushMsg) this.pushMsg(msg);
    else this.backlog.push(msg);
  }

  async interrupt() {
    if (!this.q || !this.turnId) return;
    this.interrupted = true;
    await this.q.interrupt().catch(() => {});
  }

  async setMode(mode: ApprovalMode) {
    this.opts.mode = mode;
    if (this.q) await this.q.setPermissionMode(MODE_MAP[mode]).catch(() => {});
  }

  async setModel(model: string) {
    this.opts.model = model;
    if (this.q) await this.q.setModel(model || undefined).catch(() => {});
  }

  async close() {
    this.closed = true;
    try {
      this.q?.close();
    } catch {
      /* already gone */
    }
  }
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = 'claude';
  readonly label = 'Claude Code';
  readonly defaultModel = 'opus';
  readonly capabilities = { imageInput: true, imageGeneration: false, webSearch: true, resume: true };
  private bin: string | undefined;

  constructor() {
    this.bin = process.env.JOGGER_CLAUDE_BIN ?? which('claude') ?? undefined;
  }

  models() {
    return [
      { id: 'fable', label: 'Fable' },
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' },
    ];
  }

  async check() {
    if (!this.bin) return { ok: false, version: null, error: 'claude CLI not found on PATH. Install Claude Code and run `claude` once to log in.' };
    try {
      const { stdout } = await run(this.bin, ['--version'], { timeout: 15000 });
      return { ok: true, version: stdout.trim().split(/\s+/)[0] ?? null, error: null };
    } catch (err) {
      return { ok: false, version: null, error: (err as Error).message };
    }
  }

  createSession(opts: SessionOptions): AgentSession {
    return new ClaudeSession(opts, this.bin);
  }
}
