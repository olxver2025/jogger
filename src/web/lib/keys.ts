// Keybinding strings look like "mod+k", "mod+shift+o", "mod+\\", "/".
// "mod" is ⌘ on macOS and Ctrl elsewhere.

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

interface Combo {
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

const cache = new Map<string, Combo | null>();

export function parseCombo(s: string): Combo | null {
  if (cache.has(s)) return cache.get(s)!;
  const parts = s.toLowerCase().split('+');
  // "mod++" style: a trailing empty part means the key itself is "+"
  let key = parts.pop() ?? '';
  if (key === '' && parts[parts.length - 1] === '') {
    parts.pop();
    key = '+';
  }
  const c: Combo = { mod: false, ctrl: false, shift: false, alt: false, key };
  for (const p of parts) {
    if (p === 'mod' || p === 'cmd' || p === 'meta') c.mod = true;
    else if (p === 'ctrl') c.ctrl = true;
    else if (p === 'shift') c.shift = true;
    else if (p === 'alt' || p === 'option') c.alt = true;
  }
  const out = key ? c : null;
  cache.set(s, out);
  return out;
}

const CODE_KEYS: Record<string, string> = {
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

/** The key name for an event, independent of Shift/Option altering e.key. */
export function eventKey(e: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (CODE_KEYS[e.code]) return CODE_KEYS[e.code];
  const k = e.key.toLowerCase();
  if (k === ' ') return 'space';
  if (k === 'esc') return 'escape';
  return k;
}

export function matches(e: KeyboardEvent, combo: string): boolean {
  const c = parseCombo(combo);
  if (!c) return false;
  const modDown = isMac ? e.metaKey : e.ctrlKey;
  const ctrlDown = isMac ? e.ctrlKey : false;
  if (c.mod !== modDown || c.ctrl !== ctrlDown || c.alt !== e.altKey) return false;
  const key = eventKey(e);
  // "/" and similar are typed with Shift on some layouts; only enforce Shift when the combo says so
  // or when the combo has a modifier.
  if (c.shift !== e.shiftKey && (c.shift || c.mod || c.ctrl || c.alt)) return false;
  return key === c.key || e.key.toLowerCase() === c.key;
}

/** Build a combo string from a keydown event, or null for a lone modifier. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (['Meta', 'Control', 'Shift', 'Alt', 'CapsLock', 'Fn'].includes(e.key)) return null;
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod');
  if (isMac && e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(eventKey(e));
  return parts.join('+');
}

const MAC_SYMBOLS: Record<string, string> = { mod: '⌘', ctrl: '⌃', shift: '⇧', alt: '⌥' };
const OTHER_NAMES: Record<string, string> = { mod: 'Ctrl', ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt' };
const KEY_NAMES: Record<string, string> = { escape: 'Esc', enter: '↵', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', space: 'Space', backspace: '⌫' };

/** Split a combo into display tokens, e.g. ["⌘", "⇧", "O"]. */
export function comboTokens(combo: string): string[] {
  const c = parseCombo(combo);
  if (!c) return [combo];
  const out: string[] = [];
  const names = isMac ? MAC_SYMBOLS : OTHER_NAMES;
  if (c.ctrl) out.push(names.ctrl);
  if (c.alt) out.push(names.alt);
  if (c.shift) out.push(names.shift);
  if (c.mod) out.push(names.mod);
  out.push(KEY_NAMES[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key[0].toUpperCase() + c.key.slice(1)));
  return out;
}

export const formatCombo = (combo: string) => comboTokens(combo).join(isMac ? '' : '+');

export function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'color'].includes(type);
  }
  return false;
}
