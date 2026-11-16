import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftRight,
  CalendarClock,
  Columns2,
  FolderPlus,
  Monitor,
  Moon,
  PanelLeft,
  Settings,
  ShieldAlert,
  SquarePen,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react';
import { DEFAULT_KEYBINDINGS } from '../../shared/protocol';
import { api, attempt } from '../state/api';
import { threadTitle, useApp } from '../state/app';
import { closePane, cyclePane, openThread, openView, setAddingProject, setPalette, splitPane, toggleSidebar, useUi } from '../state/ui';
import { fuzzyScore } from '../lib/fuzzy';
import { identity } from '../lib/hue';
import { isMac } from '../lib/keys';
import { useScrollFade } from '../lib/hooks';
import { Glyph, ICON_SM, Kbd } from './ui';

interface Cmd {
  id: string;
  group: string;
  label: string;
  /** extra searchable text */
  keywords?: string;
  icon?: LucideIcon;
  lead?: ReactNode;
  detail?: string;
  combo?: string;
  run: (split: boolean) => void;
}

export function CommandPalette() {
  const open = useUi((s) => s.palette);
  if (!open) return null;
  return createPortal(<Palette />, document.body);
}

function Palette() {
  const threads = useApp((s) => s.threads);
  const personas = useApp((s) => s.personas);
  const projects = useApp((s) => s.projects);
  const pending = useApp((s) => s.pendingApprovals);
  const kb = useApp((s) => s.settings.keybindings);
  const paneCount = useUi((s) => s.panes.length);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  useScrollFade(listRef);

  const close = () => {
    setPalette(false);
    restoreFocus.current?.focus?.();
  };
  const k = (id: string) => kb[id] ?? DEFAULT_KEYBINDINGS[id];

  const commands = useMemo<Cmd[]>(() => {
    const setTheme = (theme: 'light' | 'dark' | 'system') => void attempt(api.putSettings({ theme }));
    const out: Cmd[] = [];
    for (const p of pending) {
      const t = threads.find((x) => x.id === p.threadId);
      out.push({
        id: `approval:${p.requestId}`,
        group: 'Needs approval',
        label: p.title,
        detail: t ? `@${t.handle}` : undefined,
        icon: ShieldAlert,
        keywords: 'approval approve pending',
        run: (split) => openThread(p.threadId, { split }),
      });
    }
    out.push(
      { id: 'new', group: 'Actions', label: 'New thread', icon: SquarePen, combo: k('thread.new'), run: (split) => openView({ kind: 'new' }, { split }) },
      { id: 'split', group: 'Actions', label: 'Split pane', icon: Columns2, combo: k('pane.split'), run: () => splitPane() },
      { id: 'close', group: 'Actions', label: 'Close pane', icon: X, combo: k('pane.close'), run: () => closePane() },
    );
    if (paneCount > 1) {
      out.push(
        { id: 'next', group: 'Actions', label: 'Focus next pane', icon: ArrowLeftRight, combo: k('pane.next'), run: () => cyclePane(1) },
        { id: 'prev', group: 'Actions', label: 'Focus previous pane', icon: ArrowLeftRight, combo: k('pane.prev'), run: () => cyclePane(-1) },
      );
    }
    out.push(
      { id: 'sidebar', group: 'Actions', label: 'Toggle sidebar', icon: PanelLeft, combo: k('sidebar.toggle'), run: () => toggleSidebar() },
      { id: 'settings', group: 'Actions', label: 'Open settings', icon: Settings, combo: k('settings.open'), run: (split) => openView({ kind: 'settings' }, { split }) },
      { id: 'schedules', group: 'Actions', label: 'Open schedules', icon: CalendarClock, run: (split) => openView({ kind: 'schedules' }, { split }) },
      {
        id: 'add-project',
        group: 'Actions',
        label: 'Add project…',
        icon: FolderPlus,
        keywords: 'folder repository',
        run: () => setAddingProject(true),
      },
      { id: 'theme-light', group: 'Theme', label: 'Theme: light', icon: Sun, keywords: 'appearance', run: () => setTheme('light') },
      { id: 'theme-dark', group: 'Theme', label: 'Theme: dark', icon: Moon, keywords: 'appearance', run: () => setTheme('dark') },
      { id: 'theme-system', group: 'Theme', label: 'Theme: system', icon: Monitor, keywords: 'appearance auto', run: () => setTheme('system') },
    );
    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    for (const t of [...threads].sort((a, b) => b.lastEventAt - a.lastEventAt)) {
      const id = identity(
        t,
        personas.find((p) => p.id === t.personaId),
      );
      out.push({
        id: `thread:${t.id}`,
        group: 'Threads',
        label: threadTitle(t),
        detail: `@${t.handle}`,
        keywords: `${t.handle} ${projectName.get(t.projectId) ?? ''}${t.archived ? ' archived' : ''}`,
        lead: <Glyph glyph={id.glyph} hue={id.hue} size="sm" />,
        run: (split) => openThread(t.id, { split }),
      });
    }
    for (const p of projects) {
      out.push({ id: `new-in:${p.id}`, group: 'New thread in', label: p.name, icon: SquarePen, keywords: 'new thread project', run: (split) => openView({ kind: 'new', projectId: p.id }, { split }) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, personas, projects, pending, kb, paneCount]);

  const results = useMemo(() => {
    if (!q.trim()) {
      // Without a query: approvals, actions, then the 8 most recent threads.
      let threadsShown = 0;
      return commands.filter((c) => c.group !== 'New thread in' && c.group !== 'Theme' && (c.group !== 'Threads' || threadsShown++ < 8));
    }
    return commands
      .map((c) => ({ c, s: Math.max(fuzzyScore(q, c.label), fuzzyScore(q, `${c.detail ?? ''} ${c.keywords ?? ''}`) - 50) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.c);
  }, [q, commands]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (c: Cmd | undefined, split: boolean) => {
    if (!c) return;
    setPalette(false);
    c.run(split);
  };

  let lastGroup = '';
  return (
    <div className="scrim palette-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
          } else if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            run(results[active], isMac ? e.metaKey : e.ctrlKey);
          }
        }}
      >
        <input
          ref={inputRef}
          className="palette-input"
          autoFocus
          placeholder="Search threads and commands"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search threads and commands"
          aria-controls="palette-list"
          aria-activedescendant={results[active] ? `pal-${active}` : undefined}
        />
        <div className="palette-list fade-y" ref={listRef} id="palette-list" role="listbox">
          <div>
            {results.length === 0 ? <div className="palette-empty">No matches</div> : null}
            {results.map((c, i) => {
              const head = !q.trim() && c.group !== lastGroup ? c.group : null;
              lastGroup = c.group;
              return (
                <div key={c.id}>
                  {head ? <div className="palette-group">{head}</div> : null}
                  <button
                    type="button"
                    id={`pal-${i}`}
                    data-idx={i}
                    role="option"
                    aria-selected={i === active}
                    className={`palette-item${i === active ? ' is-active' : ''}`}
                    onPointerMove={() => i !== active && setActive(i)}
                    onClick={(e) => run(c, e.metaKey || e.ctrlKey)}
                  >
                    <span className="palette-lead">{c.lead ?? (c.icon ? <c.icon {...ICON_SM} /> : null)}</span>
                    <span className="palette-label">{c.label}</span>
                    {c.detail ? <span className="palette-detail mono">{c.detail}</span> : null}
                    {c.combo ? <Kbd combo={c.combo} /> : null}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="palette-foot">
          <span>
            <Kbd combo="enter" /> open
          </span>
          <span>
            <Kbd combo="mod+enter" /> open in split
          </span>
          <span>
            <Kbd combo="escape" /> close
          </span>
        </div>
      </div>
    </div>
  );
}
