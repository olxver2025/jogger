import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Archive, ArchiveRestore, AtSign, Check, Copy, Ellipsis, GitBranch, ListX, Pencil, Square, Trash2 } from 'lucide-react';
import type { ApprovalMode, Thread } from '../../shared/protocol';
import { api, attempt } from '../state/api';
import { isBusy, threadTitle, useApp, usePersona, useProvider, useThread } from '../state/app';
import { onThreadRemoved } from '../state/ui';
import { identity } from '../lib/hue';
import { toast } from '../state/toast';
import { Composer } from './Composer';
import { PaneBar } from './PaneBar';
import { Timeline } from './timeline/Timeline';
import { Button, EmptyState, Glyph, ICON_SM, IconButton, Popover, Segmented, confirmDialog, openMenu, statusLabel, type MenuItem } from './ui';

export const MODE_OPTIONS: { value: ApprovalMode; label: string; tip: string }[] = [
  { value: 'ask', label: 'Ask', tip: 'Ask: approve edits and commands' },
  { value: 'auto', label: 'Auto', tip: 'Auto: edits allowed, risky commands ask' },
  { value: 'full', label: 'Full', tip: 'Full: never ask' },
];

function InlineEdit({
  value,
  onSave,
  className,
  placeholder,
  label,
  display,
}: {
  value: string;
  onSave: (v: string) => void;
  className?: string;
  placeholder?: string;
  label: string;
  display: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  if (!editing) {
    return (
      <button type="button" className={`inline-edit ${className ?? ''}`} onClick={() => setEditing(true)} data-tip={label}>
        {display}
      </button>
    );
  }
  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v !== value.trim()) onSave(v);
  };
  return (
    <input
      autoFocus
      className={`inline-edit-input ${className ?? ''}`}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') {
          e.stopPropagation();
          setDraft(value);
          setEditing(false);
        }
      }}
    />
  );
}

function ModelPicker({ thread }: { thread: Thread }) {
  const provider = useProvider(thread.provider);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const models = provider?.models ?? [];
  const current = models.find((m) => m.id === thread.model);
  const set = (model: string) => {
    setOpen(false);
    if (model !== thread.model) void attempt(api.updateThread(thread.id, { model }));
  };
  return (
    <>
      <button ref={anchor} type="button" className="ph-model" onClick={() => setOpen(!open)} aria-expanded={open} data-tip="Change model">
        <span>{provider?.label ?? thread.provider}</span>
        <span aria-hidden className="ph-sep">
          ·
        </span>
        <span className="mono">{current?.label ?? (thread.model || 'default')}</span>
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={260}>
        <div className="picker">
          <div className="picker-list">
            {[{ id: '', label: `Default${provider?.defaultModel ? ` (${provider.defaultModel})` : ''}` }, ...models].map((m) => (
              <button key={m.id || '_default'} type="button" className={`picker-item${m.id === thread.model ? ' is-on' : ''}`} onClick={() => set(m.id)}>
                <span className="picker-label">{m.label}</span>
                {m.id && m.id !== m.label ? <span className="picker-id mono">{m.id}</span> : null}
                {m.id === thread.model ? <Check {...ICON_SM} /> : null}
              </button>
            ))}
          </div>
          <form
            className="picker-custom"
            onSubmit={(e) => {
              e.preventDefault();
              if (custom.trim()) set(custom.trim());
            }}
          >
            <input className="input mono" placeholder="Other model id" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Custom model id" />
          </form>
        </div>
      </Popover>
    </>
  );
}

function ThreadHeader({ thread, paneIndex }: { thread: Thread; paneIndex: number }) {
  const persona = usePersona(thread.personaId);
  const project = useApp((s) => s.projects.find((p) => p.id === thread.projectId));
  const pendingHere = useApp((s) => s.pendingApprovals.some((p) => p.threadId === thread.id));
  const id = identity(thread, persona);
  const status = pendingHere ? 'waiting' : thread.status;
  const busy = isBusy(thread);
  const [renamingHandle, setRenamingHandle] = useState(false);

  const menu = (): MenuItem[] => {
    const items: MenuItem[] = [
      { label: 'Rename handle', icon: AtSign, onSelect: () => setRenamingHandle(true) },
      {
        label: 'Copy working folder',
        icon: Copy,
        onSelect: () => void navigator.clipboard?.writeText(thread.cwd).then(() => toast('Copied path', 'ok')),
      },
    ];
    if (thread.worktree) {
      items.push({
        label: `Copy branch ${thread.worktree.branch}`,
        icon: GitBranch,
        onSelect: () => void navigator.clipboard?.writeText(thread.worktree!.branch).then(() => toast('Copied branch', 'ok')),
      });
    }
    if (thread.queued > 0) items.push({ label: `Clear ${thread.queued} queued`, icon: ListX, onSelect: () => void attempt(api.clearQueue(thread.id)) });
    items.push('sep');
    for (const m of MODE_OPTIONS) {
      items.push({ label: m.tip, icon: m.value === thread.mode ? Check : undefined, onSelect: () => void attempt(api.updateThread(thread.id, { mode: m.value })) });
    }
    items.push('sep');
    items.push(
      thread.archived
        ? { label: 'Unarchive', icon: ArchiveRestore, onSelect: () => void attempt(api.updateThread(thread.id, { archived: false })) }
        : { label: 'Archive', icon: Archive, onSelect: () => void attempt(api.updateThread(thread.id, { archived: true })) },
      {
        label: 'Delete thread…',
        icon: Trash2,
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: `Delete @${thread.handle}?`,
            body: 'Its history is removed for good. Files the agent changed stay as they are.',
            confirm: 'Delete thread',
            danger: true,
          });
          if (ok && (await attempt(api.deleteThread(thread.id).then(() => true)))) onThreadRemoved(thread.id);
        },
      },
    );
    return items;
  };

  return (
    <PaneBar
      paneIndex={paneIndex}
      actions={
        <>
          {busy ? (
            <Button size="sm" icon={Square} onClick={() => void attempt(api.interrupt(thread.id))} tip="Stop the running turn">
              Stop
            </Button>
          ) : null}
          <IconButton icon={Ellipsis} label="Thread actions" onClick={(e) => openMenu(e.currentTarget, menu())} />
        </>
      }
    >
      <Glyph glyph={id.glyph} hue={id.hue} />
      <div className="ph-id">
        <div className="ph-line">
          {renamingHandle ? (
            <HandleEdit thread={thread} onDone={() => setRenamingHandle(false)} />
          ) : (
            <button type="button" className="ph-handle mono" onClick={() => setRenamingHandle(true)} data-tip="Rename handle — other agents use it to reach this thread">
              @{thread.handle}
            </button>
          )}
          <InlineEdit
            className="ph-title"
            value={thread.title}
            label="Rename thread"
            placeholder="Thread title"
            display={
              <>
                <span className="ph-title-text">{threadTitle(thread)}</span>
                <Pencil size={12} strokeWidth={1.5} className="ph-pencil" />
              </>
            }
            onSave={(title) => void attempt(api.updateThread(thread.id, { title }))}
          />
        </div>
        <div className="ph-sub">
          <ModelPicker thread={thread} />
          {project ? <span className="ph-project">{project.name}</span> : null}
          {status !== 'idle' ? <span className={`ph-status st-${status}`}>{statusLabel(status)}</span> : null}
        </div>
      </div>
      <div className="ph-mode">
        <Segmented
          size="sm"
          label="Approval mode"
          value={thread.mode}
          options={MODE_OPTIONS}
          onChange={(mode) => void attempt(api.updateThread(thread.id, { mode }))}
        />
      </div>
    </PaneBar>
  );
}

function HandleEdit({ thread, onDone }: { thread: Thread; onDone: () => void }) {
  const [v, setV] = useState(thread.handle);
  const commit = () => {
    onDone();
    const h = v.trim().replace(/^@/, '');
    if (h && h !== thread.handle) void attempt(api.updateThread(thread.id, { handle: h }));
  };
  return (
    <span className="ph-handle-edit">
      <span className="mono">@</span>
      <input
        autoFocus
        className="inline-edit-input mono"
        value={v}
        aria-label="Handle"
        onFocus={(e) => e.target.select()}
        onChange={(e) => setV(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') {
            e.stopPropagation();
            onDone();
          }
        }}
      />
    </span>
  );
}

export function ThreadView({ threadId, paneIndex, focused }: { threadId: string; paneIndex: number; focused: boolean }) {
  const thread = useThread(threadId);
  if (!thread) {
    return (
      <>
        <PaneBar paneIndex={paneIndex}>
          <span className="pane-title muted">Thread not found</span>
        </PaneBar>
        <EmptyState title="This thread is gone">It was deleted, or its project was removed.</EmptyState>
      </>
    );
  }
  return (
    <>
      <ThreadHeader thread={thread} paneIndex={paneIndex} />
      <Timeline threadId={thread.id} status={thread.status} handle={thread.handle} />
      <Composer thread={thread} focused={focused} />
    </>
  );
}
