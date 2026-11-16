import { useRef } from 'react';
import { Plus } from 'lucide-react';
import type { Schedule } from '../../../shared/protocol';
import { api, attempt } from '../../state/api';
import { useApp } from '../../state/app';
import { openThread, openView } from '../../state/ui';
import { describeCron } from '../../lib/cron';
import { ago, dateTime } from '../../lib/format';
import { useNow, useScrollFade } from '../../lib/hooks';
import { Button, EmptyState, Switch } from '../ui';
import { PaneBar } from '../PaneBar';
import { ScheduleEditor } from './ScheduleEditor';
import { TargetSummary } from './TargetSummary';
import '../../styles/schedules.css';

export function SchedulesView({ paneIndex, scheduleId }: { paneIndex: number; scheduleId?: string | null }) {
  const schedules = useApp((s) => s.schedules);
  const hasProjects = useApp((s) => s.projects.length > 0);
  const layoutRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  useScrollFade(layoutRef);
  useScrollFade(listRef);
  useScrollFade(editorRef);

  const select = (id: string | null) => openView({ kind: 'schedules', scheduleId: id }, { pane: paneIndex });
  const creating = scheduleId === 'new';
  const selected = scheduleId && !creating ? schedules.find((s) => s.id === scheduleId) : undefined;
  const showEditor = creating || !!selected;
  const empty = schedules.length === 0;

  return (
    <>
      <PaneBar
        paneIndex={paneIndex}
        actions={
          hasProjects && !empty && !creating ? (
            <Button variant="ghost" size="sm" icon={Plus} onClick={() => select('new')}>
              New schedule
            </Button>
          ) : null
        }
      >
        <span className="pane-title">Schedules</span>
      </PaneBar>
      <div className="sched">
        {!hasProjects ? (
          <EmptyState title="Add a project first">
            A schedule runs a prompt in one of your projects. Add a project folder from the sidebar, then come back here.
          </EmptyState>
        ) : empty && !creating ? (
          <EmptyState
            title="Run a prompt on a timer"
            action={
              <Button variant="primary" icon={Plus} onClick={() => select('new')}>
                New schedule
              </Button>
            }
          >
            Send a prompt to an existing thread, or start a fresh agent each time — a morning triage on weekdays, a test sweep every hour.
          </EmptyState>
        ) : (
          <div ref={layoutRef} className={`sched-layout fade-y${showEditor ? ' has-editor' : ''}`}>
            {!empty ? (
              <div ref={listRef} className="sched-list-col fade-y">
                <div className="list sched-list">
                  {schedules.map((s) => (
                    <ScheduleRow key={s.id} s={s} selected={s.id === scheduleId} onSelect={() => select(s.id)} />
                  ))}
                </div>
              </div>
            ) : null}
            <div ref={editorRef} className="sched-editor-col fade-y">
              {showEditor ? (
                <ScheduleEditor
                  key={creating ? 'new' : selected!.id}
                  paneIndex={paneIndex}
                  schedule={selected}
                  onSaved={(id) => creating && select(id)}
                  onDeleted={() => select(null)}
                  onCancel={() => select(null)}
                />
              ) : scheduleId && !selected ? (
                <EmptyState title="Schedule not found">It may have been deleted.</EmptyState>
              ) : (
                <div className="sched-pick muted">Pick a schedule to edit it.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function ScheduleRow({ s, selected, onSelect }: { s: Schedule; selected: boolean; onSelect: () => void }) {
  const now = useNow();
  const lastThread = useApp((st) => (s.lastThreadId ? st.threads.find((t) => t.id === s.lastThreadId) : undefined));
  const plain = describeCron(s.cron) ?? 'Custom schedule';
  return (
    <div
      className={`list-row is-clickable sched-row${selected ? ' is-selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="sched-row-main">
        <div className="sched-row-name">{s.name}</div>
        <div className="sched-row-meta">
          <code className="sched-cron">{s.cron}</code>
          <span>{plain}</span>
        </div>
        <div className="sched-row-meta">
          <TargetSummary s={s} />
        </div>
        <div className="sched-row-meta num">
          <span>{s.enabled && s.nextRunAt ? `Next ${dateTime(s.nextRunAt)}` : 'Paused'}</span>
          {s.lastRunAt ? (
            <span>
              Last ran {ago(s.lastRunAt, now)}
              {lastThread ? (
                <>
                  {' · '}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openThread(lastThread.id, { split: true });
                    }}
                  >
                    open run
                  </a>
                </>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
      <span className="sched-row-switch" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Switch
          checked={s.enabled}
          label={s.enabled ? `Pause ${s.name}` : `Enable ${s.name}`}
          onChange={(enabled) => void attempt(api.putSchedule({ id: s.id, enabled }))}
        />
      </span>
    </div>
  );
}
