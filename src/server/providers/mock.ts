import zlib from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ApprovalMode } from '../../shared/protocol.js';
import type { AgentSession, ProviderAdapter, SessionOptions, UserInput } from './types.js';

// A scripted provider for tests and for trying the UI without spending tokens.
// It understands a few commands in the message text:
//   ask @handle <message>    calls Jogger's ask_agent tool and quotes the answer
//   send @handle <message>   calls send_message
//   image                    "generates" a small PNG
//   approve                  asks for approval before a fake command
//   sleep <seconds>          waits (interruptible)
//   memory <key>=<value>     writes project memory

export function tinyPng(r: number, g: number, b: number, size = 64): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const inside = (x - size / 2) ** 2 + (y - size / 2) ** 2 < (size / 2.6) ** 2;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = inside ? r : 250;
      raw[o + 1] = inside ? g : 250;
      raw[o + 2] = inside ? b : 247;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('interrupted'));
    });
  });

class MockSession implements AgentSession {
  private n = 0;
  private abort: AbortController | null = null;
  private client: Client | null = null;

  constructor(private opts: SessionOptions) {
    queueMicrotask(() => opts.emit({ type: 'session', providerSessionId: opts.resumeId ?? `mock-${opts.threadId}` }));
  }

  private async mcp(): Promise<Client> {
    if (this.client) return this.client;
    const c = new Client({ name: 'jogger-mock', version: '0.0.1' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(this.opts.mcp.url), {
        requestInit: { headers: { Authorization: `Bearer ${this.opts.mcp.token}` } },
      }),
    );
    this.client = c;
    return c;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const c = await this.mcp();
    const res: any = await c.callTool({ name, arguments: args }, undefined, { timeout: 3_600_000 });
    return (res.content ?? []).map((x: any) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n');
  }

  async send(input: UserInput) {
    const turnId = `mock-${Date.now().toString(36)}-${++this.n}`;
    const ac = new AbortController();
    this.abort = ac;
    const started = Date.now();
    const emit = this.opts.emit;
    emit({ type: 'turn.started', turnId });
    void (async () => {
      let reply = '';
      try {
        const text = input.text.trim();
        const ask = text.match(/\b(ask|send)\s+@([\w-]+)\s+([\s\S]+)/i);
        if (!ask && /\bsleep\s+(\d+)/i.test(text)) {
          const secs = Number(text.match(/\bsleep\s+(\d+)/i)![1]);
          emit({ type: 'tool', itemId: `${turnId}-sleep`, kind: 'command', name: 'sleep', title: `sleep ${secs}`, status: 'running' });
          await sleep(secs * 1000, ac.signal);
          emit({ type: 'tool', itemId: `${turnId}-sleep`, kind: 'command', name: 'sleep', title: `sleep ${secs}`, status: 'done', exitCode: 0 });
        }
        if (/\bapprove\b/i.test(text)) {
          const d = await this.opts.requestApproval({ title: 'Run a command: touch mock.txt', detail: 'touch mock.txt', toolName: 'shell', canAllowSession: true });
          emit({
            type: 'tool',
            itemId: `${turnId}-cmd`,
            kind: 'command',
            name: 'shell',
            title: 'touch mock.txt',
            status: d === 'deny' ? 'denied' : 'done',
            exitCode: d === 'deny' ? null : 0,
          });
          reply += d === 'deny' ? 'The command was denied. ' : 'Ran the command. ';
        }
        const mem = text.match(/\bmemory\s+([\w.-]+)=(.+)/i);
        if (mem) {
          emit({ type: 'tool', itemId: `${turnId}-mem`, kind: 'agent', name: 'memory_write', title: `memory_write ${mem[1]}`, status: 'running' });
          const out = await this.callTool('memory_write', { key: mem[1], content: mem[2] });
          emit({ type: 'tool', itemId: `${turnId}-mem`, kind: 'agent', name: 'memory_write', title: `memory_write ${mem[1]}`, status: 'done', output: out });
          reply += `Saved memory ${mem[1]}. `;
        }
        if (ask) {
          const tool = ask[1].toLowerCase() === 'ask' ? 'ask_agent' : 'send_message';
          const itemId = `${turnId}-ask`;
          emit({ type: 'tool', itemId, kind: 'agent', name: tool, title: `${tool} → ${ask[2]}`, input: { to: ask[2], message: ask[3] }, status: 'running' });
          const out = await this.callTool(tool, { to: ask[2], message: ask[3] });
          emit({ type: 'tool', itemId, kind: 'agent', name: tool, title: `${tool} → ${ask[2]}`, output: out, status: 'done' });
          reply += tool === 'ask_agent' ? `@${ask[2]} answered: ${out}` : `Sent to @${ask[2]}.`;
        }
        if (/\bimage\b/i.test(text) && !ask) {
          emit({ type: 'tool', itemId: `${turnId}-img`, kind: 'image', name: 'image_generation', title: 'a red circle', status: 'running' });
          await sleep(150, ac.signal);
          const att = await this.opts.saveAttachment({ data: tinyPng(220, 60, 40), name: 'circle.png', mime: 'image/png' });
          emit({ type: 'tool', itemId: `${turnId}-img`, kind: 'image', name: 'image_generation', title: 'a red circle', status: 'done' });
          emit({ type: 'attachment', attachment: att });
          reply += 'Here is a red circle. ';
        }
        if (!reply) reply = `Mock reply to: ${text.slice(0, 400)}`;
        const itemId = `${turnId}-msg`;
        for (const chunk of reply.match(/.{1,12}/gs) ?? []) {
          emit({ type: 'delta', itemId, kind: 'text', text: chunk });
          await sleep(8, ac.signal);
        }
        emit({ type: 'assistant.message', itemId, text: reply.trim(), final: true });
        emit({ type: 'usage', inputTokens: text.length, outputTokens: reply.length, costUsd: 0 });
        emit({ type: 'turn.completed', turnId, status: 'completed', durationMs: Date.now() - started });
      } catch (err) {
        const interrupted = ac.signal.aborted;
        emit({
          type: 'turn.completed',
          turnId,
          status: interrupted ? 'interrupted' : 'failed',
          error: interrupted ? undefined : (err as Error).message,
          durationMs: Date.now() - started,
        });
      } finally {
        if (this.abort === ac) this.abort = null;
      }
    })();
  }

  async interrupt() {
    this.abort?.abort();
  }
  async setMode(mode: ApprovalMode) {
    this.opts.mode = mode;
  }
  async close() {
    this.abort?.abort();
    await this.client?.close().catch(() => {});
  }
}

export class MockAdapter implements ProviderAdapter {
  readonly id = 'mock';
  readonly label = 'Mock (no model)';
  readonly defaultModel = 'mock';
  readonly capabilities = { imageInput: false, imageGeneration: true, webSearch: false, resume: true };
  models() {
    return [{ id: 'mock', label: 'Scripted' }];
  }
  async check() {
    return { ok: true, version: 'built-in', error: null };
  }
  createSession(opts: SessionOptions): AgentSession {
    return new MockSession(opts);
  }
}
