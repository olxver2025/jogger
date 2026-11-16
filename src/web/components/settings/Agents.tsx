import { useEffect, useState } from 'react';
import { useApp } from '../../state/app';
import { Segmented, Switch } from '../ui';
import { SectionHead, SettingRow, saveSettings } from './common';

export function AgentsSection() {
  const s = useApp((st) => st.settings);
  const [depth, setDepth] = useState(String(s.maxAgentDepth));
  useEffect(() => setDepth(String(s.maxAgentDepth)), [s.maxAgentDepth]);

  const commitDepth = () => {
    const n = Math.round(Number(depth));
    if (!Number.isFinite(n) || n < 1 || n > 10) {
      setDepth(String(s.maxAgentDepth));
      return;
    }
    if (n !== s.maxAgentDepth) void saveSettings({ maxAgentDepth: n });
  };

  return (
    <section className="section">
      <SectionHead title="Agents" desc="How agents run when you are not watching, and how far they can call each other." />

      <SettingRow
        label="Unattended approvals"
        desc="Approvals from schedules, Telegram and helper threads nobody is watching. Queue waits for you; deny refuses them straight away so the run can carry on."
      >
        <Segmented
          label="Unattended approvals"
          value={s.unattendedApprovals}
          onChange={(unattendedApprovals) => void saveSettings({ unattendedApprovals })}
          options={[
            { value: 'queue', label: 'Queue' },
            { value: 'deny', label: 'Deny' },
          ]}
        />
      </SettingRow>

      <SettingRow label="Max agent depth" desc="How many hops a chain of agents asking agents may go before Jogger refuses the next request. 1 to 10.">
        <input
          type="number"
          className="input num depth-input"
          min={1}
          max={10}
          value={depth}
          aria-label="Max agent depth"
          onChange={(e) => setDepth(e.target.value)}
          onBlur={commitDepth}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </SettingRow>

      <SettingRow
        label="Strip API keys"
        desc={
          <>
            Removes <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code> and similar from agent processes, so Claude Code and Codex use your
            subscription login instead of billing API credits. Applies to sessions started after the change.
          </>
        }
      >
        <Switch label="Strip API keys" checked={s.stripApiKeys} onChange={(stripApiKeys) => void saveSettings({ stripApiKeys })} />
      </SettingRow>
    </section>
  );
}
