import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { ArrowUp, File as FileIcon, GitBranch, Paperclip, Square, X } from 'lucide-react';
import type { Attachment, Thread } from '../../shared/protocol';
import { api, attempt } from '../state/api';
import { isBusy } from '../state/app';
import { toast } from '../state/toast';
import { useUi } from '../state/ui';
import { useAutosize } from '../lib/hooks';
import { bytes, tokens } from '../lib/format';
import { Button, ICON_SM, IconButton, Spinner } from './ui';

export interface Upload {
  key: string;
  name: string;
  status: 'uploading' | 'done' | 'error';
  attachment?: Attachment;
  preview?: string;
  error?: string;
}

/** Drafts survive switching threads and closing panes (for this tab's lifetime). */
const drafts = new Map<string, { text: string; uploads: Upload[] }>();
let keySeq = 0;

/** Upload a batch of files, reporting progress through setUploads. Shared with the new-thread form. */
export function useUploads(initial: Upload[] = []) {
  const [uploads, setUploads] = useState<Upload[]>(initial);
  const add = (files: File[]) => {
    for (const file of files) {
      const key = `u${++keySeq}`;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      setUploads((u) => [...u, { key, name: file.name || 'pasted image', status: 'uploading', preview }]);
      api
        .upload(file)
        .then((attachment) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, status: 'done', attachment } : x))))
        .catch((err: Error) => {
          setUploads((u) => u.map((x) => (x.key === key ? { ...x, status: 'error', error: err.message } : x)));
          toast(`Upload failed: ${file.name || 'file'} — ${err.message}`, 'error');
        });
    }
  };
  const remove = (key: string) =>
    setUploads((u) => {
      const it = u.find((x) => x.key === key);
      if (it?.preview) URL.revokeObjectURL(it.preview);
      return u.filter((x) => x.key !== key);
    });
  return { uploads, setUploads, add, remove };
}

export function filesFromClipboard(e: ClipboardEvent): File[] {
  const files: File[] = [];
  for (const item of e.clipboardData?.items ?? []) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  return files;
}

export function UploadChips({ uploads, onRemove }: { uploads: Upload[]; onRemove: (key: string) => void }) {
  if (!uploads.length) return null;
  return (
    <div className="upload-chips">
      {uploads.map((u) => (
        <div key={u.key} className={`upload-chip is-${u.status}`} data-tip={u.error ?? u.name}>
          {u.preview ? <img src={u.preview} alt="" /> : <FileIcon {...ICON_SM} />}
          <span className="upload-chip-name">{u.name}</span>
          {u.status === 'uploading' ? <Spinner size={12} /> : null}
          {u.status === 'done' && u.attachment ? <span className="upload-chip-size num">{bytes(u.attachment.size)}</span> : null}
          {u.status === 'error' ? <span className="upload-chip-err">failed</span> : null}
          <button type="button" className="upload-chip-x" aria-label={`Remove ${u.name}`} onClick={() => onRemove(u.key)}>
            <X size={12} strokeWidth={1.5} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Composer({ thread, focused }: { thread: Thread; focused: boolean }) {
  const saved = drafts.get(thread.id);
  const [text, setText] = useState(saved?.text ?? '');
  const { uploads, setUploads, add, remove } = useUploads(saved?.uploads ?? []);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const focusTick = useUi((s) => s.focusComposer);
  useAutosize(ref, text, 280);

  // Swap drafts when the pane switches thread.
  const threadRef = useRef(thread.id);
  useEffect(() => {
    if (threadRef.current === thread.id) return;
    threadRef.current = thread.id;
    const d = drafts.get(thread.id);
    setText(d?.text ?? '');
    setUploads(d?.uploads ?? []);
  }, [thread.id, setUploads]);
  useEffect(() => {
    if (text || uploads.length) drafts.set(thread.id, { text, uploads });
    else drafts.delete(thread.id);
  }, [thread.id, text, uploads]);

  // Only react to a new request, not to the pane becoming focused later.
  const seenTick = useRef(focusTick);
  useEffect(() => {
    if (focusTick === seenTick.current) return;
    seenTick.current = focusTick;
    if (focused) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick]);

  const uploading = uploads.some((u) => u.status === 'uploading');
  const ready = uploads.filter((u) => u.status === 'done' && u.attachment);
  const canSend = !sending && !uploading && (text.trim().length > 0 || ready.length > 0);
  const busy = isBusy(thread);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const ids = ready.map((u) => u.attachment!.id);
    const r = await attempt(api.send(thread.id, text, ids.length ? ids : undefined).then(() => true));
    setSending(false);
    if (r) {
      for (const u of uploads) if (u.preview) URL.revokeObjectURL(u.preview);
      setText('');
      setUploads([]);
      drafts.delete(thread.id);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) add(files);
  };

  const { usage } = thread;
  const hasUsage = usage.inputTokens + usage.outputTokens > 0;

  return (
    <div className="composer-wrap">
      {thread.queued > 0 ? (
        <div className="queued-bar">
          <span className="num">{thread.queued} queued</span>
          <span aria-hidden>·</span>
          <button type="button" className="link-btn" onClick={() => void attempt(api.clearQueue(thread.id))}>
            clear
          </button>
        </div>
      ) : null}
      <div
        className={`composer${dragging ? ' is-dragging' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer?.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={onDrop}
        onClick={(e) => {
          if (e.target === e.currentTarget) ref.current?.focus();
        }}
      >
        <UploadChips uploads={uploads} onRemove={remove} />
        <textarea
          ref={ref}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={busy ? `Message @${thread.handle} — it will run after the current turn` : `Message @${thread.handle}`}
          aria-label={`Message @${thread.handle}`}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = filesFromClipboard(e);
            if (files.length) {
              e.preventDefault();
              add(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            } else if (e.key === 'Escape') {
              ref.current?.blur();
            }
          }}
        />
        <div className="composer-bar">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              add([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <IconButton icon={Paperclip} label="Attach files or images" onClick={() => fileRef.current?.click()} />
          <div className="composer-meta">
            {thread.worktree ? (
              <span className="meta-chip mono" data-tip={thread.worktree.path}>
                <GitBranch size={12} strokeWidth={1.5} />
                {thread.worktree.branch}
              </span>
            ) : null}
            {hasUsage ? (
              <span className="meta-usage num mono" data-tip="Tokens used by this thread (input · output)">
                {tokens(usage.inputTokens)} in · {tokens(usage.outputTokens)} out
                {usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(2)}` : ''}
              </span>
            ) : null}
          </div>
          {busy ? (
            <Button variant="secondary" size="md" icon={Square} onClick={() => void attempt(api.interrupt(thread.id))} tip="Stop the running turn">
              Stop
            </Button>
          ) : null}
          <Button
            variant="primary"
            className="composer-send"
            onClick={() => void send()}
            disabled={!canSend}
            busy={sending}
            aria-label={uploading ? 'Uploading' : busy ? 'Queue message' : 'Send message'}
          >
            {uploading ? 'Uploading…' : busy ? 'Queue' : <ArrowUp {...ICON_SM} />}
          </Button>
        </div>
      </div>
    </div>
  );
}
