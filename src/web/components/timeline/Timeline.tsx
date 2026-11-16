import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, RotateCw } from 'lucide-react';
import type { ThreadEvent, ThreadStatus } from '../../../shared/protocol';
import { usePending } from '../../state/app';
import { loadThread, useDeltas, useThreadLog } from '../../state/events';
import { deriveTimeline, type Item, type Timeline as TL } from '../../lib/timeline';
import { useScrollFade } from '../../lib/hooks';
import { Button, EmptyState, ICON_SM, Loading, Spinner } from '../ui';
import {
  ApprovalCard,
  AssistantMessage,
  AttachmentRow,
  ErrorLine,
  Notice,
  OutboundCard,
  Reasoning,
  ReplyCard,
  ToolGroup,
  ToolRow,
  TurnDivider,
  UserMessage,
} from './rows';
import '../../styles/timeline.css';

const EMPTY: ThreadEvent[] = [];
const PAGE = 300;

function renderItem(it: Item, tl: TL, pendingIds: Set<string>, busy: boolean) {
  if (it.kind === 'tools') return <ToolGroup evs={it.evs} />;
  const ev = it.ev;
  switch (ev.type) {
    case 'user.message':
      return <UserMessage ev={ev} />;
    case 'assistant.message':
      return <AssistantMessage text={ev.text} />;
    case 'reasoning':
      return <Reasoning text={ev.text} />;
    case 'tool':
      return <ToolRow ev={ev} />;
    case 'approval.request':
      // The request event arrives just before the approvals broadcast; while the turn is live, treat an
      // unresolved request as pending (the server resolves every open approval when a turn ends).
      return <ApprovalCard ev={ev} resolution={tl.resolved.get(ev.requestId)} pending={pendingIds.has(ev.requestId) || (busy && !tl.resolved.has(ev.requestId))} />;
    case 'agent.outbound':
      return <OutboundCard ev={ev} waiting={busy && ev.mode === 'ask' && !tl.replies.has(ev.requestId)} />;
    case 'agent.reply':
      return <ReplyCard ev={ev} />;
    case 'attachment':
      return <AttachmentRow ev={ev} />;
    case 'turn.completed':
      return <TurnDivider ev={ev} />;
    case 'notice':
      return <Notice text={ev.text} />;
    case 'error':
      return <ErrorLine text={ev.message} />;
    default:
      return null;
  }
}

/** Live text that hasn't been stored yet. Separate from the memoised rows so deltas only re-render this. */
function StreamingTail({ threadId, settled, status, lastIsActive }: { threadId: string; settled: Set<string>; status: ThreadStatus; lastIsActive: boolean }) {
  const deltas = useDeltas(threadId);
  const entries = deltas ? Object.entries(deltas).filter(([id, d]) => !settled.has(id) && d.text) : [];
  const busy = status === 'running' || status === 'starting';
  return (
    <>
      {entries.map(([id, d]) => (
        <div key={`live:${id}`} className="tl-row is-live">
          {d.kind === 'reasoning' ? <Reasoning text={d.text} streaming /> : <AssistantMessage text={d.text} streaming />}
        </div>
      ))}
      {busy && !entries.length && !lastIsActive ? (
        <div className="tl-row working" aria-live="polite">
          <Spinner size={12} />
          <span>{status === 'starting' ? 'Starting' : 'Working'}</span>
        </div>
      ) : null}
    </>
  );
}

export function Timeline({ threadId, status, handle }: { threadId: string; status: ThreadStatus; handle: string }) {
  const log = useThreadLog(threadId);
  const pending = usePending();
  const [limit, setLimit] = useState(PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  useScrollFade(scrollRef);

  useEffect(() => {
    void loadThread(threadId);
    setLimit(PAGE);
    pinnedRef.current = true;
    setPinned(true);
  }, [threadId]);

  const list = log?.list ?? EMPTY;
  const tl = useMemo(() => deriveTimeline(list), [list]);
  const pendingIds = useMemo(() => new Set(pending.filter((p) => p.threadId === threadId).map((p) => p.requestId)), [pending, threadId]);
  const busy = status === 'running' || status === 'starting' || status === 'waiting';

  const hiddenCount = Math.max(0, tl.items.length - limit);
  const shown = hiddenCount ? tl.items.slice(hiddenCount) : tl.items;
  const last = shown[shown.length - 1];
  const lastIsActive =
    !!last &&
    ((last.kind === 'event' && last.ev.type === 'tool' && last.ev.status === 'running' && !(last.ev as { ended?: boolean }).ended) ||
      (last.kind === 'tools' && last.evs.some((e) => e.status === 'running' && !e.ended)) ||
      (last.kind === 'event' && last.ev.type === 'approval.request' && !tl.resolved.has(last.ev.requestId)) ||
      (last.kind === 'event' && last.ev.type === 'agent.outbound' && last.ev.mode === 'ask' && !tl.replies.has(last.ev.requestId)));

  const toBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // Keep pinned to the bottom while content grows (new rows, streaming text, images loading).
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) toBottom();
    });
    ro.observe(content);
    if (scrollRef.current) ro.observe(scrollRef.current);
    return () => ro.disconnect();
  }, [toBottom, log?.status]);

  // Sending a message re-pins.
  const lastUserSeq = useMemo(() => {
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.type === 'user.message' && e.origin.kind === 'user') return e.seq;
    }
    return 0;
  }, [list]);
  useEffect(() => {
    if (!lastUserSeq) return;
    pinnedRef.current = true;
    setPinned(true);
    toBottom();
  }, [lastUserSeq, toBottom]);

  // Also re-pin synchronously after new events render (ResizeObserver doesn't run in hidden tabs).
  useLayoutEffect(() => {
    if (pinnedRef.current) toBottom();
  }, [list, toBottom]);

  // Only a scroll *up* by the user unpins; content growing below never does.
  const lastTop = useRef(0);

  // "Show earlier" prepends rows; keep the same content under the viewport.
  const fromBottom = useRef<number | null>(null);
  const showEarlier = () => {
    const el = scrollRef.current;
    if (el) fromBottom.current = el.scrollHeight - el.scrollTop;
    setLimit((l) => l + PAGE);
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && fromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - fromBottom.current;
      fromBottom.current = null;
    }
  }, [limit]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const movedUp = el.scrollTop < lastTop.current - 1;
    lastTop.current = el.scrollTop;
    const next = near ? true : movedUp ? false : pinnedRef.current;
    if (next !== pinnedRef.current) {
      pinnedRef.current = next;
      setPinned(next);
    }
  };

  let body;
  if (!log || (log.status === 'loading' && !list.length)) body = <Loading label="Loading thread" />;
  else if (log.status === 'error' && !list.length)
    body = (
      <EmptyState
        title="Couldn’t load this thread"
        action={
          <Button icon={RotateCw} onClick={() => void loadThread(threadId, true)}>
            Try again
          </Button>
        }
      >
        {log.error}
      </EmptyState>
    );
  else if (!tl.items.length && status === 'idle')
    body = (
      <EmptyState title="Nothing here yet">
        Send a message below to start <span className="mono">@{handle}</span>. Other agents can reach it by that handle too.
      </EmptyState>
    );
  else
    body = (
      <>
        {hiddenCount ? (
          <div className="tl-earlier">
            <Button size="sm" variant="ghost" onClick={showEarlier}>
              Show {Math.min(hiddenCount, PAGE)} earlier
            </Button>
          </div>
        ) : null}
        {shown.map((it) => (
          <div key={it.key} className="tl-row">
            {renderItem(it, tl, pendingIds, busy)}
          </div>
        ))}
        <StreamingTail threadId={threadId} settled={tl.settledItemIds} status={status} lastIsActive={lastIsActive} />
      </>
    );

  return (
    <div className="timeline-wrap">
      <div ref={scrollRef} className="timeline fade-y" onScroll={onScroll}>
        <div ref={contentRef} className="timeline-inner">
          {body}
        </div>
      </div>
      {!pinned ? (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            pinnedRef.current = true;
            setPinned(true);
            toBottom(true);
          }}
        >
          <ArrowDown {...ICON_SM} /> Latest
        </button>
      ) : null}
    </div>
  );
}
