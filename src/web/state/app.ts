import type { AppState, PendingApproval, Persona, ProviderInfo, ServerMessage, Thread } from '../../shared/protocol';
import { createStore, useStore } from './store';

export interface AppSlice {
  boot: 'loading' | 'ready' | 'unauthorized' | 'error';
  bootError: string | null;
  conn: 'connecting' | 'open' | 'closed';
  /** ms timestamp of the next reconnect attempt while closed */
  retryAt: number | null;
  state: AppState | null;
}

export const appStore = createStore<AppSlice>({ boot: 'loading', bootError: null, conn: 'connecting', retryAt: null, state: null });

const EMPTY_STATE: AppState = {
  projects: [],
  threads: [],
  personas: [],
  providers: [],
  schedules: [],
  settings: {
    theme: 'system',
    palette: 'graphite',
    accentHue: 52,
    density: 'regular',
    background: 'grid',
    keybindings: {},
    unattendedApprovals: 'queue',
    stripApiKeys: true,
    maxAgentDepth: 4,
    telegram: { enabled: false, botToken: '', allowedChatIds: [], defaultThreadId: null, forwardApprovals: true },
  },
  pendingApprovals: [],
  telegram: { status: 'off', error: null, botName: null },
  version: '',
};

/** Select from AppState. Before boot completes this sees an empty state, never null. */
export function useApp<T>(sel: (s: AppState) => T): T {
  return useStore(appStore, (a) => sel(a.state ?? EMPTY_STATE));
}

export const getApp = (): AppState => appStore.get().state ?? EMPTY_STATE;

function patchState(fn: (s: AppState) => AppState) {
  appStore.set((a) => (a.state ? { ...a, state: fn(a.state) } : a));
}

export function setAppState(state: AppState) {
  appStore.set((a) => ({ ...a, state, boot: 'ready', bootError: null }));
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

/** Apply a non-event server message to AppState. */
export function applyServerMessage(m: ServerMessage) {
  switch (m.type) {
    case 'hello':
      setAppState(m.state);
      return;
    case 'thread':
      patchState((s) => ({ ...s, threads: upsert(s.threads, m.thread) }));
      return;
    case 'thread.removed':
      patchState((s) => ({ ...s, threads: s.threads.filter((t) => t.id !== m.threadId) }));
      return;
    case 'project':
      patchState((s) => ({ ...s, projects: upsert(s.projects, m.project) }));
      return;
    case 'project.removed':
      patchState((s) => ({
        ...s,
        projects: s.projects.filter((p) => p.id !== m.projectId),
        threads: s.threads.filter((t) => t.projectId !== m.projectId),
      }));
      return;
    case 'personas':
      patchState((s) => ({ ...s, personas: m.personas }));
      return;
    case 'schedules':
      patchState((s) => ({ ...s, schedules: m.schedules }));
      return;
    case 'settings':
      patchState((s) => ({ ...s, settings: m.settings }));
      return;
    case 'providers':
      patchState((s) => ({ ...s, providers: m.providers }));
      return;
    case 'approvals':
      patchState((s) => ({ ...s, pendingApprovals: m.pendingApprovals }));
      return;
    case 'telegram':
      patchState((s) => ({ ...s, telegram: m.telegram }));
      return;
  }
}

// ---- small selectors / helpers used across components

export const useThread = (id: string | null | undefined): Thread | undefined =>
  useApp((s) => (id ? s.threads.find((t) => t.id === id) : undefined));

export const usePersona = (id: string | null | undefined): Persona | undefined =>
  useApp((s) => (id ? s.personas.find((p) => p.id === id) : undefined));

export const useProvider = (id: string | null | undefined): ProviderInfo | undefined =>
  useApp((s) => (id ? s.providers.find((p) => p.id === id) : undefined));

export const usePending = (): PendingApproval[] => useApp((s) => s.pendingApprovals);

export const isBusy = (t: Pick<Thread, 'status'>) => t.status === 'running' || t.status === 'starting' || t.status === 'waiting';

export const threadTitle = (t: Pick<Thread, 'title' | 'handle'>) => t.title.trim() || 'Untitled thread';
