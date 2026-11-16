import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, Plus } from 'lucide-react';
import type { MemoryEntry } from '../../../shared/protocol';
import { useApp } from '../../state/app';
import { api, attempt } from '../../state/api';
import { ago } from '../../lib/format';
import { Button, EmptyState, Field, ICON_SM, Loading, confirmDialog } from '../ui';
import { SectionHead, useBusy } from './common';

export function MemorySection() {
  const projects = useApp((s) => s.projects);
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? '');
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null); // key being edited, or '' for a new entry

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
    if (projectId && !projects.some((p) => p.id === projectId)) setProjectId(projects[0]?.id ?? '');
  }, [projects, projectId]);

  const load = useCallback(() => {
    if (!projectId) return;
    setEntries(null);
    setError(null);
    api
      .memory(projectId)
      .then(setEntries)
      .catch((e: Error) => setError(e.message));
  }, [projectId]);

  useEffect(() => {
    setOpen(null);
    load();
  }, [load]);

  if (!projects.length) {
    return (
      <section className="section">
        <SectionHead title="Memory" />
        <div className="list">
          <EmptyState title="No projects yet">Add a project folder first. Memory is shared by every agent working in a project.</EmptyState>
        </div>
      </section>
    );
  }

  return (
    <section className="section">
      <SectionHead
        title="Memory"
        desc="Notes every agent in a project can read and write: conventions, decisions, where things live."
        action={
          <Button size="sm" icon={Plus} disabled={!entries || open === ''} onClick={() => setOpen('')}>
            Add entry
          </Button>
        }
      />

      <div className="memory-project">
        <Field label="Project" htmlFor="mem-project">
          <select id="mem-project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {error ? (
        <div className="callout is-error">
          <CircleAlert {...ICON_SM} />
          <span>
            Could not load memory: {error}{' '}
            <button type="button" className="link-btn" onClick={load}>
              Retry
            </button>
          </span>
        </div>
      ) : !entries ? (
        <Loading label="Loading memory" />
      ) : (
        <div className="list">
          {open === '' ? (
            <MemoryEditor projectId={projectId} isNew onSaved={setEntries} onClose={() => setOpen(null)} existing={entries.map((e) => e.key)} />
          ) : null}
          {entries.length === 0 && open !== '' ? (
            <EmptyState title="Nothing remembered yet">Agents write here with the memory tool, or add an entry yourself.</EmptyState>
          ) : null}
          {entries.map((e) =>
            open === e.key ? (
              <MemoryEditor key={e.key} projectId={projectId} entry={e} onSaved={setEntries} onClose={() => setOpen(null)} existing={[]} />
            ) : (
              <button key={e.key} type="button" className="list-row memory-row" onClick={() => setOpen(e.key)}>
                <div className="memory-main">
                  <div className="memory-key mono">{e.key}</div>
                  <div className="memory-preview">{e.content || <span className="muted">Empty</span>}</div>
                </div>
                <span className="memory-meta muted">
                  {e.updatedBy} · {ago(e.updatedAt)}
                </span>
              </button>
            ),
          )}
        </div>
      )}
    </section>
  );
}

function MemoryEditor({
  projectId,
  entry,
  isNew,
  existing,
  onSaved,
  onClose,
}: {
  projectId: string;
  entry?: MemoryEntry;
  isNew?: boolean;
  existing: string[];
  onSaved: (list: MemoryEntry[]) => void;
  onClose: () => void;
}) {
  const [key, setKey] = useState(entry?.key ?? '');
  const [content, setContent] = useState(entry?.content ?? '');
  const [busy, run] = useBusy();
  const [deleting, runDelete] = useBusy();
  const k = key.trim();
  const keyError = isNew && k && existing.includes(k) ? 'An entry with this key exists. Edit it instead.' : null;

  const save = () =>
    run(async () => {
      if (!k || keyError) return;
      const list = await attempt(api.putMemory(projectId, k, content), 'Memory saved');
      if (list) {
        onSaved(list);
        onClose();
      }
    });

  const remove = async () => {
    if (!entry) return;
    const ok = await confirmDialog({ title: `Delete “${entry.key}”?`, body: 'Agents will no longer see this entry. This cannot be undone.', confirm: 'Delete', danger: true });
    if (!ok) return;
    await runDelete(async () => {
      const list = await attempt(api.deleteMemory(projectId, entry.key), 'Memory deleted');
      if (list) {
        onSaved(list);
        onClose();
      }
    });
  };

  return (
    <form
      className="memory-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void save();
        }
      }}
    >
      {isNew ? (
        <Field label="Key" htmlFor="mem-key" error={keyError} hint="Short and specific, e.g. test-command or api-conventions.">
          <input id="mem-key" className="input mono" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="test-command" />
        </Field>
      ) : (
        <div className="memory-key mono">{entry?.key}</div>
      )}
      <Field label="Content" htmlFor={`mem-content-${entry?.key ?? 'new'}`}>
        <textarea
          id={`mem-content-${entry?.key ?? 'new'}`}
          className="textarea"
          rows={6}
          autoFocus={!isNew}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </Field>
      <div className="form-actions">
        <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!k || !!keyError}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <span className="spacer" />
        {entry ? (
          <Button size="sm" variant="ghost" className="btn-danger-ghost" busy={deleting} onClick={() => void remove()}>
            Delete
          </Button>
        ) : null}
      </div>
    </form>
  );
}
