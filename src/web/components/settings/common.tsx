import { useState, type ReactNode } from 'react';
import type { Settings } from '../../../shared/protocol';
import { api, attempt } from '../../state/api';

/** Section heading shared by every settings page. */
export function SectionHead({ title, desc, action }: { title: string; desc?: ReactNode; action?: ReactNode }) {
  return (
    <div className="section-head settings-head">
      <div className="setting-text">
        <h2 className="page-h1">{title}</h2>
        {desc ? <p className="section-desc">{desc}</p> : null}
      </div>
      {action ? <div className="setting-control">{action}</div> : null}
    </div>
  );
}

export function SettingRow({ label, desc, children }: { label: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {desc ? <div className="setting-desc">{desc}</div> : null}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

/** PUT a partial settings patch. The server rebroadcasts the result over the WebSocket. */
export function saveSettings(patch: Partial<Settings>) {
  return attempt(api.putSettings(patch));
}

/** Small hook for "saving…" state around one async action. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async <T,>(p: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try {
      return await p();
    } finally {
      setBusy(false);
    }
  };
  return [busy, run] as const;
}

export const MODE_OPTIONS = [
  { value: 'ask' as const, label: 'Ask', tip: 'Ask: approve edits and commands' },
  { value: 'auto' as const, label: 'Auto', tip: 'Auto: edits allowed, risky commands ask' },
  { value: 'full' as const, label: 'Full', tip: 'Full: never ask' },
];
