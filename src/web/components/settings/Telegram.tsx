import { useEffect, useMemo, useRef, useState } from 'react';
import type { Settings } from '../../../shared/protocol';
import { threadTitle, useApp } from '../../state/app';
import { api, attempt } from '../../state/api';
import { Button, Field, Switch } from '../ui';
import { SectionHead, SettingRow, useBusy } from './common';

type Tg = Settings['telegram'];

const parseIds = (raw: string): { ids: number[]; error: string | null } => {
  const parts = raw
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const bad = parts.filter((p) => !/^-?\d+$/.test(p));
  if (bad.length) return { ids: [], error: `Not a chat id: ${bad.join(', ')}` };
  return { ids: parts.map(Number), error: null };
};

const STATUS_TEXT = { off: 'Off', connecting: 'Connecting…', online: 'Online', error: 'Error' } as const;

export function TelegramSection() {
  const saved = useApp((s) => s.settings.telegram);
  const status = useApp((s) => s.telegram);
  const threads = useApp((s) => s.threads);
  const [d, setD] = useState<Tg>(saved);
  const [idsRaw, setIdsRaw] = useState(saved.allowedChatIds.join(', '));
  const [busy, run] = useBusy();
  const [testing, runTest] = useBusy();
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  // Pick up changes saved elsewhere when there are no local edits.
  const savedKey = JSON.stringify(saved);
  const prevSaved = useRef(saved);
  useEffect(() => {
    const prev = prevSaved.current;
    prevSaved.current = saved;
    const untouched = JSON.stringify(d) === JSON.stringify(prev) && idsRaw === prev.allowedChatIds.join(', ');
    if (untouched) {
      setD(saved);
      setIdsRaw(saved.allowedChatIds.join(', '));
    }
  }, [savedKey]);

  const ids = parseIds(idsRaw);
  const dirty =
    JSON.stringify({ ...d, allowedChatIds: null }) !== JSON.stringify({ ...saved, allowedChatIds: null }) ||
    ids.error !== null ||
    ids.ids.join(',') !== saved.allowedChatIds.join(',');
  const set = <K extends keyof Tg>(k: K, v: Tg[K]) => setD((x) => ({ ...x, [k]: v }));

  const liveThreads = useMemo(
    () => threads.filter((t) => !t.archived || t.id === d.defaultThreadId).sort((a, b) => a.handle.localeCompare(b.handle)),
    [threads, d.defaultThreadId],
  );

  const save = () =>
    run(async () => {
      if (ids.error) return;
      const r = await attempt(api.putSettings({ telegram: { ...d, allowedChatIds: ids.ids } }), 'Telegram settings saved');
      if (r) {
        // The token comes back masked; adopt the server's view so the field shows that.
        prevSaved.current = r.telegram;
        setD(r.telegram);
        setIdsRaw(r.telegram.allowedChatIds.join(', '));
      }
    });

  const runTestNow = () =>
    runTest(async () => {
      setTest(null);
      const r = await attempt(api.testTelegram(d.botToken));
      if (!r) return;
      setTest(r.ok ? { ok: true, text: `Connected as @${r.botName ?? 'bot'}` } : { ok: false, text: r.error ?? 'Test failed' });
    });

  return (
    <section className="section">
      <SectionHead
        title="Telegram"
        desc="Message your threads from Telegram and approve requests from your phone. Create a bot with @BotFather and paste its token."
      />

      <div className={`tg-status tg-${status.status}`}>
        <span className="tg-dot" />
        <span>{STATUS_TEXT[status.status]}</span>
        {status.status === 'online' && status.botName ? <span className="mono muted">@{status.botName}</span> : null}
        {status.error ? <span className="tg-error">{status.error}</span> : null}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <SettingRow label="Enabled" desc="Run the bot while Jogger is running.">
          <Switch label="Enable Telegram" checked={d.enabled} onChange={(v) => set('enabled', v)} />
        </SettingRow>
        <SettingRow label="Forward approvals" desc="Send approval requests to your allowed chats with Allow and Deny buttons.">
          <Switch label="Forward approvals" checked={d.forwardApprovals} onChange={(v) => set('forwardApprovals', v)} />
        </SettingRow>

        <div className="form-grid tg-fields">
          <div className="span-2">
            <Field label="Bot token" htmlFor="tg-token" hint="Stored on this machine only. Shown masked once saved.">
              <input
                id="tg-token"
                className="input mono"
                value={d.botToken}
                autoComplete="off"
                spellCheck={false}
                placeholder="123456:ABC-DEF…"
                onFocus={(e) => e.target.select()}
                onChange={(e) => set('botToken', e.target.value.trim())}
              />
            </Field>
          </div>
          <Field label="Allowed chat ids" htmlFor="tg-ids" error={ids.error} hint="Comma-separated. Messages from other chats are ignored.">
            <input
              id="tg-ids"
              className="input mono"
              value={idsRaw}
              placeholder="123456789"
              inputMode="numeric"
              onChange={(e) => setIdsRaw(e.target.value)}
            />
          </Field>
          <Field label="Default thread" htmlFor="tg-thread" hint="Where messages without an @handle go.">
            <select id="tg-thread" className="select" value={d.defaultThreadId ?? ''} onChange={(e) => set('defaultThreadId', e.target.value || null)}>
              <option value="">None</option>
              {liveThreads.map((t) => (
                <option key={t.id} value={t.id}>
                  @{t.handle} · {threadTitle(t)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="form-actions">
          <Button type="submit" variant="primary" busy={busy} disabled={!!ids.error || !dirty}>
            Save
          </Button>
          <Button busy={testing} onClick={() => void runTestNow()} tip="Checks the token in the field with Telegram">
            Test
          </Button>
          {test ? <span className={`tg-test ${test.ok ? 'is-ok' : 'is-error'}`}>{test.text}</span> : null}
        </div>
      </form>
    </section>
  );
}
