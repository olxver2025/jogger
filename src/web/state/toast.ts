import { createStore } from './store';

export interface Toast {
  id: number;
  kind: 'error' | 'info' | 'ok';
  text: string;
}

export const toastStore = createStore<Toast[]>([]);
let n = 0;

export function toast(text: string, kind: Toast['kind'] = 'info', ms = kind === 'error' ? 6000 : 3000) {
  const id = ++n;
  toastStore.set((list) => [...list.slice(-3), { id, kind, text }]);
  window.setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id: number) {
  toastStore.set((list) => (list.some((t) => t.id === id) ? list.filter((t) => t.id !== id) : list));
}
