import { useState } from 'react';
import { ArrowLeft, Plus } from 'lucide-react';
import type { ApprovalMode, Persona } from '../../../shared/protocol';
import { useApp } from '../../state/app';
import { api, attempt } from '../../state/api';
import { Button, EmptyState, Field, Glyph, Segmented, confirmDialog } from '../ui';
import { MODE_OPTIONS, SectionHead, useBusy } from './common';

type Draft = Omit<Persona, 'id'> & { id?: string };

function blank(provider: string): Draft {
  return { name: '', handle: '', provider, model: '', mode: 'ask', systemPrompt: '', glyph: '', hue: 200, description: '' };
}

export function PersonasSection() {
  const personas = useApp((s) => s.personas);
  const providers = useApp((s) => s.providers);
  const [editing, setEditing] = useState<Draft | null>(null);

  if (editing) return <PersonaEditor key={editing.id ?? 'new'} initial={editing} onDone={() => setEditing(null)} />;

  const providerLabel = (id: string) => providers.find((p) => p.id === id)?.label ?? id;
  const defaultProvider = providers.find((p) => p.available)?.id ?? providers[0]?.id ?? 'claude';

  return (
    <section className="section">
      <SectionHead
        title="Personas"
        desc="Reusable agent setups: a provider, model, approval mode and system prompt. Other agents can start a persona as a helper by its handle."
        action={
          <Button size="sm" icon={Plus} onClick={() => setEditing(blank(defaultProvider))}>
            New persona
          </Button>
        }
      />
      {personas.length === 0 ? (
        <div className="list">
          <EmptyState title="No personas">Create one to start threads with a saved provider, model and prompt.</EmptyState>
        </div>
      ) : (
        <div className="list">
          {personas
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((p) => (
              <button key={p.id} type="button" className="list-row persona-row" onClick={() => setEditing({ ...p })}>
                <Glyph glyph={p.glyph || p.name[0] || '?'} hue={p.hue} />
                <div className="persona-main">
                  <div className="persona-name">
                    <span>{p.name}</span>
                    <span className="mono muted">@{p.handle}</span>
                  </div>
                  {p.description ? <div className="persona-desc">{p.description}</div> : null}
                </div>
                <span className="persona-meta muted">
                  {providerLabel(p.provider)}
                  {p.model ? <span className="mono"> · {p.model}</span> : null}
                </span>
              </button>
            ))}
        </div>
      )}
    </section>
  );
}

function PersonaEditor({ initial, onDone }: { initial: Draft; onDone: () => void }) {
  const providers = useApp((s) => s.providers);
  const [d, setD] = useState<Draft>(initial);
  const [busy, run] = useBusy();
  const [deleting, runDelete] = useBusy();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const provider = providers.find((p) => p.id === d.provider);
  const isNew = !d.id;
  const nameMissing = !d.name.trim();

  const save = () =>
    run(async () => {
      const saved = await attempt(api.putPersona(d), isNew ? 'Persona created' : 'Persona saved');
      if (saved) onDone();
    });

  const remove = async () => {
    if (!d.id) return;
    const ok = await confirmDialog({
      title: `Delete ${d.name || 'this persona'}?`,
      body: 'Existing threads keep running with their current settings. This cannot be undone.',
      confirm: 'Delete persona',
      danger: true,
    });
    if (!ok) return;
    await runDelete(async () => {
      const r = await attempt(api.deletePersona(d.id!), 'Persona deleted');
      if (r !== undefined) onDone();
    });
  };

  const listId = `persona-models-${d.id ?? 'new'}`;

  return (
    <section className="section">
      <div className="editor-back">
        <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={onDone}>
          Personas
        </Button>
      </div>
      <div className="persona-editor-head">
        <Glyph glyph={d.glyph || d.name[0] || '?'} hue={d.hue} size="lg" />
        <div className="setting-text">
          <h2 className="page-h1">{isNew ? 'New persona' : d.name || 'Untitled persona'}</h2>
          {d.handle || d.name ? <div className="mono muted persona-handle-preview">@{(d.handle || d.name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')}</div> : null}
        </div>
      </div>

      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (!nameMissing) void save();
        }}
      >
        <Field label="Name" htmlFor="pe-name">
          <input id="pe-name" className="input" value={d.name} autoFocus={isNew} onChange={(e) => set('name', e.target.value)} placeholder="Reviewer" />
        </Field>
        <Field label="Handle" htmlFor="pe-handle" hint="Defaults to the name. Lowercase letters, digits and dashes.">
          <input id="pe-handle" className="input mono" value={d.handle} onChange={(e) => set('handle', e.target.value)} placeholder="reviewer" />
        </Field>

        <Field label="Provider" htmlFor="pe-provider" hint={provider && !provider.available ? provider.error ?? 'Not available on this machine.' : undefined}>
          <select id="pe-provider" className="select" value={d.provider} onChange={(e) => set('provider', e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.available ? '' : ' (unavailable)'}
              </option>
            ))}
            {!providers.some((p) => p.id === d.provider) ? <option value={d.provider}>{d.provider}</option> : null}
          </select>
        </Field>
        <Field label="Model" htmlFor="pe-model" hint={`Blank uses the provider default${provider?.defaultModel ? ` (${provider.defaultModel})` : ''}.`}>
          <input
            id="pe-model"
            className="input mono"
            list={listId}
            value={d.model}
            onChange={(e) => set('model', e.target.value)}
            placeholder={provider?.defaultModel || 'default'}
          />
          <datalist id={listId}>
            {provider?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
        </Field>

        <Field label="Approval mode">
          <div>
            <Segmented<ApprovalMode> label="Approval mode" value={d.mode} options={MODE_OPTIONS} onChange={(v) => set('mode', v)} />
          </div>
        </Field>
        <div className="form-grid-pair">
          <Field label="Glyph" htmlFor="pe-glyph">
            <input id="pe-glyph" className="input glyph-input" maxLength={2} value={d.glyph} onChange={(e) => set('glyph', e.target.value)} placeholder={d.name[0] ?? 'A'} />
          </Field>
          <Field label={<>Hue <span className="num">{Math.round(d.hue)}°</span></>} htmlFor="pe-hue">
            <input
              id="pe-hue"
              type="range"
              min={0}
              max={360}
              value={d.hue}
              className="hue-slider hue-slider-persona"
              onChange={(e) => set('hue', Number(e.target.value))}
            />
          </Field>
        </div>

        <div className="span-2">
          <Field label="Description" htmlFor="pe-desc" hint="Shown on the new-thread form and to other agents choosing a helper.">
            <input id="pe-desc" className="input" value={d.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
        </div>
        <div className="span-2">
          <Field label="System prompt" htmlFor="pe-prompt" hint="Added to the agent's instructions for every thread started from this persona.">
            <textarea id="pe-prompt" className="textarea mono" rows={8} value={d.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} />
          </Field>
        </div>

        <div className="span-2 form-actions">
          <Button type="submit" variant="primary" busy={busy} disabled={nameMissing}>
            {isNew ? 'Create persona' : 'Save persona'}
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <span className="spacer" />
          {!isNew ? (
            <Button variant="ghost" className="btn-danger-ghost" busy={deleting} onClick={() => void remove()}>
              Delete
            </Button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
