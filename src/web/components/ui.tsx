import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, LoaderCircle, type LucideIcon } from 'lucide-react';
import type { ThreadStatus } from '../../shared/protocol';
import { comboTokens } from '../lib/keys';
import { createStore, useStore } from '../state/store';

export const ICON = { size: 16, strokeWidth: 1.5 } as const;
export const ICON_SM = { size: 14, strokeWidth: 1.5 } as const;

// ---------------------------------------------------------------- buttons

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  busy?: boolean;
  tip?: string;
};

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, busy, tip, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`btn btn-${variant} btn-${size}${className ? ' ' + className : ''}`}
      disabled={disabled || busy}
      data-tip={tip}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <LoaderCircle {...ICON_SM} className="spin" /> : Icon ? <Icon {...ICON_SM} /> : null}
      {children}
    </button>
  );
});

type IconBtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; active?: boolean; tone?: 'danger' };

export const IconButton = forwardRef<HTMLButtonElement, IconBtnProps>(function IconButton(
  { icon: Icon, label, active, tone, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      data-tip={label}
      className={`icon-btn${active ? ' is-active' : ''}${tone ? ' tone-' + tone : ''}${className ? ' ' + className : ''}`}
      {...rest}
    >
      <Icon {...ICON} />
    </button>
  );
});

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className="icon-btn icon-btn-sm swap"
      aria-label={label}
      data-tip={done ? 'Copied' : label}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => setDone(true));
      }}
    >
      <span className="swap-icon" data-on={!done}>
        <Copy {...ICON_SM} />
      </span>
      <span className="swap-icon" data-on={done}>
        <Check {...ICON_SM} />
      </span>
    </button>
  );
}

export function Kbd({ combo }: { combo: string }) {
  return (
    <span className="kbd-group">
      {comboTokens(combo).map((t, i) => (
        <kbd key={i} className="kbd">
          {t}
        </kbd>
      ))}
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <LoaderCircle size={size} strokeWidth={1.5} className="spin" aria-label="Loading" />;
}

// ---------------------------------------------------------------- form controls

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; tip?: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  label: string;
}) {
  return (
    <div className={`seg seg-${size}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'is-on' : ''}
          data-tip={o.tip}
          onClick={() => o.value !== value && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

export function Field({ label, hint, children, error, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; error?: string | null; htmlFor?: string }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- identity

export function Glyph({ glyph, hue, size = 'md' }: { glyph: string; hue: number; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`glyph glyph-${size}`} style={{ '--g-h': hue } as CSSProperties} aria-hidden>
      {glyph.slice(0, 2)}
    </span>
  );
}

const STATUS_LABEL: Record<ThreadStatus, string> = {
  idle: 'Idle',
  starting: 'Starting',
  running: 'Running',
  waiting: 'Needs approval',
  error: 'Error',
};

export function StatusDot({ status }: { status: ThreadStatus }) {
  return <span className={`status-dot st-${status}`} aria-label={STATUS_LABEL[status]} />;
}

export const statusLabel = (s: ThreadStatus) => STATUS_LABEL[s];

// ---------------------------------------------------------------- tooltip (one global layer, driven by data-tip)

export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  useEffect(() => {
    let timer = 0;
    let target: HTMLElement | null = null;
    const show = (el: HTMLElement, delay: number) => {
      window.clearTimeout(timer);
      target = el;
      timer = window.setTimeout(() => {
        const text = el.dataset.tip;
        if (text && el.isConnected) setTip({ text, rect: el.getBoundingClientRect() });
      }, delay);
    };
    const hide = () => {
      window.clearTimeout(timer);
      target = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
      if (el === target) return;
      if (!el) return hide();
      show(el, tip ? 60 : 450);
    };
    const focus = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      if (el?.matches?.(':focus-visible') && el.dataset?.tip) show(el, 200);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    window.addEventListener('blur', hide);
    document.addEventListener('scroll', hide, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      window.removeEventListener('blur', hide);
      document.removeEventListener('scroll', hide, true);
    };
  }, [tip]);
  if (!tip) return null;
  const below = tip.rect.top < 48;
  const x = Math.min(Math.max(tip.rect.left + tip.rect.width / 2, 120), window.innerWidth - 120);
  return createPortal(
    <div
      className="tooltip"
      role="tooltip"
      style={{ left: x, top: below ? tip.rect.bottom + 6 : tip.rect.top - 6, transform: `translate(-50%, ${below ? '0' : '-100%'})` }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- popover

export function Popover({
  anchor,
  open,
  onClose,
  children,
  align = 'start',
  className,
  width,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: 'start' | 'end';
  className?: string;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const w = width ?? ref.current?.offsetWidth ?? 240;
    const h = ref.current?.offsetHeight ?? 200;
    const up = r.bottom + h + 8 > window.innerHeight && r.top > h + 8;
    let left = align === 'end' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    setPos({ left, top: up ? r.top - 4 : r.bottom + 4, up });
  }, [open, anchor, align, width]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        anchor.current?.focus();
      }
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [open, onClose, anchor]);
  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      className={`popover${className ? ' ' + className : ''}`}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width,
        transform: pos?.up ? 'translateY(-100%)' : undefined,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- menu (global, so context menus and buttons share it)

export type MenuItem =
  | { label: string; icon?: LucideIcon; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | 'sep';

interface MenuState {
  items: MenuItem[];
  x: number;
  y: number;
  alignRight: boolean;
  returnFocus: HTMLElement | null;
}

const menuStore = createStore<MenuState | null>(null);

export function openMenu(at: HTMLElement | { x: number; y: number }, items: MenuItem[]) {
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    menuStore.set(() => ({ items, x: r.right, y: r.bottom + 4, alignRight: true, returnFocus: at }));
  } else {
    menuStore.set(() => ({ items, x: at.x, y: at.y, alignRight: false, returnFocus: null }));
  }
}

export function MenuLayer() {
  const m = useStore(menuStore, (s) => s);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(-1);
  const close = () => {
    const f = menuStore.get()?.returnFocus;
    menuStore.set(() => null);
    f?.focus();
  };
  useLayoutEffect(() => {
    if (!m || !ref.current) return setPos(null);
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    let left = m.alignRight ? m.x - w : m.x;
    let top = m.y;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    if (top + h > window.innerHeight - 8) top = Math.max(8, m.y - h - (m.returnFocus ? m.returnFocus.offsetHeight + 8 : 0));
    setPos({ left, top });
    setActive(-1);
    ref.current.focus();
  }, [m]);
  useEffect(() => {
    if (!m) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) menuStore.set(() => null);
    };
    const blur = () => menuStore.set(() => null);
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', blur);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', blur);
    };
  }, [m]);
  if (!m) return null;
  const selectable = m.items.map((it, i) => (it !== 'sep' && !it.disabled ? i : -1)).filter((i) => i >= 0);
  return createPortal(
    <div
      ref={ref}
      className="menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const cur = selectable.indexOf(active);
          const next = e.key === 'ArrowDown' ? (cur + 1) % selectable.length : (cur - 1 + selectable.length) % selectable.length;
          setActive(selectable[next] ?? -1);
        } else if (e.key === 'Enter' && active >= 0) {
          e.preventDefault();
          const it = m.items[active];
          if (it !== 'sep') {
            close();
            it.onSelect();
          }
        }
      }}
    >
      {m.items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            className={`menu-item${it.danger ? ' is-danger' : ''}${i === active ? ' is-active' : ''}`}
            onPointerEnter={() => setActive(i)}
            onClick={() => {
              close();
              it.onSelect();
            }}
          >
            {it.icon ? <it.icon {...ICON_SM} /> : <span className="menu-icon-gap" />}
            <span className="menu-label">{it.label}</span>
            {it.hint ? <span className="menu-hint">{it.hint}</span> : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- confirm dialog

interface ConfirmReq {
  title: string;
  body?: ReactNode;
  confirm: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const confirmStore = createStore<ConfirmReq | null>(null);

export function confirmDialog(opts: { title: string; body?: ReactNode; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    confirmStore.set(() => ({ ...opts, confirm: opts.confirm ?? 'Confirm', resolve }));
  });
}

export function ConfirmLayer() {
  const req = useStore(confirmStore, (s) => s);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (req) okRef.current?.focus();
  }, [req]);
  if (!req) return null;
  const done = (ok: boolean) => {
    confirmStore.set(() => null);
    req.resolve(ok);
  };
  return createPortal(
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && done(false)}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            done(false);
          }
        }}
      >
        <h2 id="confirm-title" className="dialog-title">
          {req.title}
        </h2>
        {req.body ? <div className="dialog-body">{req.body}</div> : null}
        <div className="dialog-actions">
          <Button variant="ghost" onClick={() => done(false)}>
            Cancel
          </Button>
          <Button ref={okRef} variant={req.danger ? 'danger' : 'primary'} onClick={() => done(true)}>
            {req.confirm}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- empty / loading states

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3 className="empty-title">{title}</h3>
      {children ? <div className="empty-body">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading">
      <Spinner /> <span>{label}…</span>
    </div>
  );
}
