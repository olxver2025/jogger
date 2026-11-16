import type { Attachment } from '../../shared/protocol';
import { createStore, useStore } from './store';

export type SettingsSection = 'appearance' | 'keybindings' | 'personas' | 'providers' | 'agents' | 'telegram' | 'memory';

export type PaneView =
  | { kind: 'empty' }
  | { kind: 'thread'; threadId: string }
  | { kind: 'new'; projectId?: string | null }
  | { kind: 'settings'; section?: SettingsSection }
  | { kind: 'schedules'; scheduleId?: string | null };

export interface Pane {
  id: string;
  view: PaneView;
}

export interface UiState {
  panes: Pane[];
  focused: number;
  sidebar: boolean;
  showArchived: boolean;
  collapsed: Record<string, boolean>;
  palette: boolean;
  lightbox: Attachment | null;
  /** Bumped to ask the focused pane's composer to take focus. */
  focusComposer: number;
  addingProject: boolean;
}

export const MAX_PANES = 4;
const KEY = 'jogger.ui.v1';
let paneSeq = 0;
const newPaneId = () => `pane-${Date.now().toString(36)}-${++paneSeq}`;

function load(): UiState {
  const base: UiState = {
    panes: [{ id: newPaneId(), view: { kind: 'empty' } }],
    focused: 0,
    sidebar: true,
    showArchived: false,
    collapsed: {},
    palette: false,
    lightbox: null,
    focusComposer: 0,
    addingProject: false,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<UiState>;
    const panes = Array.isArray(saved.panes)
      ? saved.panes
          .filter((p) => p && typeof p === 'object' && p.view && typeof p.view.kind === 'string')
          .slice(0, MAX_PANES)
          .map((p) => ({ id: newPaneId(), view: p.view }))
      : [];
    return {
      ...base,
      panes: panes.length ? panes : base.panes,
      focused: Math.min(Math.max(Number(saved.focused) || 0, 0), Math.max(panes.length - 1, 0)),
      sidebar: saved.sidebar ?? true,
      showArchived: !!saved.showArchived,
      collapsed: saved.collapsed && typeof saved.collapsed === 'object' ? saved.collapsed : {},
    };
  } catch {
    return base;
  }
}

export const uiStore = createStore<UiState>(load());
export const useUi = <T,>(sel: (s: UiState) => T): T => useStore(uiStore, sel);

let saveTimer = 0;
uiStore.subscribe(() => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const s = uiStore.get();
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ panes: s.panes, focused: s.focused, sidebar: s.sidebar, showArchived: s.showArchived, collapsed: s.collapsed }),
      );
    } catch {
      /* storage unavailable */
    }
  }, 150);
});

const set = (fn: (s: UiState) => UiState) => uiStore.set(fn);

function sameTarget(a: PaneView, b: PaneView) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'thread' && b.kind === 'thread') return a.threadId === b.threadId;
  return a.kind === 'settings' || a.kind === 'schedules';
}

/**
 * Show a view. If a pane already shows it, focus that pane (and update it, e.g. a settings section).
 * With split, add a pane next to the focused one (up to MAX_PANES); otherwise replace the focused pane.
 */
export function openView(view: PaneView, opts: { split?: boolean; pane?: number } = {}) {
  set((s) => {
    const existing = s.panes.findIndex((p) => sameTarget(p.view, view));
    if (existing >= 0 && opts.pane === undefined) {
      const panes = s.panes.slice();
      panes[existing] = { ...panes[existing], view };
      return { ...s, panes, focused: existing };
    }
    if (opts.split && s.panes.length < MAX_PANES) {
      const at = Math.min(s.focused + 1, s.panes.length);
      const panes = s.panes.slice();
      panes.splice(at, 0, { id: newPaneId(), view });
      return { ...s, panes, focused: at };
    }
    const target = opts.pane ?? s.focused;
    const panes = s.panes.slice();
    if (!panes[target]) return s;
    panes[target] = { ...panes[target], view };
    return { ...s, panes, focused: target };
  });
}

export const openThread = (threadId: string, opts: { split?: boolean } = {}) => openView({ kind: 'thread', threadId }, opts);

export function splitPane() {
  set((s) => {
    if (s.panes.length >= MAX_PANES) return s;
    const at = s.focused + 1;
    const panes = s.panes.slice();
    panes.splice(at, 0, { id: newPaneId(), view: { kind: 'empty' } });
    return { ...s, panes, focused: at };
  });
}

export function closePane(index = uiStore.get().focused) {
  set((s) => {
    if (s.panes.length <= 1) {
      if (s.panes[0]?.view.kind === 'empty') return s;
      return { ...s, panes: [{ ...s.panes[0], view: { kind: 'empty' } }], focused: 0 };
    }
    const panes = s.panes.filter((_, i) => i !== index);
    const focused = index < s.focused ? s.focused - 1 : index === s.focused ? Math.min(index, panes.length - 1) : s.focused;
    return { ...s, panes, focused };
  });
}

export function focusPane(index: number) {
  set((s) => (s.focused === index || !s.panes[index] ? s : { ...s, focused: index }));
}

export function cyclePane(dir: 1 | -1) {
  set((s) => (s.panes.length < 2 ? s : { ...s, focused: (s.focused + dir + s.panes.length) % s.panes.length }));
}

export const toggleSidebar = () => set((s) => ({ ...s, sidebar: !s.sidebar }));
export const setPalette = (open: boolean) => set((s) => (s.palette === open ? s : { ...s, palette: open }));
export const setLightbox = (a: Attachment | null) => set((s) => ({ ...s, lightbox: a }));
export const toggleArchived = () => set((s) => ({ ...s, showArchived: !s.showArchived }));
export const toggleCollapsed = (projectId: string) =>
  set((s) => ({ ...s, collapsed: { ...s.collapsed, [projectId]: !s.collapsed[projectId] } }));
/** Show the add-project box in the sidebar (opening the sidebar if needed). */
export const setAddingProject = (on: boolean) => set((s) => ({ ...s, addingProject: on, sidebar: on ? true : s.sidebar }));
export const requestComposerFocus = () => set((s) => ({ ...s, focusComposer: s.focusComposer + 1 }));

export function onThreadRemoved(threadId: string) {
  set((s) => {
    if (!s.panes.some((p) => p.view.kind === 'thread' && p.view.threadId === threadId)) return s;
    return {
      ...s,
      panes: s.panes.map((p) => (p.view.kind === 'thread' && p.view.threadId === threadId ? { ...p, view: { kind: 'empty' } } : p)),
    };
  });
}

/** Close panes whose thread no longer exists (keeping at least one empty pane). */
export function dropMissingThreadPanes(live: Set<string>) {
  set((s) => {
    const keep = s.panes.filter((p) => p.view.kind !== 'thread' || live.has(p.view.threadId));
    if (keep.length === s.panes.length) return s;
    const panes = keep.length ? keep : [{ id: newPaneId(), view: { kind: 'empty' } as PaneView }];
    return { ...s, panes, focused: Math.min(s.focused, panes.length - 1) };
  });
}

export function focusedView(): PaneView | undefined {
  const s = uiStore.get();
  return s.panes[s.focused]?.view;
}
