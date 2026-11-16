import { memo, useMemo, useRef, type CSSProperties, type MouseEvent } from 'react';
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  ChevronRight,
  Columns2,
  Ellipsis,
  FolderPlus,
  PanelLeftClose,
  Plus,
  Settings,
  ShieldAlert,
  SquarePen,
  Trash2,
} from 'lucide-react';
import type { Persona, Project, Thread } from '../../shared/protocol';
import { attempt, api } from '../state/api';
import { threadTitle, useApp } from '../state/app';
import { openThread, openView, setAddingProject, toggleArchived, toggleCollapsed, toggleSidebar, useUi } from '../state/ui';
import { identity } from '../lib/hue';
import { agoShort } from '../lib/format';
import { useNow, useScrollFade } from '../lib/hooks';
import { AddProject } from './AddProject';
import { Glyph, ICON_SM, IconButton, Kbd, StatusDot, confirmDialog, openMenu, type MenuItem } from './ui';
import { DEFAULT_KEYBINDINGS } from '../../shared/protocol';

interface Node {
  thread: Thread;
  children: Node[];
}

function buildTree(threads: Thread[]): Node[] {
  const byId = new Map(threads.map((t) => [t.id, { thread: t, children: [] as Node[] }]));
  const roots: Node[] = [];
  for (const n of byId.values()) {
    const parent = n.thread.parentThreadId ? byId.get(n.thread.parentThreadId) : undefined;
    if (parent && parent !== n) parent.children.push(n);
    else roots.push(n);
  }
  const sort = (list: Node[]) => {
    list.sort((a, b) => b.thread.lastEventAt - a.thread.lastEventAt);
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}

export function threadMenu(t: Thread): MenuItem[] {
  return [
    { label: 'Open in new split', icon: Columns2, onSelect: () => openThread(t.id, { split: true }) },
    t.archived
      ? { label: 'Unarchive', icon: ArchiveRestore, onSelect: () => void attempt(api.updateThread(t.id, { archived: false })) }
      : { label: 'Archive', icon: Archive, onSelect: () => void attempt(api.updateThread(t.id, { archived: true })) },
    'sep',
    {
      label: 'Delete thread…',
      icon: Trash2,
      danger: true,
      onSelect: async () => {
        const ok = await confirmDialog({
          title: `Delete @${t.handle}?`,
          body: 'Its history is removed for good. Files the agent changed stay as they are.',
          confirm: 'Delete thread',
          danger: true,
        });
        if (ok) void attempt(api.deleteThread(t.id));
      },
    },
  ];
}

export function Sidebar() {
  const projects = useApp((s) => s.projects);
  const threads = useApp((s) => s.threads);
  const personas = useApp((s) => s.personas);
  const pending = useApp((s) => s.pendingApprovals);
  const keybindings = useApp((s) => s.settings.keybindings);
  const showArchived = useUi((s) => s.showArchived);
  const collapsed = useUi((s) => s.collapsed);
  const panes = useUi((s) => s.panes);
  const focused = useUi((s) => s.focused);
  const adding = useUi((s) => s.addingProject);
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);
  const now = useNow(60_000);

  const focusedThreadId = panes[focused]?.view.kind === 'thread' ? (panes[focused].view as { threadId: string }).threadId : null;
  const openIds = useMemo(() => new Set(panes.flatMap((p) => (p.view.kind === 'thread' ? [p.view.threadId] : []))), [panes]);
  const personaById = useMemo(() => new Map(personas.map((p) => [p.id, p])), [personas]);
  const archivedCount = useMemo(() => threads.filter((t) => t.archived).length, [threads]);
  const pendingByThread = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pending) m.set(p.threadId, (m.get(p.threadId) ?? 0) + 1);
    return m;
  }, [pending]);

  const groups = useMemo(
    () =>
      projects.map((p) => ({
        project: p,
        tree: buildTree(threads.filter((t) => t.projectId === p.id && (showArchived || !t.archived))),
      })),
    [projects, threads, showArchived],
  );

  const newKey = keybindings['thread.new'] ?? DEFAULT_KEYBINDINGS['thread.new'];

  return (
    <aside className="sidebar" aria-label="Projects and threads">
      <div className="sb-top">
        <div className="sb-brand">
          <span className="sb-mark" aria-hidden />
          <span className="sb-name">Jogger</span>
        </div>
        <IconButton icon={PanelLeftClose} label="Hide sidebar" onClick={toggleSidebar} />
      </div>

      <div className="sb-primary">
        <button type="button" className="btn btn-primary btn-md sb-new" onClick={() => openView({ kind: 'new' })}>
          <SquarePen {...ICON_SM} />
          <span>New thread</span>
          <span className="sb-new-kbd">
            <Kbd combo={newKey} />
          </span>
        </button>
      </div>

      {pending.length > 0 ? (
        <button type="button" className="sb-approvals" onClick={() => openThread(pending[0].threadId)}>
          <ShieldAlert {...ICON_SM} />
          <span>
            {pending.length === 1 ? '1 approval waiting' : `${pending.length} approvals waiting`}
          </span>
        </button>
      ) : null}

      <div className="sb-scroll fade-y" ref={scrollRef}>
        <div>
          {groups.map(({ project, tree }) => (
            <ProjectGroup
              key={project.id}
              project={project}
              tree={tree}
              collapsed={!!collapsed[project.id]}
              focusedThreadId={focusedThreadId}
              openIds={openIds}
              personaById={personaById}
              pendingByThread={pendingByThread}
              now={now}
            />
          ))}
          {projects.length === 0 ? <p className="sb-hint">Add a project folder to start a thread in it.</p> : null}
        </div>
      </div>

      <div className="sb-foot">
        {adding ? (
          <div className="sb-add">
            <AddProject autoFocus onDone={() => setAddingProject(false)} submitLabel="Add" />
          </div>
        ) : null}
        <div className="sb-links">
          <button type="button" className="sb-link" onClick={() => setAddingProject(!adding)} aria-expanded={adding}>
            <FolderPlus {...ICON_SM} />
            <span>Add project</span>
          </button>
          <button type="button" className="sb-link" onClick={() => openView({ kind: 'schedules' })}>
            <CalendarClock {...ICON_SM} />
            <span>Schedules</span>
          </button>
          <button type="button" className="sb-link" onClick={() => openView({ kind: 'settings' })}>
            <Settings {...ICON_SM} />
            <span>Settings</span>
          </button>
          {archivedCount > 0 ? (
            <button type="button" className={`sb-link${showArchived ? ' is-on' : ''}`} onClick={toggleArchived} aria-pressed={showArchived}>
              <Archive {...ICON_SM} />
              <span>{showArchived ? 'Hide archived' : 'Show archived'}</span>
              <span className="sb-count num">{archivedCount}</span>
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

const ProjectGroup = memo(function ProjectGroup({
  project,
  tree,
  collapsed,
  focusedThreadId,
  openIds,
  personaById,
  pendingByThread,
  now,
}: {
  project: Project;
  tree: Node[];
  collapsed: boolean;
  focusedThreadId: string | null;
  openIds: Set<string>;
  personaById: Map<string, Persona>;
  pendingByThread: Map<string, number>;
  now: number;
}) {
  const projectMenu = (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.type === 'contextmenu' ? { x: e.clientX, y: e.clientY } : e.currentTarget, [
      { label: 'New thread here', icon: Plus, onSelect: () => openView({ kind: 'new', projectId: project.id }) },
      { label: 'Copy path', onSelect: () => void navigator.clipboard?.writeText(project.path) },
      'sep',
      {
        label: 'Remove project…',
        icon: Trash2,
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: `Remove ${project.name}?`,
            body: 'This deletes its threads from Jogger. The folder on disk is not touched.',
            confirm: 'Remove project',
            danger: true,
          });
          if (ok) void attempt(api.deleteProject(project.id));
        },
      },
    ]);
  };
  return (
    <section className="sb-group">
      <div className="sb-group-head" onContextMenu={projectMenu}>
        <button
          type="button"
          className="sb-group-toggle"
          aria-expanded={!collapsed}
          onClick={() => toggleCollapsed(project.id)}
          data-tip={project.path}
        >
          <ChevronRight {...ICON_SM} className={`sb-chevron${collapsed ? '' : ' is-open'}`} />
          <span className="sb-group-name">{project.name}</span>
        </button>
        <div className="sb-group-actions">
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Project actions" data-tip="Project actions" onClick={projectMenu}>
            <Ellipsis {...ICON_SM} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label={`New thread in ${project.name}`}
            data-tip="New thread here"
            onClick={() => openView({ kind: 'new', projectId: project.id })}
          >
            <Plus {...ICON_SM} />
          </button>
        </div>
      </div>
      {!collapsed ? (
        <ul className="sb-threads">
          {tree.length === 0 ? <li className="sb-empty">No threads yet</li> : null}
          {tree.map((n) => (
            <ThreadNode
              key={n.thread.id}
              node={n}
              depth={0}
              focusedThreadId={focusedThreadId}
              openIds={openIds}
              personaById={personaById}
              pendingByThread={pendingByThread}
              now={now}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
});

function ThreadNode({
  node,
  depth,
  ...rest
}: {
  node: Node;
  depth: number;
  focusedThreadId: string | null;
  openIds: Set<string>;
  personaById: Map<string, Persona>;
  pendingByThread: Map<string, number>;
  now: number;
}) {
  const t = node.thread;
  return (
    <>
      <ThreadRow
        thread={t}
        depth={depth}
        persona={t.personaId ? rest.personaById.get(t.personaId) : undefined}
        focused={rest.focusedThreadId === t.id}
        open={rest.openIds.has(t.id)}
        pending={rest.pendingByThread.get(t.id) ?? 0}
        now={rest.now}
      />
      {node.children.map((c) => (
        <ThreadNode key={c.thread.id} node={c} depth={depth + 1} {...rest} />
      ))}
    </>
  );
}

const ThreadRow = memo(function ThreadRow({
  thread: t,
  depth,
  persona,
  focused,
  open,
  pending,
  now,
}: {
  thread: Thread;
  depth: number;
  persona: Persona | undefined;
  focused: boolean;
  open: boolean;
  pending: number;
  now: number;
}) {
  const id = identity(t, persona);
  const status = pending > 0 ? 'waiting' : t.status;
  return (
    <li
      className={`sb-thread${focused ? ' is-focused' : open ? ' is-open' : ''}${t.archived ? ' is-archived' : ''}`}
      style={{ '--depth': depth } as CSSProperties}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu({ x: e.clientX, y: e.clientY }, threadMenu(t));
      }}
    >
      <button
        type="button"
        className="sb-thread-main"
        onClick={(e) => openThread(t.id, { split: e.metaKey || e.ctrlKey })}
        onAuxClick={(e) => e.button === 1 && openThread(t.id, { split: true })}
        aria-current={focused ? 'true' : undefined}
      >
        {depth > 0 ? <span className="sb-branch" aria-hidden /> : null}
        <span className="sb-glyph">
          <Glyph glyph={id.glyph} hue={id.hue} size="sm" />
          {status !== 'idle' ? <StatusDot status={status} /> : null}
        </span>
        <span className="sb-thread-text">
          <span className="sb-handle mono">@{t.handle}</span>
          <span className="sb-title">{threadTitle(t)}</span>
        </span>
        {t.queued > 0 ? (
          <span className="sb-queued num" data-tip={`${t.queued} queued`}>
            +{t.queued}
          </span>
        ) : (
          <span className="sb-time num">{agoShort(t.lastEventAt, now)}</span>
        )}
      </button>
      <button
        type="button"
        className="icon-btn icon-btn-sm sb-thread-more"
        aria-label="Thread actions"
        onClick={(e) => openMenu(e.currentTarget, threadMenu(t))}
      >
        <Ellipsis {...ICON_SM} />
      </button>
    </li>
  );
});

