import type { ThreadEvent } from '../../shared/protocol';

export type Ev<T extends ThreadEvent['type']> = Extract<ThreadEvent, { type: T }>;
/** `ended` marks a tool still "running" when its turn finished (the provider never sent a final update). */
export type ToolEv = Ev<'tool'> & { ended?: boolean };

const endedCache = new WeakMap<ToolEv, ToolEv>();
function ended(ev: ToolEv): ToolEv {
  let e = endedCache.get(ev);
  if (!e) endedCache.set(ev, (e = { ...ev, ended: true }));
  return e;
}

export type Item =
  | { kind: 'event'; key: string; ev: ThreadEvent }
  | { kind: 'tools'; key: string; evs: ToolEv[] };

export interface Timeline {
  items: Item[];
  /** approval.resolved by requestId */
  resolved: Map<string, Ev<'approval.resolved'>>;
  /** agent.reply by requestId (pairs with agent.outbound) */
  replies: Map<string, Ev<'agent.reply'>>;
  /** itemIds that already have a stored assistant/reasoning message in the current (last) turn */
  settledItemIds: Set<string>;
}

const HIDDEN = new Set(['turn.started', 'usage', 'approval.resolved']);
const AGENT_TOOL = /(^|__|\.)(ask_agent|send_message)$/;
const GROUPABLE = new Set(['read', 'search']);

/**
 * Turn the raw event log into renderable rows.
 * - tool / assistant.message / reasoning events repeat with the same itemId as they progress;
 *   the last one wins, kept at the first one's position. ItemIds are only unique within a turn,
 *   so the map resets at each user.message / turn.started.
 * - Successful ask_agent / send_message tool rows are hidden: the agent.outbound / agent.reply cards say it better.
 * - Runs of 2+ consecutive read/search tools collapse into one group row.
 */
export function deriveTimeline(events: ThreadEvent[]): Timeline {
  const rows: { key: string; ev: ThreadEvent }[] = [];
  const resolved = new Map<string, Ev<'approval.resolved'>>();
  const replies = new Map<string, Ev<'agent.reply'>>();
  let byItem = new Map<string, number>();
  let turn = 0;

  for (const ev of events) {
    switch (ev.type) {
      case 'approval.resolved':
        resolved.set(ev.requestId, ev);
        continue;
      case 'agent.reply':
        replies.set(ev.requestId, ev);
        break;
      case 'user.message':
      case 'turn.started':
        byItem = new Map();
        turn++;
        break;
      case 'turn.completed':
        for (const at of byItem.values()) {
          const r = rows[at].ev;
          if (r.type === 'tool' && r.status === 'running') rows[at] = { key: rows[at].key, ev: ended(r) };
        }
        break;
    }
    if (HIDDEN.has(ev.type)) continue;
    if (ev.type === 'tool' || ev.type === 'assistant.message' || ev.type === 'reasoning') {
      const k = `${ev.type}:${ev.itemId}`;
      const at = byItem.get(k);
      if (at !== undefined) {
        rows[at] = { key: rows[at].key, ev };
        continue;
      }
      byItem.set(k, rows.length);
      rows.push({ key: `${turn}:${k}`, ev });
      continue;
    }
    rows.push({ key: `s${ev.seq}`, ev });
  }

  const settledItemIds = new Set<string>();
  for (const k of byItem.keys()) {
    if (k.startsWith('assistant.message:') || k.startsWith('reasoning:')) settledItemIds.add(k.slice(k.indexOf(':') + 1));
  }

  const items: Item[] = [];
  let group: { key: string; evs: ToolEv[] } | null = null;
  const flush = () => {
    if (!group) return;
    if (group.evs.length === 1) items.push({ kind: 'event', key: group.key, ev: group.evs[0] });
    else items.push({ kind: 'tools', key: group.key, evs: group.evs });
    group = null;
  };
  for (const r of rows) {
    const ev = r.ev;
    if (ev.type === 'tool') {
      if (AGENT_TOOL.test(ev.name) && ev.status !== 'failed' && ev.status !== 'denied') continue;
      if (GROUPABLE.has(ev.kind)) {
        if (!group) group = { key: r.key, evs: [] };
        group.evs.push(ev);
        continue;
      }
    }
    flush();
    items.push({ kind: 'event', key: r.key, ev });
  }
  flush();
  return { items, resolved, replies, settledItemIds };
}

export function summarizeTools(evs: ToolEv[]): string {
  const reads = evs.filter((e) => e.kind === 'read').length;
  const searches = evs.length - reads;
  const parts: string[] = [];
  if (reads) parts.push(`Read ${reads} ${reads === 1 ? 'file' : 'files'}`);
  if (searches) parts.push(`${reads ? 'searched' : 'Searched'} ${searches} ${searches === 1 ? 'time' : 'times'}`);
  return parts.join(', ');
}
