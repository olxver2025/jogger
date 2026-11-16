import { Cron } from 'croner';
import type { Schedule } from '../shared/protocol.js';
import type { Store } from './store.js';
import type { Hub } from './hub.js';
import type { ThreadManager } from './threads.js';
import { newId } from './config.js';

/** Cron-style prompts. A schedule either messages an existing thread or starts a fresh one each run. */
export class Scheduler {
  private jobs = new Map<string, Cron>();

  constructor(private store: Store, private hub: Hub, private threads: ThreadManager) {}

  start() {
    for (const s of this.store.schedules()) this.arm(s);
    this.broadcast();
  }

  stop() {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
  }

  list(): Schedule[] {
    return this.store.schedules().sort((a, b) => a.name.localeCompare(b.name));
  }

  upsert(patch: Partial<Schedule>): Schedule {
    const prev = patch.id ? this.store.schedule(patch.id) : null;
    const s: Schedule = {
      id: prev?.id ?? newId('s'),
      name: patch.name?.trim() || prev?.name || 'Untitled schedule',
      projectId: patch.projectId ?? prev?.projectId ?? '',
      cron: (patch.cron ?? prev?.cron ?? '0 9 * * 1-5').trim(),
      prompt: patch.prompt ?? prev?.prompt ?? '',
      threadId: patch.threadId !== undefined ? patch.threadId : prev?.threadId ?? null,
      personaId: patch.personaId !== undefined ? patch.personaId : prev?.personaId ?? null,
      provider: patch.provider !== undefined ? patch.provider : prev?.provider ?? null,
      model: patch.model !== undefined ? patch.model : prev?.model ?? null,
      mode: patch.mode ?? prev?.mode ?? 'ask',
      enabled: patch.enabled ?? prev?.enabled ?? true,
      lastRunAt: prev?.lastRunAt ?? null,
      nextRunAt: null,
      lastThreadId: prev?.lastThreadId ?? null,
    };
    if (!this.store.project(s.projectId)) throw new Error('Pick a project for the schedule.');
    if (!s.prompt.trim()) throw new Error('A schedule needs a prompt.');
    try {
      new Cron(s.cron, { paused: true }).stop();
    } catch (err) {
      throw new Error(`"${s.cron}" is not a valid cron expression: ${(err as Error).message}`);
    }
    this.store.putSchedule(s);
    this.arm(s);
    this.broadcast();
    return this.store.schedule(s.id)!;
  }

  remove(id: string) {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    this.store.deleteSchedule(id);
    this.broadcast();
  }

  async runNow(id: string) {
    const s = this.store.schedule(id);
    if (!s) throw new Error('No such schedule');
    await this.fire(s);
  }

  private arm(s: Schedule) {
    this.jobs.get(s.id)?.stop();
    this.jobs.delete(s.id);
    if (!s.enabled) {
      s.nextRunAt = null;
      this.store.putSchedule(s);
      return;
    }
    const job = new Cron(s.cron, { protect: true, catch: true }, async () => {
      const cur = this.store.schedule(s.id);
      if (cur) await this.fire(cur);
    });
    this.jobs.set(s.id, job);
    s.nextRunAt = job.nextRun()?.getTime() ?? null;
    this.store.putSchedule(s);
  }

  private async fire(s: Schedule) {
    const origin = { kind: 'schedule' as const, scheduleId: s.id, name: s.name };
    let threadId = s.threadId && this.store.thread(s.threadId) ? s.threadId : null;
    try {
      if (threadId) {
        this.threads.sendUserMessage(threadId, s.prompt, [], origin);
      } else {
        const t = await this.threads.createThread({
          projectId: s.projectId,
          personaId: s.personaId,
          provider: s.provider ?? undefined,
          model: s.model ?? undefined,
          mode: s.mode,
          title: `${s.name} · ${new Date().toLocaleDateString()}`,
          kind: 'scheduled',
          prompt: s.prompt,
          origin,
        });
        threadId = t.id;
      }
    } catch (err) {
      console.error(`[jogger] schedule ${s.name} failed:`, (err as Error).message);
    }
    const cur = this.store.schedule(s.id);
    if (!cur) return;
    cur.lastRunAt = Date.now();
    cur.lastThreadId = threadId;
    cur.nextRunAt = this.jobs.get(s.id)?.nextRun()?.getTime() ?? null;
    this.store.putSchedule(cur);
    this.broadcast();
  }

  private broadcast() {
    this.hub.broadcast({ type: 'schedules', schedules: this.list() });
  }
}
