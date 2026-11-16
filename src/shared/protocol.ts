// The contract shared by the daemon and the web UI.
// Everything a thread does is an append-only list of ThreadEvents. The UI replays
// them; live token deltas are sent separately and never stored.

export type ProviderId = string; // 'claude' | 'codex' | 'mock' | any registered adapter id

/** ask = approve edits and commands, auto = edits allowed but risky commands ask, full = never ask. */
export type ApprovalMode = 'ask' | 'auto' | 'full';
export const APPROVAL_MODES: ApprovalMode[] = ['ask', 'auto', 'full'];
export const MODE_RANK: Record<ApprovalMode, number> = { ask: 0, auto: 1, full: 2 };

export type ThreadStatus = 'idle' | 'starting' | 'running' | 'waiting' | 'error';
export type ThreadKind = 'user' | 'helper' | 'scheduled' | 'bridge';

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

export interface Worktree {
  path: string;
  branch: string;
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  /** Short handle other agents and Telegram use to address this thread, e.g. "artist". Unique. */
  handle: string;
  provider: ProviderId;
  model: string;
  mode: ApprovalMode;
  personaId: string | null;
  cwd: string;
  worktree: Worktree | null;
  kind: ThreadKind;
  parentThreadId: string | null;
  /** Provider's own session/thread id, used to resume after a daemon restart. */
  providerSessionId: string | null;
  status: ThreadStatus;
  queued: number;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  lastEventAt: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

export interface Persona {
  id: string;
  name: string;
  /** Default handle for threads started from this persona. */
  handle: string;
  provider: ProviderId;
  model: string;
  mode: ApprovalMode;
  systemPrompt: string;
  /** One glyph or short label shown as the avatar. */
  glyph: string;
  /** OKLCH hue (0-360) for the persona's colour. */
  hue: number;
  description: string;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Absolute path on the daemon's disk. */
  path: string;
  /** URL the UI can load. */
  url: string;
  sourceThreadId: string | null;
}

export type MessageOrigin =
  | { kind: 'user' }
  | { kind: 'agent'; threadId: string; handle: string; requestId: string; mode: 'ask' | 'send' }
  | { kind: 'reply'; threadId: string; handle: string; requestId: string }
  | { kind: 'schedule'; scheduleId: string; name: string }
  | { kind: 'telegram'; chatId: number; from: string };

export type ToolKind = 'command' | 'file' | 'read' | 'search' | 'web' | 'mcp' | 'agent' | 'image' | 'other';
export type ToolStatus = 'running' | 'done' | 'failed' | 'denied';

export type ApprovalDecision = 'allow' | 'allow_session' | 'deny';

export type EventBody =
  | { type: 'user.message'; text: string; attachments: Attachment[]; origin: MessageOrigin }
  | { type: 'turn.started'; turnId: string }
  | { type: 'assistant.message'; itemId: string; text: string; final?: boolean }
  | { type: 'reasoning'; itemId: string; text: string }
  | {
      type: 'tool';
      itemId: string;
      kind: ToolKind;
      name: string;
      title: string;
      input?: unknown;
      output?: string;
      status: ToolStatus;
      exitCode?: number | null;
    }
  | {
      type: 'approval.request';
      requestId: string;
      title: string;
      detail: string;
      toolName: string;
      canAllowSession: boolean;
    }
  | { type: 'approval.resolved'; requestId: string; decision: ApprovalDecision; by: string }
  | { type: 'attachment'; attachment: Attachment }
  | {
      type: 'agent.outbound';
      requestId: string;
      toThreadId: string;
      toHandle: string;
      text: string;
      mode: 'ask' | 'send';
      spawned: boolean;
    }
  | {
      type: 'agent.reply';
      requestId: string;
      fromThreadId: string;
      fromHandle: string;
      text: string;
      attachments: Attachment[];
      ok: boolean;
    }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'turn.completed'; turnId: string; status: 'completed' | 'interrupted' | 'failed'; error?: string; durationMs?: number }
  | { type: 'error'; message: string }
  | { type: 'notice'; text: string };

export type EventType = EventBody['type'];

export type ThreadEvent = EventBody & {
  seq: number;
  threadId: string;
  ts: number;
};

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  available: boolean;
  version: string | null;
  error: string | null;
  models: { id: string; label: string }[];
  defaultModel: string;
  capabilities: ProviderCapabilities;
}

export interface ProviderCapabilities {
  imageInput: boolean;
  imageGeneration: boolean;
  webSearch: boolean;
  resume: boolean;
}

export interface Schedule {
  id: string;
  name: string;
  projectId: string;
  cron: string;
  prompt: string;
  /** Send into this thread, or start a new one from the persona / provider below. */
  threadId: string | null;
  personaId: string | null;
  provider: ProviderId | null;
  model: string | null;
  mode: ApprovalMode;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastThreadId: string | null;
}

export interface MemoryEntry {
  projectId: string;
  key: string;
  content: string;
  updatedAt: number;
  updatedBy: string;
}

export type ThemeMode = 'system' | 'light' | 'dark';

export interface Settings {
  theme: ThemeMode;
  /** Neutral palette name. */
  palette: 'graphite' | 'paper' | 'slate' | 'moss';
  accentHue: number;
  density: 'compact' | 'regular';
  background: 'grid' | 'dots' | 'plain';
  keybindings: Record<string, string>;
  /** Where approvals for unattended runs (schedules, Telegram, helpers with nobody watching) go. */
  unattendedApprovals: 'queue' | 'deny';
  /** Strip ANTHROPIC_API_KEY / OPENAI_API_KEY from agent processes so they bill to your subscription. */
  stripApiKeys: boolean;
  maxAgentDepth: number;
  telegram: {
    enabled: boolean;
    botToken: string;
    allowedChatIds: number[];
    defaultThreadId: string | null;
    forwardApprovals: boolean;
  };
}

export interface AppState {
  projects: Project[];
  threads: Thread[];
  personas: Persona[];
  providers: ProviderInfo[];
  schedules: Schedule[];
  settings: Settings;
  pendingApprovals: PendingApproval[];
  telegram: { status: 'off' | 'connecting' | 'online' | 'error'; error: string | null; botName: string | null };
  version: string;
}

export interface PendingApproval {
  requestId: string;
  threadId: string;
  title: string;
  detail: string;
  toolName: string;
  canAllowSession: boolean;
  createdAt: number;
}

// ---- WebSocket messages (server -> client)
export type ServerMessage =
  | { type: 'hello'; state: AppState }
  | { type: 'event'; event: ThreadEvent }
  | { type: 'delta'; threadId: string; itemId: string; kind: 'text' | 'reasoning'; text: string }
  | { type: 'thread'; thread: Thread }
  | { type: 'thread.removed'; threadId: string }
  | { type: 'project'; project: Project }
  | { type: 'project.removed'; projectId: string }
  | { type: 'personas'; personas: Persona[] }
  | { type: 'schedules'; schedules: Schedule[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'providers'; providers: ProviderInfo[] }
  | { type: 'approvals'; pendingApprovals: PendingApproval[] }
  | { type: 'telegram'; telegram: AppState['telegram'] };

// ---- REST request bodies
export interface CreateThreadBody {
  projectId: string;
  provider?: ProviderId;
  model?: string;
  mode?: ApprovalMode;
  personaId?: string | null;
  title?: string;
  handle?: string;
  worktree?: boolean;
  prompt?: string;
  attachmentIds?: string[];
}

export interface SendMessageBody {
  text: string;
  attachmentIds?: string[];
}

export interface UpdateThreadBody {
  title?: string;
  handle?: string;
  mode?: ApprovalMode;
  model?: string;
  archived?: boolean;
}

export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  'palette.open': 'mod+k',
  'thread.new': 'mod+shift+o',
  'pane.split': 'mod+\\',
  'pane.close': 'mod+shift+w',
  'pane.next': 'mod+]',
  'pane.prev': 'mod+[',
  'thread.interrupt': 'mod+.',
  'composer.focus': '/',
  'settings.open': 'mod+,',
  'sidebar.toggle': 'mod+b',
};

export const KEYBINDING_LABELS: Record<string, string> = {
  'palette.open': 'Open command palette',
  'thread.new': 'New thread',
  'pane.split': 'Split pane',
  'pane.close': 'Close pane',
  'pane.next': 'Focus next pane',
  'pane.prev': 'Focus previous pane',
  'thread.interrupt': 'Stop the running turn',
  'composer.focus': 'Focus the message box',
  'settings.open': 'Open settings',
  'sidebar.toggle': 'Toggle sidebar',
};
