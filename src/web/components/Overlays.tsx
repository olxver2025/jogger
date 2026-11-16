import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, CircleCheck, Download, Info, RotateCw, WifiOff, X } from 'lucide-react';
import { appStore } from '../state/app';
import { useStore } from '../state/store';
import { dismissToast, toastStore } from '../state/toast';
import { setLightbox, useUi } from '../state/ui';
import { reconnectNow } from '../state/ws';
import { bytes } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Button, ICON_SM, IconButton } from './ui';

export function Toasts() {
  const toasts = useStore(toastStore, (s) => s);
  if (!toasts.length) return null;
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast is-${t.kind}`}>
          {t.kind === 'error' ? <CircleAlert {...ICON_SM} /> : t.kind === 'ok' ? <CircleCheck {...ICON_SM} /> : <Info {...ICON_SM} />}
          <span className="toast-text">{t.text}</span>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X {...ICON_SM} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function Lightbox() {
  const a = useUi((s) => s.lightbox);
  useEffect(() => {
    if (!a) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setLightbox(null);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [a]);
  if (!a) return null;
  return createPortal(
    <div className="lightbox" onClick={() => setLightbox(null)} role="dialog" aria-modal="true" aria-label={a.name}>
      <div style={{ display: 'grid', justifyItems: 'center' }}>
        <img src={a.url} alt={a.name} onClick={(e) => e.stopPropagation()} />
        <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
          <span className="mono">{a.name}</span>
          <span className="muted num">{bytes(a.size)}</span>
          <a href={a.url} download={a.name} className="icon-btn icon-btn-sm" aria-label="Download" data-tip="Download">
            <Download {...ICON_SM} />
          </a>
          <IconButton icon={X} label="Close" onClick={() => setLightbox(null)} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ConnectionBanner() {
  const conn = useStore(appStore, (a) => a.conn);
  const retryAt = useStore(appStore, (a) => a.retryAt);
  const now = useNow(1000);
  if (conn === 'open') return null;
  if (conn === 'connecting' && !retryAt) return null;
  const secs = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
  return (
    <div className="banner" role="alert">
      <WifiOff {...ICON_SM} />
      <span className="banner-text">
        Lost connection to the Jogger daemon.{' '}
        <span className="muted num">{conn === 'connecting' ? 'Reconnecting…' : secs > 0 ? `Retrying in ${secs}s` : 'Retrying…'}</span>
      </span>
      <Button size="sm" variant="ghost" icon={RotateCw} onClick={reconnectNow}>
        Retry now
      </Button>
    </div>
  );
}
