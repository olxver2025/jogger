import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';
import type { ApprovalMode, CreateThreadBody, Persona, ProviderInfo } from '../../shared/protocol';
import { api, attempt } from '../state/api';
import { useApp } from '../state/app';
import { openView } from '../state/ui';
import { providerHue } from '../lib/hue';
import { isMac } from '../lib/keys';
import { useAutosize } from '../lib/hooks';
import { AddProject } from './AddProject';
import { filesFromClipboard, UploadChips, useUploads } from './Composer';
import { MODE_OPTIONS } from './ThreadView';
import { PaneBar } from './PaneBar';
import { Button, Field, Glyph, ICON_SM, Kbd, Segmented, Switch } from './ui';

type Choice = { kind: 'persona'; id: string } | { kind: 'provider'; id: string };
const LAST_KEY = 'jogger.newthread.last';

function loadLast(): { choice?: Choice; projectId?: string } {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function NewThread({ paneIndex, projectId: initialProject }: { paneIndex: number; projectId?: string | null }) {
  const projects = useApp((s) => s.projects);
  const personas = useApp((s) => s.personas);
  const providers = useApp((s) => s.providers);
  const last = useMemo(loadLast, []);
  const providerById = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers]);
  const available = (id: string) => providerById.get(id)?.available ?? false;

  const [projectId, setProjectId] = useState<string>(
    () => initialProject ?? (last.projectId && projects.some((p) => p.id === last.projectId) ? last.projectId : projects[projects.length - 1]?.id ?? ''),
  );
  useEffect(() => {
    if (initialProject) setProjectId(initialProject);
  }, [initialProject]);
  useEffect(() => {
    if (!projects.some((p) => p.id === projectId) && projects.length) setProjectId(projects[projects.length - 1].id);
  }, [projects, projectId]);

  const defaultChoice = (): Choice | null => {
    const l = last.choice;
    if (l?.kind === 'persona') {
      const p = personas.find((x) => x.id === l.id);
      if (p && available(p.provider)) return l;
    }
    if (l?.kind === 'provider' && available(l.id)) return l;
    const p = personas.find((x) => available(x.provider));
    if (p) return { kind: 'persona', id: p.id };
    const pr = providers.find((x) => x.available);
    return pr ? { kind: 'provider', id: pr.id } : null;
  };
  const [choice, setChoice] = useState<Choice | null>(defaultChoice);
  // Providers report availability asynchronously after boot; pick a default once they do.
  useEffect(() => {
    if (!choice || (choice.kind === 'persona' ? !personas.some((p) => p.id === choice.id) : !providerById.has(choice.id))) setChoice(defaultChoice());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, personas]);

  const persona = choice?.kind === 'persona' ? personas.find((p) => p.id === choice.id) : undefined;
  const providerId = persona?.provider ?? (choice?.kind === 'provider' ? choice.id : '');
  const provider = providerById.get(providerId);

  // Model and mode only go to the server when the user changes them, so persona defaults apply.
  const [model, setModel] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState(false);
  const [mode, setMode] = useState<ApprovalMode | null>(null);
  const [handle, setHandle] = useState('');
  const [worktree, setWorktree] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const { uploads, add, remove } = useUploads();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useAutosize(promptRef, prompt, 360);

  useEffect(() => {
    setModel(null);
    setCustomModel(false);
    setMode(null);
  }, [choice?.kind, choice?.id]);

  const effectiveModel = model ?? persona?.model ?? '';
  const effectiveMode = mode ?? persona?.mode ?? 'ask';
  const uploading = uploads.some((u) => u.status === 'uploading');
  const providerOk = !!provider?.available;
  const canStart = !!projectId && !!choice && providerOk && !busy && !uploading;

  const start = async () => {
    if (!canStart || !choice) return;
    setBusy(true);
    const body: CreateThreadBody = { projectId };
    if (choice.kind === 'persona') body.personaId = choice.id;
    else body.provider = choice.id;
    if (model !== null) body.model = model;
    if (mode !== null) body.mode = mode;
    if (handle.trim()) body.handle = handle.trim();
    if (worktree) body.worktree = true;
    if (prompt.trim()) body.prompt = prompt;
    const ids = uploads.filter((u) => u.status === 'done' && u.attachment).map((u) => u.attachment!.id);
    if (ids.length) body.attachmentIds = ids;
    const t = await attempt(api.createThread(body));
    setBusy(false);
    if (t) {
      try {
        localStorage.setItem(LAST_KEY, JSON.stringify({ choice, projectId }));
      } catch {
        /* storage unavailable */
      }
      openView({ kind: 'thread', threadId: t.id }, { pane: paneIndex });
    }
  };

  const noProviders = providers.length > 0 && !providers.some((p) => p.available);
  const checking = providers.length === 0 || providers.every((p) => !p.available && p.error === 'Checking…');

  if (!projects.length) {
    return (
      <>
        <PaneBar paneIndex={paneIndex}>
          <span className="pane-title">New thread</span>
        </PaneBar>
        <div className="page-scroll">
          <div className="page page-narrow">
            <h1 className="page-h1">Add a project first</h1>
            <p className="page-lede">Threads run inside a project folder. Pick the folder of a repository you want the agents to work in.</p>
            <div style={{ marginTop: 'var(--sp-4)' }}>
              <AddProject autoFocus size="lg" onDone={(p) => p && setProjectId(p.id)} />
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PaneBar paneIndex={paneIndex}>
        <span className="pane-title">New thread</span>
      </PaneBar>
      <div className="page-scroll">
        <form
          className="page page-narrow nt"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          {noProviders && !checking ? (
            <div className="callout is-warn">
              <CircleAlert {...ICON_SM} />
              <div>
                No agent CLI is available. Install and sign in to Claude Code or Codex, then refresh.{' '}
                <button type="button" className="link-btn" onClick={() => void attempt(api.refreshProviders())}>
                  <RefreshCw size={12} strokeWidth={1.5} /> Refresh
                </button>
              </div>
            </div>
          ) : null}

          <Field label="Project" htmlFor="nt-project">
            <select id="nt-project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          <fieldset className="nt-agents">
            <legend className="field-label">Agent</legend>
            <div className="nt-cards" role="radiogroup">
              {personas.map((p) => (
                <AgentCard
                  key={p.id}
                  persona={p}
                  provider={providerById.get(p.provider)}
                  selected={choice?.kind === 'persona' && choice.id === p.id}
                  onSelect={() => setChoice({ kind: 'persona', id: p.id })}
                />
              ))}
            </div>
            <div className="nt-plain" role="radiogroup" aria-label="Without a persona">
              <span className="nt-plain-label">No persona</span>
              {providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={choice?.kind === 'provider' && choice.id === p.id}
                  className={`nt-plain-opt${choice?.kind === 'provider' && choice.id === p.id ? ' is-on' : ''}`}
                  disabled={!p.available}
                  data-tip={p.available ? `${p.label}${p.version ? ' ' + p.version : ''}` : p.error ?? 'Not available'}
                  onClick={() => setChoice({ kind: 'provider', id: p.id })}
                >
                  <span className="nt-dot" style={{ background: `oklch(62% 0.12 ${providerHue(p.id)})` }} />
                  {p.label}
                </button>
              ))}
            </div>
            {provider && !provider.available ? (
              <div className="field-error">
                {provider.label}: {provider.error ?? 'not available'}
              </div>
            ) : null}
          </fieldset>

          <div className="form-grid">
            <Field label="Model" htmlFor="nt-model" hint={!effectiveModel && provider ? `Default: ${provider.defaultModel || 'provider default'}` : undefined}>
              {customModel ? (
                <input
                  id="nt-model"
                  className="input mono"
                  autoFocus
                  placeholder="model id"
                  value={model ?? ''}
                  onChange={(e) => setModel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setCustomModel(false);
                      setModel(null);
                    }
                  }}
                />
              ) : (
                <select
                  id="nt-model"
                  className="select"
                  value={effectiveModel}
                  onChange={(e) => {
                    if (e.target.value === '__custom') {
                      setCustomModel(true);
                      setModel('');
                    } else setModel(e.target.value);
                  }}
                >
                  <option value="">Default</option>
                  {(provider?.models ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                  {effectiveModel && !(provider?.models ?? []).some((m) => m.id === effectiveModel) ? <option value={effectiveModel}>{effectiveModel}</option> : null}
                  <option value="__custom">Other…</option>
                </select>
              )}
            </Field>
            <Field label="Handle" htmlFor="nt-handle" hint="Other agents reach this thread by its handle.">
              <input
                id="nt-handle"
                className="input mono"
                value={handle}
                placeholder={persona?.handle ?? providerId ?? 'handle'}
                onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              />
            </Field>
            <div className="field">
              <span className="field-label">Approval mode</span>
              <div>
                <Segmented label="Approval mode" value={effectiveMode} options={MODE_OPTIONS} onChange={setMode} />
              </div>
              <div className="field-hint">{MODE_OPTIONS.find((m) => m.value === effectiveMode)?.tip.replace(/^\w+: /, '')}</div>
            </div>
            <div className="field">
              <span className="field-label">Isolation</span>
              <label className="nt-switch">
                <Switch checked={worktree} onChange={setWorktree} label="Run in a new git worktree" />
                <span>Run in a new git worktree</span>
              </label>
              <div className="field-hint">Keeps its edits on a separate branch.</div>
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="nt-prompt">
              First message
            </label>
            <div className="nt-prompt">
              <UploadChips uploads={uploads} onRemove={remove} />
              <textarea
                id="nt-prompt"
                ref={promptRef}
                className="composer-input"
                rows={4}
                value={prompt}
                placeholder="What should it do? You can also start empty."
                onChange={(e) => setPrompt(e.target.value)}
                onPaste={(e) => {
                  const files = filesFromClipboard(e);
                  if (files.length) {
                    e.preventDefault();
                    add(files);
                  }
                }}
                onDragOver={(e) => e.dataTransfer?.types.includes('Files') && e.preventDefault()}
                onDrop={(e) => {
                  const files = [...(e.dataTransfer?.files ?? [])];
                  if (files.length) {
                    e.preventDefault();
                    add(files);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
                    e.preventDefault();
                    void start();
                  }
                }}
              />
            </div>
          </div>

          <div className="form-actions">
            <Button type="submit" variant="primary" size="lg" disabled={!canStart} busy={busy}>
              {uploading ? 'Uploading…' : 'Start thread'}
            </Button>
            <span className="nt-kbd">
              <Kbd combo="mod+enter" />
            </span>
          </div>
        </form>
      </div>
    </>
  );
}

function AgentCard({ persona: p, provider, selected, onSelect }: { persona: Persona; provider: ProviderInfo | undefined; selected: boolean; onSelect: () => void }) {
  const ok = !!provider?.available;
  const modelLabel = provider?.models.find((m) => m.id === p.model)?.label ?? (p.model || 'default model');
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`nt-card${selected ? ' is-on' : ''}`}
      disabled={!ok}
      onClick={onSelect}
      data-tip={!ok ? provider?.error ?? `${p.provider} is not available` : undefined}
    >
      <Glyph glyph={p.glyph} hue={p.hue} size="lg" />
      <span className="nt-card-text">
        <span className="nt-card-name">
          {p.name} <span className="mono nt-card-handle">@{p.handle}</span>
        </span>
        <span className="nt-card-desc">{ok ? p.description || `${provider?.label ?? p.provider} · ${modelLabel}` : provider?.error ?? 'Not available'}</span>
        <span className="nt-card-meta">
          {provider?.label ?? p.provider} · <span className="mono">{modelLabel}</span>
        </span>
      </span>
    </button>
  );
}
