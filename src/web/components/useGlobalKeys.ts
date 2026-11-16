import { useEffect } from 'react';
import { DEFAULT_KEYBINDINGS } from '../../shared/protocol';
import { api, attempt } from '../state/api';
import { getApp, isBusy } from '../state/app';
import { closePane, cyclePane, focusedView, openView, requestComposerFocus, setPalette, splitPane, toggleSidebar, uiStore } from '../state/ui';
import { isEditable, matches, parseCombo } from '../lib/keys';

const ACTIONS: Record<string, () => void> = {
  'palette.open': () => setPalette(!uiStore.get().palette),
  'thread.new': () => openView({ kind: 'new' }),
  'pane.split': () => splitPane(),
  'pane.close': () => closePane(),
  'pane.next': () => cyclePane(1),
  'pane.prev': () => cyclePane(-1),
  'thread.interrupt': () => {
    const v = focusedView();
    if (v?.kind !== 'thread') return;
    const t = getApp().threads.find((x) => x.id === v.threadId);
    if (t && isBusy(t)) void attempt(api.interrupt(t.id));
  },
  'composer.focus': () => requestComposerFocus(),
  'settings.open': () => openView({ kind: 'settings' }),
  'sidebar.toggle': () => toggleSidebar(),
};

/** One window-level (bubble phase) handler for every rebindable action. */
export function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const ui = uiStore.get();
      const bindings = { ...DEFAULT_KEYBINDINGS, ...getApp().settings.keybindings };
      for (const [action, combo] of Object.entries(bindings)) {
        if (!combo || !matches(e, combo)) continue;
        const c = parseCombo(combo);
        const bare = c && !c.mod && !c.ctrl && !c.alt;
        if (bare && isEditable(e.target)) continue; // let "/" type a slash in inputs
        if (ui.palette && action !== 'palette.open') continue;
        const run = ACTIONS[action];
        if (!run) continue;
        e.preventDefault();
        run();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
