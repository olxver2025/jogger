import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { App } from './app.js';
import type { Persona, Schedule, ServerMessage, Settings } from '../shared/protocol.js';
import { mimeFor } from './util.js';
import { newId } from './config.js';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const MAX_JSON = 2 * 1024 * 1024;
const MAX_UPLOAD = 50 * 1024 * 1024;

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const LOCKED_PAGE = `<!doctype html><meta charset="utf-8"><title>Jogger</title>
<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;max-width:34rem;margin:18vh auto;padding:0 1rem;color:#222;background:#f6f5f2}code{background:#0001;padding:.1em .35em;border-radius:4px}</style>
<h1 style="font-size:1.25rem">Jogger is running</h1>
<p>This page needs the sign-in link that includes your local token. Run <code>npx jogger open</code> (or <code>node bin/jogger.mjs open</code>) in the Jogger folder to get it.</p>`;

export function createHttpServer(app: App) {
  const { config } = app;

  const authed = (req: http.IncomingMessage) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ') && safeEqual(auth.slice(7), config.token)) return true;
    const c = parseCookies(req.headers.cookie).jogger;
    return !!c && safeEqual(c, config.token);
  };

  const hostOk = (req: http.IncomingMessage) => {
    const host = (req.headers.host ?? '').toLowerCase();
    const name = host.replace(/:\d+$/, '');
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
  };

  const originOk = (req: http.IncomingMessage) => {
    const o = req.headers.origin;
    return !o || config.allowedOrigins.has(o);
  };

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req)) throw new HttpError(421, 'Unexpected Host header');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const p = url.pathname;

      if (p === '/mcp') {
        // Agent tool calls. Authenticated per thread by bearer token; never from a browser.
        if (req.headers.origin) throw new HttpError(403, 'Browsers may not call the agent endpoint');
        const raw = req.method === 'POST' ? await readBody(req, MAX_JSON) : Buffer.alloc(0);
        await app.agents.handleHttp(req, res, raw.length ? JSON.parse(raw.toString('utf8')) : undefined);
        return;
      }

      if (p === '/healthz') return send(res, 200, { ok: true, version: app.version });

      if (!p.startsWith('/api/')) {
        const t = url.searchParams.get('token');
        if (t && safeEqual(t, config.token)) {
          res
            .writeHead(302, {
              'set-cookie': `jogger=${encodeURIComponent(config.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
              location: '/',
            })
            .end();
          return;
        }
        if (!authed(req)) {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(LOCKED_PAGE);
          return;
        }
        return serveStatic(config.webDir, p, res);
      }

      if (!authed(req)) throw new HttpError(401, 'Not signed in');
      if (req.method !== 'GET' && !originOk(req)) throw new HttpError(403, 'Cross-origin request refused');
      await api(app, req, res, url, send);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      if (!res.headersSent) send(res, status, { error: (err as Error).message });
      else res.end();
    }
  });
  server.requestTimeout = 0; // long agent tool calls hold requests open
  server.headersTimeout = 60_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname !== '/ws' || !hostOk(req) || !originOk(req) || !authed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws));
  });

  function onSocket(ws: WebSocket) {
    const sendMsg = (m: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    sendMsg({ type: 'hello', state: app.state() });
    const off = app.hub.onMessage(sendMsg);
    const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 25000);
    ws.on('close', () => {
      off();
      clearInterval(ping);
    });
    ws.on('error', () => {});
  }

  return server;
}

function serveStatic(webDir: string | null, p: string, res: http.ServerResponse) {
  if (!webDir) {
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(LOCKED_PAGE.replace(/<p>.*<\/p>/s, '<p>The web UI has not been built. Run <code>npm run build</code>, or use <code>npm run dev</code> during development.</p>'));
    return;
  }
  const rel = decodeURIComponent(p).replace(/^\/+/, '');
  let file = path.resolve(webDir, rel || 'index.html');
  if (!file.startsWith(webDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webDir, 'index.html');
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    'content-type': mimeFor(file) + (/\.(html|css|js)$/.test(file) ? '; charset=utf-8' : ''),
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

async function api(
  app: App,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  send: (res: http.ServerResponse, status: number, body: unknown) => void,
) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const m = req.method ?? 'GET';
  const json = async <T,>(): Promise<T> => {
    const b = await readBody(req, MAX_JSON);
    return (b.length ? JSON.parse(b.toString('utf8')) : {}) as T;
  };
  const ok = (body: unknown = { ok: true }) => send(res, 200, body);
  const [a, b, c, d] = parts;
  const { threads, store } = app;

  if (a === 'state' && m === 'GET') return ok(app.state());

  // ---- projects
  if (a === 'projects') {
    if (!b && m === 'POST') {
      const body = await json<{ path: string; name?: string }>();
      return ok(threads.createProject(body.path, body.name));
    }
    if (b && !c && m === 'DELETE') {
      threads.removeProject(b);
      return ok();
    }
    if (b && c === 'memory') {
      if (!d && m === 'GET') return ok(store.memory(b));
      if (d && m === 'PUT') {
        const body = await json<{ content: string }>();
        store.putMemory({ projectId: b, key: decodeURIComponent(d), content: body.content ?? '', updatedAt: Date.now(), updatedBy: 'you' });
        return ok(store.memory(b));
      }
      if (d && m === 'DELETE') {
        store.deleteMemory(b, decodeURIComponent(d));
        return ok(store.memory(b));
      }
    }
  }

  // ---- threads
  if (a === 'threads') {
    if (!b && m === 'POST') return ok(await threads.createThread(await json()));
    if (b && !c && m === 'PATCH') return ok(await threads.updateThread(b, await json()));
    if (b && !c && m === 'DELETE') {
      await threads.deleteThread(b);
      return ok();
    }
    if (b && c === 'events' && m === 'GET') return ok(threads.events(b, Number(url.searchParams.get('after') ?? 0)));
    if (b && c === 'messages' && m === 'POST') {
      const body = await json<{ text: string; attachmentIds?: string[] }>();
      if (!body.text?.trim() && !body.attachmentIds?.length) throw new HttpError(400, 'Message is empty');
      threads.sendUserMessage(b, body.text ?? '', body.attachmentIds ?? []);
      return ok();
    }
    if (b && c === 'interrupt' && m === 'POST') {
      await threads.interrupt(b);
      return ok();
    }
    if (b && c === 'clear-queue' && m === 'POST') {
      threads.clearQueue(b);
      return ok();
    }
  }

  if (a === 'approvals' && b && m === 'POST') {
    const body = await json<{ decision: 'allow' | 'allow_session' | 'deny' }>();
    if (!['allow', 'allow_session', 'deny'].includes(body.decision)) throw new HttpError(400, 'Bad decision');
    if (!threads.resolveApproval(b, body.decision)) throw new HttpError(404, 'That approval is no longer pending');
    return ok();
  }

  // ---- attachments
  if (a === 'attachments') {
    if (!b && m === 'POST') {
      const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'upload'));
      const data = await readBody(req, MAX_UPLOAD);
      return ok(await threads.saveAttachment({ data, name, mime: String(req.headers['content-type'] ?? '') || undefined }));
    }
    if (b && m === 'GET') {
      const att = store.attachment(b);
      if (!att || !fs.existsSync(att.path)) throw new HttpError(404, 'Not found');
      const inline = /^(image|video|audio)\//.test(att.mime) && att.mime !== 'image/svg+xml';
      res.writeHead(200, {
        'content-type': att.mime,
        'content-length': att.size,
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(att.name)}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'cache-control': 'private, max-age=86400',
      });
      fs.createReadStream(att.path).pipe(res);
      return;
    }
  }

  // ---- settings / personas / schedules / providers
  if (a === 'settings' && m === 'PUT') {
    const patch = await json<Partial<Settings>>();
    app.mergeSettings(patch);
    app.hub.broadcast({ type: 'settings', settings: app.publicSettings() });
    if (patch.telegram) void app.telegram.restart();
    return ok(app.publicSettings());
  }

  if (a === 'personas') {
    if (m === 'PUT') {
      const p = await json<Persona>();
      if (!p.name?.trim()) throw new HttpError(400, 'A persona needs a name');
      if (!app.providers.has(p.provider)) throw new HttpError(400, `Unknown provider ${p.provider}`);
      const persona: Persona = {
        id: p.id || newId('p'),
        name: p.name.trim(),
        handle: (p.handle || p.name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
        provider: p.provider,
        model: p.model ?? '',
        mode: p.mode ?? 'ask',
        systemPrompt: p.systemPrompt ?? '',
        glyph: (p.glyph || p.name[0] || '?').slice(0, 2),
        hue: Number.isFinite(p.hue) ? p.hue : 200,
        description: p.description ?? '',
      };
      store.putPersona(persona);
      app.hub.broadcast({ type: 'personas', personas: store.personas() });
      return ok(persona);
    }
    if (b && m === 'DELETE') {
      store.deletePersona(b);
      app.hub.broadcast({ type: 'personas', personas: store.personas() });
      return ok();
    }
  }

  if (a === 'schedules') {
    if (m === 'PUT') return ok(app.scheduler.upsert(await json<Partial<Schedule>>()));
    if (b && !c && m === 'DELETE') {
      app.scheduler.remove(b);
      return ok();
    }
    if (b && c === 'run' && m === 'POST') {
      await app.scheduler.runNow(b);
      return ok();
    }
  }

  if (a === 'providers' && b === 'refresh' && m === 'POST') {
    const providers = await app.providers.refresh();
    app.hub.broadcast({ type: 'providers', providers });
    return ok(providers);
  }

  if (a === 'telegram' && b === 'test' && m === 'POST') return ok(await app.telegram.test());

  // Folder suggestions for the "add project" box.
  if (a === 'fs' && b === 'dirs' && m === 'GET') {
    const raw = url.searchParams.get('path') || '~/';
    const expanded = raw.replace(/^~(?=$|\/)/, os.homedir());
    const dir = expanded.endsWith('/') ? expanded : path.dirname(expanded);
    const prefix = expanded.endsWith('/') ? '' : path.basename(expanded).toLowerCase();
    let entries: string[] = [];
    try {
      entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name.toLowerCase().startsWith(prefix))
        .map((e) => path.join(dir, e.name))
        .slice(0, 30);
    } catch {
      /* unreadable folder */
    }
    return ok(entries.map((e) => e.replace(os.homedir(), '~')));
  }

  throw new HttpError(404, `No route for ${m} ${url.pathname}`);
}
