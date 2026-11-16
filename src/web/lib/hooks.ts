import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Marks a scroll container with data-fade-top / data-fade-bottom when content is clipped (pair with .fade-y). */
export function useScrollFade(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const top = el.scrollTop > 2;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
      if (el.dataset.fadeTop !== (top ? '1' : '0')) el.dataset.fadeTop = top ? '1' : '0';
      if (el.dataset.fadeBottom !== (bottom ? '1' : '0')) el.dataset.fadeBottom = bottom ? '1' : '0';
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [ref]);
}

/** Grow a textarea with its content up to maxPx. */
export function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxPx = 320) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
    el.style.overflowY = el.scrollHeight > maxPx ? 'auto' : 'hidden';
  }, [ref, value, maxPx]);
}

export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return useRef((...args: A) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => fnRef.current(...args), ms);
  }).current;
}

/** Re-render every `ms` (for relative timestamps). */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
