import { useMemo, useState } from 'react';
import { Play, Trash2 } from 'lucide-react';
import type { ApprovalMode, Schedule } from '../../../shared/protocol';
import { api, attempt } from '../../state/api';
import { getApp, threadTitle, useApp } from '../../state/app';
import { CRON_PRESETS, describeCron } from '../../lib/cron';
import { Button, Field, Segmented, Switch, confirmDialog } from '../ui';

const MODE_OPTIONS: { value: ApprovalMode; label: string; tip: string }[] = [
  { value: 'ask', label: 'Ask', tip: 'Ask: approve edits and commands' },
  { value: 'auto', label: 'Auto', tip: 'Auto: edits allowed, risky commands ask' },
  { value: 'full', label: 'Full', tip: 'Full: never ask' },
];

interface Draft {
  id?: string;
  name: string;
  projectId: string;
  cron: string;
  prompt: string;
  target: 'thread' | 'new';
  threadId: string;
  /** "persona:<id>" or "provider:<id>" */
  agent: string;
  model: string;
  mode: ApprovalMode;
  enabled: boolean;
}

function defaultAgent(): string {
  const { personas, providers } = getApp();
  const ok = new Set(providers.filter((p) => p.available).map((p) => p.id));
  const persona = personas.find((p) => ok.has(p.provider)) ?? personas[0];
  if (persona) return `persona:${persona.id}`;
  const prov = providers.find((p) => p.available) ?? providers[0];
  return prov ? `provider:${prov.id}` : '';
}

function toDraft(s: Schedule | undefined): Draft {
  if (!s) {
    const agent = defaultAgent();
    const persona = agent.startsWith('persona:') ? getApp().personas.find((p) => `persona:${p.id}` === agent) : undefined;
    return {
      name: '',
      projectId: getApp().projects[0]?.id ?? '',
      cron: '0 9 * * 1-5',
      prompt: '',
      target: 'new',
      threadId: '',
      agent,
      model: '',
      mode: persona?.mode ?? 'ask',
      enabled: true,
    };
  }
  return {
    id: s.id,
    name: s.name,
    projectId: s.projectId,
    cron: s.cron,
    prompt: s.prompt,
    target: s.threadId ? 'thread' : 'new',
    threadId: s.threadId ?? '',
    agent: s.personaId ? `persona:${s.personaId}` : s.provider ? `provider:${s.provider}` : defaultAgent(),
    model: s.model ?? '',
    mode: s.mode,
    enabled: s.enabled,
  };
}

export function ScheduleEditor({
  paneIndex,
  schedule,
  onSaved,
  onDeleted,
  onCancel,
}: {
  paneIndex: number;
  schedule: Schedule | undefined;
  onSaved: (id: string) => void;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(() => toDraft(schedule));
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((cur) => ({ ...cur, [k]: v }));

  const projects = useApp((s) => s.projects);
  const allThreads = useApp((s) => s.threads);
  const personas = useApp((s) => s.personas);
  const providers = useApp((s) => s.providers);

  const threads = useMemo(
    () =>
      allThreads
        .filter((t) => t.projectId === d.projectId && (!t.archived || t.id === d.threadId))
        .sort((a, b) => b.lastEventAt - a.lastEventAt),
    [allThreads, d.projectId, d.threadId],
  );

  const [agentKind, agentId] = d.agent.split(':') as ['persona' | 'provider', string];
  const persona = agentKind === 'persona' ? personas.find((p) => p.id === agentId) : undefined;
  const providerId = agentKind === 'provider' ? agentId : persona?.provider;
  const provider = providers.find((p) => p.id === providerId);
  const plain = describeCron(d.cron);
  const id = `sched-${paneIndex}`;

  const missing =
    !d.projectId
      ? 'Pick a project.'
      : !d.cron.trim()
        ? 'Add a cron expression.'
        : !d.prompt.trim()
          ? 'Write the prompt to send.'
          : d.target === 'thread' && !d.threadId
            ? 'Pick the thread to send to.'
            : d.target === 'new' && !d.agent
              ? 'Pick who runs it.'
              : null;

  const save = async () => {
    const body: Partial<Schedule> = {
      id: d.id,
      name: d.name.trim(),
      projectId: d.projectId,
      cron: d.cron.trim(),
      prompt: d.prompt,
      mode: d.mode,
      enabled: d.enabled,
    };
    // The server keeps previous values for undefined fields, so clear the unused target explicitly.
    if (d.target === 'thread') {
      Object.assign(body, { threadId: d.threadId, personaId: null, provider: null, model: null });
    } else {
      Object.assign(body, {
        threadId: null,
        personaId: agentKind === 'persona' ? agentId : null,
        provider: agentKind === 'provider' ? agentId : null,
        model: d.model.trim() || null,
      });
    }
    setSaving(true);
    const saved = await attempt(api.putSchedule(body), d.id ? 'Schedule saved' : 'Schedule created');
    setSaving(false);
    if (saved) {
      setD((cur) => ({ ...cur, id: saved.id, name: saved.name }));
      onSaved(saved.id);
    }
  };

  const remove = async () => {
    if (!d.id) return;
    const ok = await confirmDialog({
      title: `Delete “${d.name || 'this schedule'}”?`,
      body: 'It stops running. Threads it already started are kept.',
      confirm: 'Delete schedule',
      danger: true,
    });
    if (!ok) return;
    if ((await attempt(api.deleteSchedule(d.id))) !== undefined) onDeleted();
  };

  const runNow = async () => {
    if (!d.id) return;
    setRunning(true);
    await attempt(api.runSchedule(d.id), 'Started');
    setRunning(false);
  };

  return (
    <form
      className="sched-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!missing && !saving) void save();
      }}
    >
      <div className="sched-editor-head">
        <h2 className="page-h1">{d.id ? schedule?.name || d.name || 'Schedule' : 'New schedule'}</h2>
        {d.id ? (
          <Button size="sm" icon={Play} busy={running} onClick={() => void runNow()} tip="Run it once now, outside its schedule">
            Run now
          </Button>
        ) : null}
      </div>

      <div className="form-grid">
        <Field label="Name" htmlFor={`${id}-name`}>
          <input
            id={`${id}-name`}
            className="input"
            value={d.name}
            placeholder="Morning triage"
            onChange={(e) => set('name', e.target.value)}
          />
        </Field>
        <Field label="Project" htmlFor={`${id}-project`}>
          <select
            id={`${id}-project`}
            className="select"
            value={d.projectId}
            onChange={(e) => setD((cur) => ({ ...cur, projectId: e.target.value, threadId: '' }))}
          >
            {!d.projectId ? <option value="">Pick a project</option> : null}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>

        <div className="span-2 field">
          <label className="field-label" htmlFor={`${id}-cron`}>
            When
          </label>
          <div className="sched-cron-row">
            <input
              id={`${id}-cron`}
              className="input mono sched-cron-input"
              value={d.cron}
              spellCheck={false}
              autoComplete="off"
              placeholder="0 9 * * 1-5"
              onChange={(e) => set('cron', e.target.value)}
            />
            <div className="sched-presets" role="group" aria-label="Common schedules">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.cron}
                  type="button"
                  className={`sched-chip${d.cron.trim() === p.cron ? ' is-on' : ''}`}
                  aria-pressed={d.cron.trim() === p.cron}
                  onClick={() => set('cron', p.cron)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className={`field-hint${plain ? '' : ' sched-cron-unknown'}`}>
            {plain ?? 'Custom schedule — check the expression (minute hour day month weekday)'}
          </div>
        </div>

        <div className="span-2">
          <Field label="Prompt" htmlFor={`${id}-prompt`}>
            <textarea
              id={`${id}-prompt`}
              className="textarea"
              rows={5}
              value={d.prompt}
              placeholder="Check the open issues labelled bug and summarise anything new since yesterday."
              onChange={(e) => set('prompt', e.target.value)}
            />
          </Field>
        </div>

        <div className="span-2 field">
          <span className="field-label">Send to</span>
          <Segmented
            label="Send to"
            value={d.target}
            onChange={(v) => set('target', v)}
            options={[
              { value: 'new', label: 'New thread each run' },
              { value: 'thread', label: 'Existing thread' },
            ]}
          />
        </div>

        {d.target === 'thread' ? (
          <div className="span-2">
            <Field
              label="Thread"
              htmlFor={`${id}-thread`}
              hint={threads.length ? 'The prompt arrives as a scheduled message in this thread.' : 'This project has no threads yet.'}
            >
              <select id={`${id}-thread`} className="select" value={d.threadId} onChange={(e) => set('threadId', e.target.value)}>
                <option value="">Pick a thread</option>
                {threads.map((t) => (
                  <option key={t.id} value={t.id}>
                    @{t.handle} · {threadTitle(t)}
                    {t.archived ? ' (archived)' : ''}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : (
          <>
            <Field label="Agent" htmlFor={`${id}-agent`}>
              <select
                id={`${id}-agent`}
                className="select"
                value={d.agent}
                onChange={(e) => {
                  const v = e.target.value;
                  const p = v.startsWith('persona:') ? personas.find((x) => `persona:${x.id}` === v) : undefined;
                  setD((cur) => ({ ...cur, agent: v, model: '', mode: p?.mode ?? cur.mode }));
                }}
              >
                {personas.length ? (
                  <optgroup label="Personas">
                    {personas.map((p) => {
                      const prov = providers.find((x) => x.id === p.provider);
                      return (
                        <option key={p.id} value={`persona:${p.id}`} disabled={prov ? !prov.available : false}>
                          {p.name}
                          {prov && !prov.available ? ' (unavailable)' : ''}
                        </option>
                      );
                    })}
                  </optgroup>
                ) : null}
                <optgroup label="Providers">
                  {providers.map((p) => (
                    <option key={p.id} value={`provider:${p.id}`} disabled={!p.available}>
                      {p.label}
                      {!p.available ? ' (unavailable)' : ''}
                    </option>
                  ))}
                </optgroup>
              </select>
            </Field>
            <Field
              label="Model"
              htmlFor={`${id}-model`}
              hint={persona ? `Blank uses ${persona.name}'s model${persona.model ? ` (${persona.model})` : ''}.` : 'Blank uses the provider default.'}
            >
              <input
                id={`${id}-model`}
                className="input mono"
                list={`${id}-models`}
                value={d.model}
                spellCheck={false}
                autoComplete="off"
                placeholder={persona?.model || provider?.defaultModel || 'default'}
                onChange={(e) => set('model', e.target.value)}
              />
              <datalist id={`${id}-models`}>
                {(provider?.models ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </datalist>
            </Field>
            <div className="span-2 field">
              <span className="field-label">Approvals</span>
              <Segmented label="Approval mode" value={d.mode} onChange={(v) => set('mode', v)} options={MODE_OPTIONS} />
              <div className="field-hint">Nobody may be watching a scheduled run. Unattended approvals follow Settings → Agents.</div>
            </div>
          </>
        )}

        <div className="span-2 setting sched-enabled">
          <div className="setting-text">
            <div className="setting-label">Enabled</div>
            <div className="setting-desc">Paused schedules keep their settings but never fire.</div>
          </div>
          <div className="setting-control">
            <Switch checked={d.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />
          </div>
        </div>
      </div>

      <div className="form-actions">
        <Button type="submit" variant="primary" busy={saving} disabled={!!missing}>
          {d.id ? 'Save changes' : 'Create schedule'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {d.id ? 'Close' : 'Cancel'}
        </Button>
        {missing ? <span className="field-hint">{missing}</span> : null}
        <span className="spacer" />
        {d.id ? (
          <Button variant="ghost" icon={Trash2} onClick={() => void remove()}>
            Delete
          </Button>
        ) : null}
      </div>
    </form>
  );
}
