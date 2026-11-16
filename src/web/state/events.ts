import type { ThreadEvent } from '../../shared/protocol';
import { api } from './api';
import { createStore, useStore } from './store';

export interface ThreadLog {
  status: 'loading' | 'ready' | 'error';
  list: ThreadEvent[];
  lastSeq: number;
  error: string | null;
}

export interface Delta {
  kind: 'text' | 'reasoning';
  text: string;
}

/** Event logs for threads that have been opened in a pane (cached for the session). */
export const eventsStore = createStore<Record<string, ThreadLog>>({});
/** Live streaming text per thread, per itemId. Never stored server-side. */
export const deltasStore = createStore<Record<string, Record<string, Delta>>>({});

export const useThreadLog = (threadId: string): ThreadLog | undefined => useStore(eventsStore, (s) => s[threadId]);
export const useDeltas = (threadId: string): Record<string, Delta> | undefined => useStore(deltasStore, (s) => s[threadId]);

function mergeBySeq(a: ThreadEvent[], b: ThreadEvent[]): ThreadEvent[] {
  if (!b.length) return a;
  if (!a.length) return b;
  const seen = new Map<number, ThreadEvent>();
  for (const e of a) seen.set(e.seq, e);
  for (const e of b) seen.set(e.seq, e);
  return [...seen.values()].sort((x, y) => x.seq - y.seq);
}

const inflight = new Map<string, Promise<void>>();

/** Load (or top up) a thread's events. Safe to call repeatedly. */
export function loadThread(threadId: string, force = false): Promise<void> {
  const cur = eventsStore.get()[threadId];
  if (cur && cur.status === 'ready' && !force) return Promise.resolve();
  const running = inflight.get(threadId);
  if (running) return running;
  if (!cur) {
    eventsStore.set((s) => ({ ...s, [threadId]: { status: 'loading', list: [], lastSeq: 0, error: null } }));
  }
  // After a reconnect, only fetch what we missed. A first load fetches everything, then merges
  // with any WS events that raced the request.
  const after = cur?.status === 'ready' ? cur.lastSeq : 0;
  const p = api
    .events(threadId, after)
    .then((fetched) => {
      eventsStore.set((s) => {
        const prev = s[threadId] ?? { status: 'loading', list: [], lastSeq: 0, error: null };
        const list = mergeBySeq(prev.list, fetched);
        return { ...s, [threadId]: { status: 'ready', list, lastSeq: list.length ? list[list.length - 1].seq : 0, error: null } };
      });
    })
    .catch((err: Error) => {
      eventsStore.set((s) => {
        const prev = s[threadId];
        if (prev?.status === 'ready') return s;
        return { ...s, [threadId]: { status: 'error', list: prev?.list ?? [], lastSeq: prev?.lastSeq ?? 0, error: err.message } };
      });
    })
    .finally(() => inflight.delete(threadId));
  inflight.set(threadId, p);
  return p;
}

/** Top up every cached thread after a reconnect. */
export function refetchLoaded() {
  for (const id of Object.keys(eventsStore.get())) void loadThread(id, true);
}

export function forgetThread(threadId: string) {
  eventsStore.set((s) => {
    if (!(threadId in s)) return s;
    const next = { ...s };
    delete next[threadId];
    return next;
  });
  clearDeltas(threadId);
}

// ---- live deltas, flushed once per animation frame

const pending = new Map<string, Map<string, Delta>>();
/** itemIds that already have a stored message this turn; late deltas for them are ignored. */
const settled = new Map<string, Set<string>>();
let frame = 0;

function flush() {
  frame = 0;
  if (!pending.size) return;
  const batch = new Map(pending);
  pending.clear();
  deltasStore.set((s) => {
    const next = { ...s };
    for (const [threadId, items] of batch) {
      const cur = { ...(next[threadId] ?? {}) };
      for (const [itemId, d] of items) {
        const prev = cur[itemId];
        cur[itemId] = { kind: d.kind, text: (prev?.text ?? '') + d.text };
      }
      next[threadId] = cur;
    }
    return next;
  });
}

export function pushDelta(threadId: string, itemId: string, kind: Delta['kind'], text: string) {
  if (settled.get(threadId)?.has(itemId)) return;
  let items = pending.get(threadId);
  if (!items) pending.set(threadId, (items = new Map()));
  const prev = items.get(itemId);
  items.set(itemId, { kind, text: (prev?.text ?? '') + text });
  if (!frame) frame = requestAnimationFrame(flush);
}

function dropDelta(threadId: string, itemId: string) {
  let s = settled.get(threadId);
  if (!s) settled.set(threadId, (s = new Set()));
  s.add(itemId);
  pending.get(threadId)?.delete(itemId);
  deltasStore.set((all) => {
    const cur = all[threadId];
    if (!cur || !(itemId in cur)) return all;
    const next = { ...cur };
    delete next[itemId];
    return { ...all, [threadId]: next };
  });
}

export function clearDeltas(threadId: string) {
  pending.delete(threadId);
  settled.delete(threadId);
  deltasStore.set((all) => {
    if (!all[threadId]) return all;
    const next = { ...all };
    delete next[threadId];
    return next;
  });
}

/** Apply one live event from the WebSocket. */
export function ingestEvent(ev: ThreadEvent) {
  if (ev.type === 'assistant.message' || ev.type === 'reasoning') dropDelta(ev.threadId, ev.itemId);
  else if (ev.type === 'turn.completed' || ev.type === 'user.message') clearDeltas(ev.threadId);

  eventsStore.set((s) => {
    const log = s[ev.threadId];
    if (!log) return s; // not open anywhere; it will be fetched when opened
    if (ev.seq <= log.lastSeq && log.list.some((e) => e.seq === ev.seq)) return s;
    const list = ev.seq > log.lastSeq ? [...log.list, ev] : mergeBySeq(log.list, [ev]);
    return { ...s, [ev.threadId]: { ...log, list, lastSeq: Math.max(log.lastSeq, ev.seq) } };
  });
}
