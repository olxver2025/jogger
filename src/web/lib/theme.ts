import type { Settings } from '../../shared/protocol';

export const PALETTES: Record<Settings['palette'], { h: number; c: number; label: string }> = {
  graphite: { h: 260, c: 0.006, label: 'Graphite' },
  paper: { h: 75, c: 0.014, label: 'Paper' },
  slate: { h: 245, c: 0.022, label: 'Slate' },
  moss: { h: 135, c: 0.016, label: 'Moss' },
};

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let current: Pick<Settings, 'theme' | 'palette' | 'accentHue' | 'density' | 'background'> | null = null;
let accentPreview: number | null = null;

function resolvedTheme(mode: Settings['theme']): 'light' | 'dark' {
  if (mode === 'system') return media?.matches ? 'dark' : 'light';
  return mode;
}

function setFavicon(hue: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="oklch(54% 0.16 ${hue})"/><circle cx="11" cy="12" r="4" fill="oklch(98% 0.01 ${hue})"/><circle cx="21" cy="20" r="4" fill="none" stroke="oklch(98% 0.01 ${hue})" stroke-width="2.5"/><path d="M14 15 L18 17" stroke="oklch(98% 0.01 ${hue})" stroke-width="2.5" stroke-linecap="round"/></svg>`;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let lastFaviconHue = -1;

function apply() {
  if (!current) return;
  const root = document.documentElement;
  const pal = PALETTES[current.palette] ?? PALETTES.graphite;
  const hue = accentPreview ?? current.accentHue;
  root.dataset.theme = resolvedTheme(current.theme);
  root.dataset.density = current.density;
  root.dataset.bg = current.background;
  root.style.setProperty('--accent-h', String(hue));
  root.style.setProperty('--n-h', String(pal.h));
  root.style.setProperty('--n-c', String(pal.c));
  if (Math.round(hue) !== lastFaviconHue && accentPreview === null) {
    lastFaviconHue = Math.round(hue);
    setFavicon(hue);
  }
}

export function applyTheme(s: Settings) {
  current = { theme: s.theme, palette: s.palette, accentHue: s.accentHue, density: s.density, background: s.background };
  apply();
}

/** Live preview while dragging the accent slider; pass null to go back to the saved value. */
export function previewAccent(h: number | null) {
  accentPreview = h;
  apply();
}

media?.addEventListener('change', apply);
