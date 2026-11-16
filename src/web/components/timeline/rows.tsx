import { memo, useRef, useState, type ReactNode } from 'react';
import {
  Ban,
  Bot,
  Brain,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  CornerDownRight,
  Download,
  File as FileIcon,
  FilePen,
  FileText,
  Globe,
  Image as ImageIcon,
  MessagesSquare,
  Plug,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ApprovalDecision, Attachment, MessageOrigin, ToolKind } from '../../../shared/protocol';
import { attempt, api } from '../../state/api';
import { usePersona, useThread } from '../../state/app';
import { openThread, setLightbox } from '../../state/ui';
import { identity, providerHue } from '../../lib/hue';
import { bytes, clock, duration } from '../../lib/format';
import { summarizeTools, type Ev, type ToolEv } from '../../lib/timeline';
import { useScrollFade } from '../../lib/hooks';
import { Button, CopyButton, Glyph, ICON_SM, Spinner } from '../ui';
import { MarkdownText } from './Markdown';

// ---------------------------------------------------------------- shared bits

/** "@handle" chip for another agent; opens its thread in a split. */
export function AgentRef({ threadId, handle, withGlyph = true }: { threadId: string; handle: string; withGlyph?: boolean }) {
  const t = useThread(threadId);
  const persona = usePersona(t?.personaId);
  const id = t ? identity(t, persona) : { glyph: handle[0]?.toUpperCase() ?? '?', hue: providerHue(handle) };
  return (
    <button
      type="button"
      className="agent-ref"
      onClick={(e) => {
        e.stopPropagation();
        if (t) openThread(threadId, { split: true });
      }}
      disabled={!t}
      data-tip={t ? 'Open in a split' : 'That thread was deleted'}
    >
      {withGlyph ? <Glyph glyph={id.glyph} hue={id.hue} size="sm" /> : null}
      <span className="mono">@{handle}</span>
    </button>
  );
}

export function Attachments({ list }: { list: Attachment[] }) {
  if (!list.length) return null;
  const images = list.filter((a) => a.mime.startsWith('image/') && a.mime !== 'image/svg+xml');
  const files = list.filter((a) => !images.includes(a));
  return (
    <div className="atts">
      {images.length ? (
        <div className="att-images">
          {images.map((a) => (
            <button key={a.id} type="button" className="att-thumb" onClick={() => setLightbox(a)} data-tip={a.name}>
              <img src={a.url} alt={a.name} loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      ) : null}
      {files.length ? (
        <div className="att-files">
          {files.map((a) => (
            <a key={a.id} className="file-chip" href={a.url} download={a.name} target="_blank" rel="noreferrer">
              <FileIcon {...ICON_SM} />
              <span className="file-chip-name">{a.name}</span>
              <span className="file-chip-size num">{bytes(a.size)}</span>
              <Download {...ICON_SM} className="file-chip-dl" />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Expander({ open, onToggle, children, className }: { open: boolean; onToggle: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" className={`expander${open ? ' is-open' : ''}${className ? ' ' + className : ''}`} aria-expanded={open} onClick={onToggle}>
      {children}
      <ChevronRight {...ICON_SM} className="expander-chev" />
    </button>
  );
}

function ScrollPre({ text, label }: { text: string; label: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useScrollFade(ref);
  return (
    <div className="pre-block">
      <div className="pre-bar">
        <span>{label}</span>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <pre ref={ref} className="pre-scroll fade-y">
        {text}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------- user messages

function OriginHead({ origin, ts }: { origin: MessageOrigin; ts: number }) {
  switch (origin.kind) {
    case 'schedule':
      return (
        <div className="msg-origin">
          <CalendarClock {...ICON_SM} />
          <span>
            Scheduled <span className="origin-name">“{origin.name}”</span>
          </span>
          <time className="num">{clock(ts)}</time>
        </div>
      );
    case 'telegram':
      return (
        <div className="msg-origin">
          <Send {...ICON_SM} />
          <span>Telegram from {origin.from}</span>
          <time className="num">{clock(ts)}</time>
        </div>
      );
    default:
      return (
        <div className="msg-origin">
          <span>You</span>
          <time className="num">{clock(ts)}</time>
        </div>
      );
  }
}

export const UserMessage = memo(function UserMessage({ ev }: { ev: Ev<'user.message'> }) {
  const o = ev.origin;
  if (o.kind === 'agent') {
    return (
      <div className="agent-card is-incoming">
        <div className="agent-card-head">
          <MessagesSquare {...ICON_SM} className="agent-card-icon" />
          <AgentRef threadId={o.threadId} handle={o.handle} />
          <span className="agent-card-verb">{o.mode === 'ask' ? 'asked this thread' : 'sent a message'}</span>
          <time className="num">{clock(ev.ts)}</time>
        </div>
        <div className="agent-card-body">
          <MarkdownText text={ev.text} />
          <Attachments list={ev.attachments} />
        </div>
        {o.mode === 'ask' ? <div className="agent-card-foot">This thread’s final message goes back to @{o.handle}.</div> : null}
      </div>
    );
  }
  if (o.kind === 'reply') return <ReplyTurnMarker ev={ev} origin={o} />;
  return (
    <div className="msg-user">
      <OriginHead origin={o} ts={ev.ts} />
      <div className="msg-user-bubble">
        {ev.text ? <div className="msg-user-text">{ev.text}</div> : null}
        <Attachments list={ev.attachments} />
      </div>
    </div>
  );
});

function ReplyTurnMarker({ ev, origin }: { ev: Ev<'user.message'>; origin: Extract<MessageOrigin, { kind: 'reply' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="row-quiet">
      <Expander open={open} onToggle={() => setOpen(!open)} className="quiet-line">
        <CornerDownRight {...ICON_SM} />
        <span>
          Continued with the reply from <span className="mono">@{origin.handle}</span>
        </span>
      </Expander>
      {open ? (
        <div className="quiet-body">
          <MarkdownText text={ev.text} />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- assistant + reasoning

export const AssistantMessage = memo(function AssistantMessage({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="msg-assistant">
      <MarkdownText text={text} streaming={streaming} />
    </div>
  );
});

export const Reasoning = memo(function Reasoning({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const first = text.trim().split('\n').find((l) => l.trim()) ?? '';
  const summary = first.replace(/^[#*_\s>-]+|[*_]+$/g, '').slice(0, 160);
  return (
    <div className="row-quiet">
      <Expander open={open} onToggle={() => setOpen(!open)} className="quiet-line">
        {streaming ? <Spinner size={14} /> : <Brain {...ICON_SM} />}
        <span className="quiet-label">{streaming ? 'Thinking' : 'Thought'}</span>
        {summary ? <span className="quiet-summary">{summary}</span> : null}
      </Expander>
      {open ? (
        <div className="quiet-body reasoning-body">
          <MarkdownText text={text} />
        </div>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------- tools

const TOOL_ICONS: Record<ToolKind, LucideIcon> = {
  command: Terminal,
  file: FilePen,
  read: FileText,
  search: Search,
  web: Globe,
  mcp: Plug,
  agent: Bot,
  image: ImageIcon,
  other: Wrench,
};
const MONO_KINDS = new Set<ToolKind>(['command', 'file', 'read', 'search']);

function ToolStatusIcon({ ev }: { ev: ToolEv }) {
  if (ev.ended) return <span className="tool-stopped">stopped</span>;
  switch (ev.status) {
    case 'running':
      return <Spinner size={14} />;
    case 'done':
      return <Check {...ICON_SM} className="tool-ok" aria-label="Done" />;
    case 'failed':
      return <X {...ICON_SM} className="tool-fail" aria-label="Failed" />;
    case 'denied':
      return (
        <span className="tool-denied">
          <Ban {...ICON_SM} />
          denied
        </span>
      );
  }
}

function inputText(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input === 'string') return input;
  try {
    const s = JSON.stringify(input, null, 2);
    return s === '{}' ? null : s;
  } catch {
    return String(input);
  }
}

export const ToolRow = memo(function ToolRow({ ev, nested }: { ev: ToolEv; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[ev.kind] ?? Wrench;
  const input = inputText(ev.input);
  const hasDetail = !!(ev.output || input);
  const title = ev.title || ev.name;
  return (
    <div className={`tool${nested ? ' is-nested' : ''} st-${ev.status}`}>
      <button type="button" className="tool-line" aria-expanded={hasDetail ? open : undefined} onClick={() => hasDetail && setOpen(!open)} disabled={!hasDetail}>
        <Icon {...ICON_SM} className="tool-icon" />
        <span className={`tool-title${MONO_KINDS.has(ev.kind) ? ' mono' : ''}`}>{title}</span>
        {ev.exitCode !== undefined && ev.exitCode !== null && ev.exitCode !== 0 ? <span className="tool-exit mono num">exit {ev.exitCode}</span> : null}
        <span className="tool-status">
          <ToolStatusIcon ev={ev} />
        </span>
        {hasDetail ? <ChevronRight {...ICON_SM} className={`expander-chev${open ? ' is-open' : ''}`} /> : <span className="chev-gap" />}
      </button>
      {open ? (
        <div className="tool-detail">
          {input && input !== title ? <ScrollPre text={input} label="Input" /> : null}
          {ev.output ? <ScrollPre text={ev.output} label="Output" /> : null}
        </div>
      ) : null}
    </div>
  );
});

export const ToolGroup = memo(
  function ToolGroup({ evs }: { evs: ToolEv[] }) {
    const [open, setOpen] = useState(false);
    const running = evs.some((e) => e.status === 'running' && !e.ended);
    const failed = evs.filter((e) => e.status === 'failed' || e.status === 'denied').length;
    const allRead = evs.every((e) => e.kind === 'read');
    const Icon = allRead ? FileText : Search;
    return (
      <div className="tool tool-group">
        <button type="button" className="tool-line" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon {...ICON_SM} className="tool-icon" />
          <span className="tool-title">{summarizeTools(evs)}</span>
          {failed ? <span className="tool-exit num">{failed} failed</span> : null}
          <span className="tool-status">{running ? <Spinner size={14} /> : <Check {...ICON_SM} className="tool-ok" />}</span>
          <ChevronRight {...ICON_SM} className={`expander-chev${open ? ' is-open' : ''}`} />
        </button>
        {open ? (
          <div className="tool-group-list">
            {evs.map((e) => (
              <ToolRow key={e.itemId} ev={e} nested />
            ))}
          </div>
        ) : null}
      </div>
    );
  },
  (a, b) => a.evs.length === b.evs.length && a.evs.every((e, i) => e === b.evs[i]),
);

// ---------------------------------------------------------------- approvals

const DECISION_TEXT: Record<ApprovalDecision, string> = { allow: 'Allowed', allow_session: 'Allowed for this session', deny: 'Denied' };

export const ApprovalCard = memo(function ApprovalCard({
  ev,
  resolution,
  pending,
}: {
  ev: Ev<'approval.request'>;
  resolution: Ev<'approval.resolved'> | undefined;
  pending: boolean;
}) {
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const decide = async (d: ApprovalDecision) => {
    setBusy(d);
    await attempt(api.approve(ev.requestId, d));
    setBusy(null);
  };
  if (!pending || resolution) {
    const d = resolution?.decision;
    const Icon = d === 'deny' ? ShieldX : d ? ShieldCheck : ShieldAlert;
    const by = resolution && resolution.by !== 'you' ? ` (${resolution.by})` : '';
    return (
      <div className={`approval-done${d === 'deny' ? ' is-denied' : ''}`}>
        <Icon {...ICON_SM} />
        <span className="approval-done-what">{d ? DECISION_TEXT[d] + by : 'No longer pending'}</span>
        <span className="approval-done-title">{ev.title}</span>
      </div>
    );
  }
  return (
    <div className="approval" role="group" aria-label="Approval needed">
      <div className="approval-head">
        <ShieldAlert {...ICON_SM} />
        <span className="approval-title">{ev.title}</span>
        <span className="approval-tool mono">{ev.toolName}</span>
      </div>
      {ev.detail && ev.detail !== ev.title ? <ApprovalDetail text={ev.detail} /> : null}
      <div className="approval-actions">
        <Button variant="primary" onClick={() => void decide('allow')} busy={busy === 'allow'} disabled={!!busy}>
          Allow
        </Button>
        {ev.canAllowSession ? (
          <Button onClick={() => void decide('allow_session')} busy={busy === 'allow_session'} disabled={!!busy} tip="Don’t ask again for this kind of action in this session">
            Allow for session
          </Button>
        ) : null}
        <span className="spacer" />
        <Button variant="ghost" onClick={() => void decide('deny')} busy={busy === 'deny'} disabled={!!busy}>
          Deny
        </Button>
      </div>
    </div>
  );
});

function ApprovalDetail({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useScrollFade(ref);
  return (
    <pre ref={ref} className="approval-detail fade-y">
      {text}
    </pre>
  );
}

// ---------------------------------------------------------------- agent-to-agent

export const OutboundCard = memo(function OutboundCard({ ev, waiting }: { ev: Ev<'agent.outbound'>; waiting: boolean }) {
  return (
    <div className="agent-card is-outbound">
      <div className="agent-card-head">
        <MessagesSquare {...ICON_SM} className="agent-card-icon" />
        <span className="agent-card-verb">{ev.mode === 'ask' ? 'Asked' : 'Sent to'}</span>
        <AgentRef threadId={ev.toThreadId} handle={ev.toHandle} />
        {ev.spawned ? <span className="agent-card-note">started a new helper</span> : null}
        <time className="num">{clock(ev.ts)}</time>
      </div>
      <div className="agent-card-body">
        <MarkdownText text={ev.text} />
      </div>
      {waiting ? (
        <div className="agent-card-foot is-waiting">
          <Spinner size={12} /> Waiting for @{ev.toHandle} to answer
        </div>
      ) : null}
    </div>
  );
});

export const ReplyCard = memo(function ReplyCard({ ev }: { ev: Ev<'agent.reply'> }) {
  return (
    <div className={`agent-card is-reply${ev.ok ? '' : ' is-failed'}`}>
      <div className="agent-card-head">
        {ev.ok ? <CornerDownRight {...ICON_SM} className="agent-card-icon" /> : <CircleAlert {...ICON_SM} className="agent-card-icon" />}
        <span className="agent-card-verb">{ev.ok ? 'Reply from' : 'No answer from'}</span>
        <AgentRef threadId={ev.fromThreadId} handle={ev.fromHandle} />
        <time className="num">{clock(ev.ts)}</time>
      </div>
      {ev.text || ev.attachments.length ? (
        <div className="agent-card-body">
          {ev.text ? <MarkdownText text={ev.text} /> : null}
          <Attachments list={ev.attachments} />
        </div>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------- misc

export const AttachmentRow = memo(function AttachmentRow({ ev }: { ev: Ev<'attachment'> }) {
  return (
    <div className="msg-attachment">
      <Attachments list={[ev.attachment]} />
    </div>
  );
});

export const TurnDivider = memo(function TurnDivider({ ev }: { ev: Ev<'turn.completed'> }) {
  if (ev.status === 'failed') {
    return (
      <div className="turn-end is-failed">
        <span className="turn-end-text">
          <CircleAlert {...ICON_SM} /> Turn failed{ev.error ? `: ${ev.error}` : ''}
        </span>
      </div>
    );
  }
  return (
    <div className="turn-end">
      <span className="turn-end-text num">
        {ev.status === 'interrupted' ? 'Stopped' : 'Done'}
        {ev.durationMs ? ` · ${duration(ev.durationMs)}` : ''}
      </span>
    </div>
  );
});

export const Notice = memo(function Notice({ text }: { text: string }) {
  return <div className="notice">{text}</div>;
});

export const ErrorLine = memo(function ErrorLine({ text }: { text: string }) {
  return (
    <div className="callout is-error event-error" role="alert">
      <CircleAlert {...ICON_SM} />
      <span>{text}</span>
    </div>
  );
});
