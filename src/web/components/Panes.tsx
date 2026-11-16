import { memo, useMemo } from 'react';
import { SquarePen } from 'lucide-react';
import { DEFAULT_KEYBINDINGS } from '../../shared/protocol';
import { threadTitle, useApp } from '../state/app';
import { focusPane, openView, useUi, type Pane as PaneT } from '../state/ui';
import { identity } from '../lib/hue';
import { agoShort } from '../lib/format';
import { NewThread } from './NewThread';
import { PaneBar } from './PaneBar';
import { SchedulesView } from './schedules/SchedulesView';
import { SettingsView } from './settings/SettingsView';
import { ThreadView } from './ThreadView';
import { Button, Glyph, Kbd, StatusDot } from './ui';
import { AddProject } from './AddProject';

export function PaneGrid() {
  const panes = useUi((s) => s.panes);
  const focused = useUi((s) => s.focused);
  return (
    <div className="panes" data-n={panes.length}>
      {panes.map((p, i) => (
        <Pane key={p.id} pane={p} index={i} focused={i === focused} />
      ))}
    </div>
  );
}

const Pane = memo(function Pane({ pane, index, focused }: { pane: PaneT; index: number; focused: boolean }) {
  const v = pane.view;
  let body;
  switch (v.kind) {
    case 'thread':
      body = <ThreadView threadId={v.threadId} paneIndex={index} focused={focused} />;
      break;
    case 'new':
      body = <NewThread paneIndex={index} projectId={v.projectId} />;
      break;
    case 'settings':
      body = <SettingsView paneIndex={index} section={v.section} />;
      break;
    case 'schedules':
      body = <SchedulesView paneIndex={index} scheduleId={v.scheduleId} />;
      break;
    default:
      body = <EmptyPane paneIndex={index} />;
  }
  return (
    <section
      className={`pane${focused ? ' is-focused' : ''}`}
      onPointerDownCapture={() => focusPane(index)}
      onFocusCapture={() => focusPane(index)}
      aria-label={`Pane ${index + 1}`}
    >
      {body}
    </section>
  );
});

function EmptyPane({ paneIndex }: { paneIndex: number }) {
  const threads = useApp((s) => s.threads);
  const personas = useApp((s) => s.personas);
  const projects = useApp((s) => s.projects);
  const kb = useApp((s) => s.settings.keybindings);
  const panes = useUi((s) => s.panes);
  const openIds = useMemo(() => new Set(panes.flatMap((p) => (p.view.kind === 'thread' ? [p.view.threadId] : []))), [panes]);
  const recent = useMemo(
    () =>
      threads
        .filter((t) => !t.archived && !openIds.has(t.id))
        .sort((a, b) => b.lastEventAt - a.lastEventAt)
        .slice(0, 8),
    [threads, openIds],
  );
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? '';
  const k = (id: string) => kb[id] ?? DEFAULT_KEYBINDINGS[id];

  return (
    <>
      <PaneBar paneIndex={paneIndex}>
        <span className="pane-title muted">Empty pane</span>
      </PaneBar>
      <div className="page-scroll">
        <div className="page page-narrow empty-pane">
          <Button variant="primary" size="lg" icon={SquarePen} onClick={() => openView({ kind: 'new' }, { pane: paneIndex })}>
            New thread
          </Button>
          {recent.length ? (
            <div className="section">
              <div className="section-head">
                <h2 className="section-title">Open a recent thread</h2>
              </div>
              <div className="list">
                {recent.map((t) => {
                  const id = identity(
                    t,
                    personas.find((p) => p.id === t.personaId),
                  );
                  return (
                    <button key={t.id} type="button" className="list-row recent-row" onClick={() => openView({ kind: 'thread', threadId: t.id }, { pane: paneIndex })}>
                      <Glyph glyph={id.glyph} hue={id.hue} size="sm" />
                      <span className="mono recent-handle">@{t.handle}</span>
                      <span className="recent-title">{threadTitle(t)}</span>
                      <span className="recent-project">{projectName(t.projectId)}</span>
                      {t.status !== 'idle' ? <StatusDot status={t.status} /> : <span className="recent-time num">{agoShort(t.lastEventAt)}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className="empty-keys">
            <span>
              <Kbd combo={k('palette.open')} /> Command palette
            </span>
            <span>
              <Kbd combo={k('pane.split')} /> Split pane
            </span>
            <span>
              <Kbd combo={k('pane.next')} /> Next pane
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

/** Shown instead of panes until there is at least one project. */
export function FirstRun() {
  return (
    <div className="first-run">
      <div className="first-run-card">
        <h1 className="page-h1">Pick a project folder</h1>
        <p className="page-lede">
          Jogger runs Claude Code, Codex and other agents side by side in a folder you choose, and lets them message each other. Start with the repository you want
          them to work in.
        </p>
        <div className="first-run-input">
          <AddProject autoFocus size="lg" onDone={(p) => p && openView({ kind: 'new', projectId: p.id })} />
        </div>
      </div>
    </div>
  );
}
