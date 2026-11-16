import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { App } from '../src/server/app.js';
import { createHttpServer } from '../src/server/http.js';
import type { DaemonConfig } from '../src/server/config.js';
import type { Thread, ThreadEvent } from '../src/shared/protocol.js';

let home: string;
let projectDir: string;
let app: App;
let server: http.Server;
let base: string;
let config: DaemonConfig;

function makeConfig(h: string): DaemonConfig {
  fs.mkdirSync(path.join(h, 'attachments'), { recursive: true });
  return {
    home: h,
    dbPath: path.join(h, 'jogger.db'),
    attachmentsDir: path.join(h, 'attachments'),
    worktreesDir: path.join(h, 'worktrees'),
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    webDir: null,
    allowedOrigins: new Set(['http://127.0.0.1:5173']),
  };
}

async function start(cfg: DaemonConfig) {
  const a = new App(cfg, { mock: true });
  const s = createHttpServer(a);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  a.setPort(port);
  await a.start();
  return { a, s, url: `http://127.0.0.1:${port}` };
}

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(base + p, {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error ?? res.statusText), { status: res.status });
  return json as T;
}

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 10000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const events = (id: string) => app.threads.events(id);
const completedTurns = (id: string) => events(id).filter((e) => e.type === 'turn.completed').length;
async function idleAfter(id: string, turns: number) {
  await waitFor(() => completedTurns(id) >= turns && app.threads.thread(id).status === 'idle' && !app.threads.isBusy(id));
}

async function newThread(handle: string, extra: Record<string, unknown> = {}): Promise<Thread> {
  return api<Thread>('POST', '/api/threads', { projectId: app.store.projects()[0].id, provider: 'mock', handle, ...extra });
}

before(async () => {
  process.env.JOGGER_CLAUDE_BIN = '/usr/bin/false';
  process.env.JOGGER_CODEX_BIN = '/usr/bin/false';
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jogger-test-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jogger-proj-'));
  config = makeConfig(home);
  const s = await start(config);
  app = s.a;
  server = s.s;
  base = s.url;
  await api('POST', '/api/projects', { path: projectDir, name: 'demo' });
});

after(async () => {
  await app.shutdown();
  server.close();
});

test('rejects unauthenticated and cross-origin requests', async () => {
  const r1 = await fetch(base + '/api/state');
  assert.equal(r1.status, 401);
  const r2 = await fetch(base + '/api/projects', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', origin: 'http://evil.example', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(r2.status, 403);
  const r3 = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r3.status, 401);
  // DNS-rebinding guard: a foreign Host header is refused even with a valid token.
  const r4 = await new Promise<number>((resolve, reject) => {
    const u = new URL(base);
    http
      .get({ host: u.hostname, port: u.port, path: '/api/state', headers: { authorization: 'Bearer test-token', host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on('error', reject);
  });
  assert.equal(r4, 421);
  const r5 = await fetch(base + '/?token=test-token', { redirect: 'manual' });
  assert.equal(r5.status, 302);
  assert.match(r5.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/);
});

test('runs a turn and records the reply', async () => {
  const t = await newThread('solo');
  await api('POST', `/api/threads/${t.id}/messages`, { text: 'hello there' });
  await idleAfter(t.id, 1);
  const msg = events(t.id).find((e) => e.type === 'assistant.message') as Extract<ThreadEvent, { type: 'assistant.message' }>;
  assert.equal(msg.text, 'Mock reply to: hello there');
  assert.equal(app.threads.thread(t.id).title, 'hello there');
  assert.ok(app.threads.thread(t.id).providerSessionId);
});

test('approval round trip', async () => {
  const t = await newThread('careful');
  await api('POST', `/api/threads/${t.id}/messages`, { text: 'please approve this' });
  const req = await waitFor(() => app.threads.pendingApprovals().find((a) => a.threadId === t.id));
  assert.equal(app.threads.thread(t.id).status, 'waiting');
  await api('POST', `/api/approvals/${req.requestId}`, { decision: 'allow' });
  await idleAfter(t.id, 1);
  const tool = events(t.id).filter((e) => e.type === 'tool').pop() as any;
  assert.equal(tool.status, 'done');
  assert.ok(events(t.id).some((e) => e.type === 'approval.resolved'));
});

test('ask_agent returns another agent\'s image to the caller', async () => {
  const painter = await newThread('painter');
  const asker = await newThread('asker');
  await api('POST', `/api/threads/${asker.id}/messages`, { text: 'ask @painter draw an image of a circle' });
  await idleAfter(asker.id, 1);
  await idleAfter(painter.id, 1);
  const reply = events(asker.id).find((e) => e.type === 'agent.reply') as any;
  assert.ok(reply, 'asker got a reply event');
  assert.equal(reply.fromHandle, 'painter');
  assert.equal(reply.attachments.length, 1);
  assert.equal(reply.attachments[0].mime, 'image/png');
  const inbound = events(painter.id).find((e) => e.type === 'user.message') as any;
  assert.equal(inbound.origin.kind, 'agent');
  assert.equal(inbound.origin.handle, 'asker');
  const final = events(asker.id).filter((e) => e.type === 'assistant.message').pop() as any;
  assert.match(final.text, /@painter answered/);
  // The attachment is downloadable.
  const res = await fetch(base + reply.attachments[0].url, { headers: { authorization: 'Bearer test-token' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
});

test('asking a provider spawns a helper thread with no more autonomy than the caller', async () => {
  const boss = await newThread('boss', { mode: 'ask' });
  await api('POST', `/api/threads/${boss.id}/messages`, { text: 'ask @mock say hi' });
  await idleAfter(boss.id, 1);
  const helper = app.threads.threads().find((t) => t.parentThreadId === boss.id);
  assert.ok(helper);
  assert.equal(helper.kind, 'helper');
  assert.equal(helper.mode, 'ask');
  assert.equal(helper.cwd, boss.cwd);
});

test('refuses a request that would deadlock', async () => {
  const a = await newThread('ping');
  const b = await newThread('pong');
  // b receives "ask @ping ..." while ping is blocked waiting on pong.
  await api('POST', `/api/threads/${a.id}/messages`, { text: 'ask @pong ask @ping are you there' });
  await idleAfter(a.id, 1);
  const tool = events(b.id).find((e) => e.type === 'tool' && (e as any).name === 'ask_agent' && (e as any).status === 'done') as any;
  assert.ok(tool, 'pong attempted the call');
  assert.match(tool.output, /waiting on you/);
});

test('send_message delivers the reply as a new turn for the sender', async () => {
  const a = await newThread('sender');
  const b = await newThread('receiver');
  await api('POST', `/api/threads/${a.id}/messages`, { text: 'send @receiver hello later' });
  await idleAfter(b.id, 1);
  await idleAfter(a.id, 2);
  const msgs = events(a.id).filter((e) => e.type === 'user.message') as any[];
  assert.equal(msgs[1].origin.kind, 'reply');
  assert.equal(msgs[1].origin.handle, 'receiver');
});

test('shared project memory via MCP and REST', async () => {
  const t = await newThread('scribe');
  await api('POST', `/api/threads/${t.id}/messages`, { text: 'memory test-command=npm test' });
  await idleAfter(t.id, 1);
  const mem = await api<any[]>('GET', `/api/projects/${t.projectId}/memory`);
  const e = mem.find((m) => m.key === 'test-command');
  assert.equal(e.content, 'npm test');
  assert.equal(e.updatedBy, '@scribe');
});

test('messages queue while a thread is busy and interrupt stops a turn', async () => {
  const t = await newThread('sleepy');
  await api('POST', `/api/threads/${t.id}/messages`, { text: 'sleep 30' });
  await api('POST', `/api/threads/${t.id}/messages`, { text: 'second' });
  await waitFor(() => app.threads.thread(t.id).queued === 1);
  await waitFor(() => events(t.id).some((e) => e.type === 'turn.started'));
  await api('POST', `/api/threads/${t.id}/interrupt`);
  await idleAfter(t.id, 2);
  const done = events(t.id).filter((e) => e.type === 'turn.completed') as any[];
  assert.equal(done[0].status, 'interrupted');
  assert.equal(done[1].status, 'completed');
});

test('schedules start a thread when run', async () => {
  const projectId = app.store.projects()[0].id;
  const s = await api('PUT', '/api/schedules', { name: 'Morning check', projectId, cron: '0 9 * * *', prompt: 'status report', provider: 'mock', mode: 'ask' });
  assert.ok(s.nextRunAt > Date.now());
  await api('POST', `/api/schedules/${s.id}/run`);
  const st = app.store.schedule(s.id)!;
  assert.ok(st.lastThreadId);
  const t = app.threads.thread(st.lastThreadId!);
  assert.equal(t.kind, 'scheduled');
  await idleAfter(t.id, 1);
  await assert.rejects(api('PUT', '/api/schedules', { name: 'bad', projectId, cron: 'nope', prompt: 'x' }), /not a valid cron/);
});

test('telegram bridge routes messages from allowed chats only', async () => {
  const sent: any[] = [];
  let served = false;
  const tg = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const method = req.url!.split('/').pop();
    const reply = (result: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
    if (method === 'getMe') return reply({ username: 'jogger_test_bot' });
    if (method === 'getUpdates') {
      if (served) return setTimeout(() => reply([]), 200);
      served = true;
      return reply([
        { update_id: 1, message: { chat: { id: 42 }, from: { username: 'me' }, text: '@tele hi from phone' } },
        { update_id: 2, message: { chat: { id: 99 }, from: { username: 'stranger' }, text: 'let me in' } },
      ]);
    }
    if (method === 'sendMessage' || method === 'sendChatAction') {
      sent.push({ method, ...JSON.parse(body) });
      return reply({});
    }
    reply({});
  });
  await new Promise<void>((r) => tg.listen(0, '127.0.0.1', () => r()));
  (app.telegram as any).base = `http://127.0.0.1:${(tg.address() as AddressInfo).port}`;
  const t = await newThread('tele');
  await api('PUT', '/api/settings', { telegram: { enabled: true, botToken: 'abc:123', allowedChatIds: [42] } });
  await idleAfter(t.id, 1);
  const inbound = events(t.id).find((e) => e.type === 'user.message') as any;
  assert.equal(inbound.text, 'hi from phone');
  assert.equal(inbound.origin.kind, 'telegram');
  await waitFor(() => sent.some((m) => m.method === 'sendMessage' && m.chat_id === 42 && /Mock reply/.test(m.text)));
  assert.ok(sent.some((m) => m.chat_id === 99 && /chat id is 99/.test(m.text)));
  const st = await api('GET', '/api/state');
  assert.equal(st.settings.telegram.botToken, '••••:123');
  await app.telegram.stop();
  tg.close();
});

test('a restarted daemon keeps threads and their provider sessions', async () => {
  const t = await newThread('durable');
  await api('POST', `/api/threads/${t.id}/messages`, { text: 'remember me' });
  await idleAfter(t.id, 1);
  const sid = app.threads.thread(t.id).providerSessionId;
  const second = new App(config, { mock: true });
  const again = second.threads.thread(t.id);
  assert.equal(again.providerSessionId, sid);
  assert.equal(again.status, 'idle');
  assert.ok(second.threads.events(t.id).length >= 4);
  await second.shutdown();
});

test('stopping an agent also stops the agent it is waiting on', async () => {
  const boss = await newThread('stopper');
  const worker = await newThread('slowpoke');
  await api('POST', `/api/threads/${boss.id}/messages`, { text: 'ask @slowpoke sleep 30' });
  await waitFor(() => events(worker.id).some((e) => e.type === 'turn.started'));
  const t0 = Date.now();
  await api('POST', `/api/threads/${boss.id}/interrupt`);
  await idleAfter(worker.id, 1);
  await idleAfter(boss.id, 1);
  assert.ok(Date.now() - t0 < 5000, 'both stopped promptly');
  const w = events(worker.id).find((e) => e.type === 'turn.completed') as any;
  assert.equal(w.status, 'interrupted');
});

test('deleting a thread answers whoever is waiting on it', async () => {
  const boss = await newThread('orphaned');
  const worker = await newThread('doomed');
  await api('POST', `/api/threads/${boss.id}/messages`, { text: 'ask @doomed sleep 30' });
  await waitFor(() => events(worker.id).some((e) => e.type === 'turn.started'));
  const t0 = Date.now();
  await api('DELETE', `/api/threads/${worker.id}`);
  await idleAfter(boss.id, 1);
  assert.ok(Date.now() - t0 < 5000);
  const reply = events(boss.id).find((e) => e.type === 'agent.reply') as any;
  assert.equal(reply.ok, false);
});

test('a thread can run in its own git worktree', async () => {
  const { execFileSync } = await import('node:child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'jogger-repo-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q');
  const p = await api('POST', '/api/projects', { path: repo, name: 'repo' });
  // No commits yet: a clear error, no half-made thread.
  await assert.rejects(api('POST', '/api/threads', { projectId: p.id, provider: 'mock', handle: 'wt0', worktree: true }), /no commits yet/);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const t = await api<Thread>('POST', '/api/threads', { projectId: p.id, provider: 'mock', handle: 'wt', worktree: true });
  assert.ok(t.worktree);
  assert.equal(t.cwd, t.worktree!.path);
  assert.ok(t.cwd.startsWith(config.worktreesDir));
  assert.match(t.worktree!.branch, /^jogger\/wt-/);
  assert.ok(fs.existsSync(path.join(t.cwd, 'a.txt')));
  assert.match(git('branch', '--list', t.worktree!.branch).toString(), /jogger\/wt-/);
});
