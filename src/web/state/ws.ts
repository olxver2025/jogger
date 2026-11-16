import type { ServerMessage } from '../../shared/protocol';
import { ApiError, api } from './api';
import { appStore, applyServerMessage, setAppState } from './app';
import { clearDeltas, forgetThread, ingestEvent, pushDelta, refetchLoaded } from './events';
import { dropMissingThreadPanes, onThreadRemoved } from './ui';

let socket: WebSocket | null = null;
let attempts = 0;
let timer = 0;
let everOpened = false;
let reconnecting = false;

function setConn(conn: 'connecting' | 'open' | 'closed', retryAt: number | null = null) {
  appStore.set((a) => (a.conn === conn && a.retryAt === retryAt ? a : { ...a, conn, retryAt }));
}

function handle(m: ServerMessage) {
  switch (m.type) {
    case 'event':
      ingestEvent(m.event);
      return;
    case 'delta':
      pushDelta(m.threadId, m.itemId, m.kind, m.text);
      return;
    case 'thread':
      // Some turns end without a turn.completed event (send failures, crashed sessions).
      if (m.thread.status === 'idle') clearDeltas(m.thread.id);
      applyServerMessage(m);
      return;
    case 'thread.removed':
      applyServerMessage(m);
      forgetThread(m.threadId);
      onThreadRemoved(m.threadId);
      return;
    case 'project.removed': {
      const gone = (appStore.get().state?.threads ?? []).filter((t) => t.projectId === m.projectId).map((t) => t.id);
      applyServerMessage(m);
      for (const id of gone) {
        forgetThread(id);
        onThreadRemoved(id);
      }
      return;
    }
    case 'hello': {
      applyServerMessage(m);
      // Panes restored from localStorage may point at threads deleted while the UI was closed.
      const live = new Set(m.state.threads.map((t) => t.id));
      dropMissingThreadPanes(live);
      if (everOpened) refetchLoaded();
      everOpened = true;
      return;
    }
    default:
      applyServerMessage(m);
  }
}

function open() {
  window.clearTimeout(timer);
  if (socket) {
    const old = socket;
    socket = null; // its onclose sees socket !== ws and does nothing
    old.close();
  }
  setConn('connecting', everOpened ? Date.now() : null);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => {
    attempts = 0;
    setConn('open');
  };
  ws.onmessage = (e) => {
    try {
      handle(JSON.parse(e.data as string) as ServerMessage);
    } catch (err) {
      console.error('[jogger] bad message', err);
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    const delay = Math.min(500 * 2 ** attempts, 10_000);
    attempts++;
    setConn('closed', Date.now() + delay);
    timer = window.setTimeout(() => void reconnect(), delay);
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

async function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  window.clearTimeout(timer);
  setConn('connecting', Date.now()); // keeps the banner up ("Reconnecting…")
  // If the cookie went away, the socket will keep failing; check over HTTP so we can say why.
  try {
    await api.state();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      reconnecting = false;
      appStore.set((a) => ({ ...a, boot: 'unauthorized' }));
      return;
    }
  }
  reconnecting = false;
  open();
}

export function reconnectNow() {
  attempts = 0;
  if (socket || reconnecting) return;
  window.clearTimeout(timer);
  void reconnect();
}

export async function boot() {
  // In dev (Vite on another port) the daemon's /?token= handler isn't in front of the page,
  // so hand the token to /api/auth, which sets the cookie and redirects back.
  const token = new URLSearchParams(location.search).get('token');
  if (token) {
    location.replace(`/api/auth?token=${encodeURIComponent(token)}`);
    return;
  }
  try {
    setAppState(await api.state());
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) appStore.set((a) => ({ ...a, boot: 'unauthorized' }));
    else appStore.set((a) => ({ ...a, boot: 'error', bootError: (err as Error).message }));
    if (!(err instanceof ApiError && err.status === 401)) {
      timer = window.setTimeout(() => void boot(), 3000);
    }
    return;
  }
  open();
}
