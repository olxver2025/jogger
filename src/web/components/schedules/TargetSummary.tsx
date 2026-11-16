import type { Schedule } from '../../../shared/protocol';
import { useApp } from '../../state/app';
import { providerHue } from '../../lib/hue';
import { Glyph } from '../ui';

/** One line describing where a schedule's prompt goes. */
export function TargetSummary({ s }: { s: Schedule }) {
  const thread = useApp((st) => (s.threadId ? st.threads.find((t) => t.id === s.threadId) : undefined));
  const persona = useApp((st) => (s.personaId ? st.personas.find((p) => p.id === s.personaId) : undefined));
  const provider = useApp((st) => (s.provider ? st.providers.find((p) => p.id === s.provider) : undefined));

  if (s.threadId) {
    return thread ? (
      <span className="sched-target">
        Sends to <span className="mono">@{thread.handle}</span>
      </span>
    ) : (
      <span className="sched-target is-missing">Target thread was deleted</span>
    );
  }
  if (persona) {
    return (
      <span className="sched-target">
        <Glyph glyph={persona.glyph} hue={persona.hue} size="sm" />
        {persona.name}
        {s.model ? <span className="mono">· {s.model}</span> : null}
        <span className="sched-target-note">new thread each run</span>
      </span>
    );
  }
  const pid = s.provider ?? 'claude';
  return (
    <span className="sched-target">
      <Glyph glyph={(pid[0] ?? '?').toUpperCase()} hue={providerHue(pid)} size="sm" />
      {provider?.label ?? pid}
      <span className="mono">· {s.model || 'default'}</span>
      <span className="sched-target-note">new thread each run</span>
    </span>
  );
}
