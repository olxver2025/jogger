import { DatabaseSync } from 'node:sqlite';
import type {
  Attachment,
  EventBody,
  MemoryEntry,
  Persona,
  Project,
  Schedule,
  Settings,
  Thread,
  ThreadEvent,
} from '../shared/protocol.js';
import { DEFAULT_KEYBINDINGS } from '../shared/protocol.js';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  palette: 'graphite',
  accentHue: 52,
  density: 'regular',
  background: 'grid',
  keybindings: { ...DEFAULT_KEYBINDINGS },
  unattendedApprovals: 'queue',
  stripApiKeys: true,
  maxAgentDepth: 4,
  telegram: { enabled: false, botToken: '', allowedChatIds: [], defaultThreadId: null, forwardApprovals: true },
};

export const DEFAULT_PERSONAS: Persona[] = [
  {
    id: 'p_claude',
    name: 'Claude',
    handle: 'claude',
    provider: 'claude',
    model: 'opus',
    mode: 'ask',
    systemPrompt: '',
    glyph: 'C',
    hue: 40,
    description: 'Claude Code on your Claude subscription.',
  },
  {
    id: 'p_codex',
    name: 'Codex',
    handle: 'codex',
    provider: 'codex',
    model: '',
    mode: 'ask',
    systemPrompt: '',
    glyph: 'X',
    hue: 160,
    description: 'Codex on your ChatGPT subscription.',
  },
  {
    id: 'p_artist',
    name: 'Artist',
    handle: 'artist',
    provider: 'codex',
    model: '',
    mode: 'auto',
    systemPrompt:
      'You make images for other agents. When asked for an image, use your image generation tool, then reply with one short sentence describing what you made. Do not edit project files unless asked.',
    glyph: 'A',
    hue: 320,
    description: 'Codex with image generation, for other agents to call on.',
  },
  {
    id: 'p_reviewer',
    name: 'Reviewer',
    handle: 'reviewer',
    provider: 'claude',
    model: 'sonnet',
    mode: 'ask',
    systemPrompt:
      'You review changes made by other agents. Read the diff, run the tests if there are any, and reply with concrete problems ranked by severity. Do not edit files.',
    glyph: 'R',
    hue: 250,
    description: 'Read-only code review on request.',
  },
];

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS personas (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id, seq);
      CREATE TABLE IF NOT EXISTS memory (
        project_id TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (project_id, key)
      );
    `);
    if (!this.getKv('seeded')) {
      for (const p of DEFAULT_PERSONAS) this.putPersona(p);
      this.setKv('seeded', '1');
    }
  }

  // ---- generic JSON tables
  private all<T>(table: string): T[] {
    return (this.db.prepare(`SELECT data FROM ${table}`).all() as Row[]).map((r) => JSON.parse(r.data as string));
  }
  private get<T>(table: string, id: string): T | null {
    const r = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
    return r ? JSON.parse(r.data as string) : null;
  }
  private put(table: string, id: string, value: unknown) {
    this.db.prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(id, JSON.stringify(value));
  }
  private del(table: string, id: string) {
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  }

  projects = () => this.all<Project>('projects').sort((a, b) => a.createdAt - b.createdAt);
  project = (id: string) => this.get<Project>('projects', id);
  putProject = (p: Project) => this.put('projects', p.id, p);
  deleteProject = (id: string) => this.del('projects', id);

  threads = () => this.all<Thread>('threads');
  thread = (id: string) => this.get<Thread>('threads', id);
  putThread = (t: Thread) => this.put('threads', t.id, t);
  deleteThread(id: string) {
    this.del('threads', id);
    this.db.prepare('DELETE FROM events WHERE thread_id = ?').run(id);
  }

  personas = () => this.all<Persona>('personas');
  persona = (id: string) => this.get<Persona>('personas', id);
  putPersona = (p: Persona) => this.put('personas', p.id, p);
  deletePersona = (id: string) => this.del('personas', id);

  schedules = () => this.all<Schedule>('schedules');
  schedule = (id: string) => this.get<Schedule>('schedules', id);
  putSchedule = (s: Schedule) => this.put('schedules', s.id, s);
  deleteSchedule = (id: string) => this.del('schedules', id);

  attachment = (id: string) => this.get<Attachment>('attachments', id);
  putAttachment = (a: Attachment) => this.put('attachments', a.id, a);

  getKv(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
    return r ? (r.value as string) : null;
  }
  setKv(key: string, value: string) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  settings(): Settings {
    const raw = this.getKv('settings');
    const saved = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      keybindings: { ...DEFAULT_SETTINGS.keybindings, ...(saved.keybindings ?? {}) },
      telegram: { ...DEFAULT_SETTINGS.telegram, ...(saved.telegram ?? {}) },
    };
  }
  putSettings(s: Settings) {
    this.setKv('settings', JSON.stringify(s));
  }

  // ---- events
  appendEvent(threadId: string, body: EventBody): ThreadEvent {
    const ts = Date.now();
    const r = this.db
      .prepare('INSERT INTO events (thread_id, ts, type, body) VALUES (?, ?, ?, ?)')
      .run(threadId, ts, body.type, JSON.stringify(body));
    return { ...body, seq: Number(r.lastInsertRowid), threadId, ts } as ThreadEvent;
  }

  events(threadId: string, afterSeq = 0, limit = 5000): ThreadEvent[] {
    const rows = this.db
      .prepare('SELECT seq, ts, body FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(threadId, afterSeq, limit) as Row[];
    return rows.map((r) => ({ ...JSON.parse(r.body as string), seq: Number(r.seq), ts: Number(r.ts), threadId }));
  }

  // ---- memory
  memory(projectId: string): MemoryEntry[] {
    return (
      this.db.prepare('SELECT * FROM memory WHERE project_id = ? ORDER BY key').all(projectId) as Row[]
    ).map((r) => ({
      projectId,
      key: r.key as string,
      content: r.content as string,
      updatedAt: Number(r.updated_at),
      updatedBy: r.updated_by as string,
    }));
  }
  putMemory(e: MemoryEntry) {
    this.db
      .prepare(
        `INSERT INTO memory (project_id, key, content, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(e.projectId, e.key, e.content, e.updatedAt, e.updatedBy);
  }
  deleteMemory(projectId: string, key: string) {
    this.db.prepare('DELETE FROM memory WHERE project_id = ? AND key = ?').run(projectId, key);
  }
}
