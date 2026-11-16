import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { DEFAULT_KEYBINDINGS, KEYBINDING_LABELS } from '../../../shared/protocol';
import { useApp } from '../../state/app';
import { comboFromEvent } from '../../lib/keys';
import { Button, ICON_SM, Kbd } from '../ui';
import { SectionHead, saveSettings } from './common';

const IDS = Object.keys(KEYBINDING_LABELS);

export function KeybindingsSection() {
  const bindings = useApp((s) => s.settings.keybindings);
  const [recording, setRecording] = useState<string | null>(null);
  const combo = (id: string) => bindings[id] ?? DEFAULT_KEYBINDINGS[id] ?? '';

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecording(null);
        return;
      }
      const c = comboFromEvent(e);
      if (!c) return; // lone modifier: keep listening
      const id = recording;
      setRecording(null);
      if (c !== combo(id)) void saveSettings({ keybindings: { [id]: c } });
    };
    const cancel = () => setRecording(null);
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('blur', cancel);
    };
    // combo() reads the latest bindings through closure on each recording start
  }, [recording]);

  const counts = new Map<string, number>();
  for (const id of IDS) counts.set(combo(id), (counts.get(combo(id)) ?? 0) + 1);
  const anyChanged = IDS.some((id) => combo(id) !== DEFAULT_KEYBINDINGS[id]);

  return (
    <section className="section">
      <SectionHead
        title="Keybindings"
        desc="Click a shortcut, then press the new keys. Esc cancels. Mod is ⌘ on macOS and Ctrl elsewhere."
        action={
          anyChanged ? (
            <Button size="sm" variant="ghost" onClick={() => void saveSettings({ keybindings: { ...DEFAULT_KEYBINDINGS } })}>
              Reset all
            </Button>
          ) : null
        }
      />
      <div className="list">
        {IDS.map((id) => {
          const c = combo(id);
          const isRec = recording === id;
          const changed = c !== DEFAULT_KEYBINDINGS[id];
          const conflict = (counts.get(c) ?? 0) > 1;
          return (
            <div key={id} className={`list-row kb-row${isRec ? ' is-selected' : ''}`}>
              <div className="kb-label">
                <span>{KEYBINDING_LABELS[id]}</span>
                {conflict ? (
                  <span className="kb-conflict">
                    <TriangleAlert {...ICON_SM} /> Also used by another action
                  </span>
                ) : null}
              </div>
              {changed && !isRec ? (
                <Button size="sm" variant="ghost" onClick={() => void saveSettings({ keybindings: { [id]: DEFAULT_KEYBINDINGS[id] } })}>
                  Reset
                </Button>
              ) : null}
              <button
                type="button"
                className={`kb-combo${isRec ? ' is-recording' : ''}`}
                aria-label={`Change shortcut for ${KEYBINDING_LABELS[id]}`}
                onClick={() => setRecording(isRec ? null : id)}
              >
                {isRec ? <span className="kb-press">Press keys…</span> : c ? <Kbd combo={c} /> : <span className="muted">None</span>}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
