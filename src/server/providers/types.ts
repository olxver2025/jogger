import type {
  ApprovalDecision,
  ApprovalMode,
  Attachment,
  ProviderCapabilities,
  ToolKind,
  ToolStatus,
} from '../../shared/protocol.js';

/**
 * The adapter contract. Add a provider by implementing ProviderAdapter and registering it
 * in providers/registry.ts. An adapter turns a CLI or SDK into a stream of AdapterEvents;
 * it never touches the database, the UI or other threads.
 */
export interface ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  readonly defaultModel: string;
  /** Models to offer in the UI. Free text is also accepted. */
  models(): { id: string; label: string }[];
  /** Is the CLI installed and logged in? Must be cheap and must not start a model turn. */
  check(): Promise<{ ok: boolean; version: string | null; error: string | null }>;
  createSession(opts: SessionOptions): AgentSession;
  /** Stop shared resources (e.g. a long-lived app-server child). */
  shutdown?(): Promise<void>;
}

export interface SessionOptions {
  threadId: string;
  cwd: string;
  model: string;
  mode: ApprovalMode;
  /** Extra instructions appended to the provider's own system prompt. */
  instructions: string;
  /** Provider session id to resume, if this thread ran before. */
  resumeId: string | null;
  /** Jogger's MCP endpoint, authenticated as this thread. */
  mcp: { url: string; token: string };
  /** Environment for child processes (already scrubbed of API keys when configured). */
  env: Record<string, string>;
  emit: (event: AdapterEvent) => void;
  /** Ask whoever is watching. Resolves when the user (or a policy) decides. */
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Store a file the agent produced (e.g. a generated image) and get an Attachment back. */
  saveAttachment: (file: { path?: string; data?: Buffer; name: string; mime?: string }) => Promise<Attachment>;
}

export interface ApprovalRequest {
  title: string;
  detail: string;
  toolName: string;
  canAllowSession: boolean;
}

export interface UserInput {
  text: string;
  /** Absolute paths of images to attach. */
  images: string[];
}

export interface AgentSession {
  /** Start a turn. Resolves once the turn has been accepted (not when it finishes). */
  send(input: UserInput): Promise<void>;
  interrupt(): Promise<void>;
  setMode(mode: ApprovalMode): Promise<void>;
  setModel?(model: string): Promise<void>;
  close(): Promise<void>;
}

export type AdapterEvent =
  | { type: 'session'; providerSessionId: string }
  | { type: 'turn.started'; turnId: string }
  | { type: 'delta'; itemId: string; kind: 'text' | 'reasoning'; text: string }
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
  | { type: 'attachment'; attachment: Attachment }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'turn.completed'; turnId: string; status: 'completed' | 'interrupted' | 'failed'; error?: string; durationMs?: number }
  | { type: 'error'; message: string }
  /** The session died; the thread manager will start a fresh one (resuming) on the next message. */
  | { type: 'closed'; error?: string };

export function truncate(s: string | undefined | null, max = 8000): string | undefined {
  if (s == null) return undefined;
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more characters)` : s;
}
