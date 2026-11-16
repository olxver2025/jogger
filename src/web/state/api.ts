import type {
  AppState,
  ApprovalDecision,
  Attachment,
  CreateThreadBody,
  MemoryEntry,
  Persona,
  Project,
  ProviderInfo,
  Schedule,
  Settings,
  Thread,
  ThreadEvent,
  UpdateThreadBody,
} from '../../shared/protocol';
import { toast } from './toast';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const isRaw = body instanceof Blob;
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined && !isRaw ? { 'content-type': 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : isRaw ? (body as Blob) : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText || 'Request failed'}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

const enc = encodeURIComponent;
const PAGE = 5000; // the daemon returns at most this many events per call

export const api = {
  state: () => request<AppState>('GET', '/api/state'),

  async events(threadId: string, after = 0): Promise<ThreadEvent[]> {
    const all: ThreadEvent[] = [];
    let cursor = after;
    for (;;) {
      const page = await request<ThreadEvent[]>('GET', `/api/threads/${enc(threadId)}/events?after=${cursor}`);
      all.push(...page);
      if (page.length < PAGE) return all;
      cursor = page[page.length - 1].seq;
    }
  },

  createProject: (path: string, name?: string) => request<Project>('POST', '/api/projects', { path, name }),
  deleteProject: (id: string) => request('DELETE', `/api/projects/${enc(id)}`),
  dirs: (path: string) => request<string[]>('GET', `/api/fs/dirs?path=${enc(path)}`),

  memory: (projectId: string) => request<MemoryEntry[]>('GET', `/api/projects/${enc(projectId)}/memory`),
  putMemory: (projectId: string, key: string, content: string) =>
    request<MemoryEntry[]>('PUT', `/api/projects/${enc(projectId)}/memory/${enc(key)}`, { content }),
  deleteMemory: (projectId: string, key: string) => request<MemoryEntry[]>('DELETE', `/api/projects/${enc(projectId)}/memory/${enc(key)}`),

  createThread: (body: CreateThreadBody) => request<Thread>('POST', '/api/threads', body),
  updateThread: (id: string, body: UpdateThreadBody) => request<Thread>('PATCH', `/api/threads/${enc(id)}`, body),
  deleteThread: (id: string) => request('DELETE', `/api/threads/${enc(id)}`),
  send: (id: string, text: string, attachmentIds?: string[]) => request('POST', `/api/threads/${enc(id)}/messages`, { text, attachmentIds }),
  interrupt: (id: string) => request('POST', `/api/threads/${enc(id)}/interrupt`),
  clearQueue: (id: string) => request('POST', `/api/threads/${enc(id)}/clear-queue`),
  approve: (requestId: string, decision: ApprovalDecision) => request('POST', `/api/approvals/${enc(requestId)}`, { decision }),

  upload: (file: File) =>
    request<Attachment>('POST', '/api/attachments', file, {
      'x-filename': enc(file.name || 'pasted'),
      'content-type': file.type || 'application/octet-stream',
    }),

  putSettings: (patch: Partial<Settings>) => request<Settings>('PUT', '/api/settings', patch),
  putPersona: (p: Partial<Persona>) => request<Persona>('PUT', '/api/personas', p),
  deletePersona: (id: string) => request('DELETE', `/api/personas/${enc(id)}`),
  putSchedule: (s: Partial<Schedule>) => request<Schedule>('PUT', '/api/schedules', s),
  deleteSchedule: (id: string) => request('DELETE', `/api/schedules/${enc(id)}`),
  runSchedule: (id: string) => request('POST', `/api/schedules/${enc(id)}/run`),
  refreshProviders: () => request<ProviderInfo[]>('POST', '/api/providers/refresh'),
  testTelegram: (botToken?: string) =>
    request<{ ok: boolean; botName?: string; error?: string }>('POST', '/api/telegram/test', { botToken }),
};

/** Run an API call and show its error as a toast. Resolves to undefined on failure. */
export async function attempt<T>(p: Promise<T>, okText?: string): Promise<T | undefined> {
  try {
    const r = await p;
    if (okText) toast(okText, 'ok');
    return r;
  } catch (err) {
    toast((err as Error).message || 'Something went wrong', 'error');
    return undefined;
  }
}
