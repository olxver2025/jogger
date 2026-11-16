import { useEffect } from 'react';
import { PanelLeft } from 'lucide-react';
import { appStore, useApp } from './state/app';
import { useStore } from './state/store';
import { toggleSidebar, useUi } from './state/ui';
import { applyTheme } from './lib/theme';
import { CommandPalette } from './components/CommandPalette';
import { ConnectionBanner, Lightbox, Toasts } from './components/Overlays';
import { FirstRun, PaneGrid } from './components/Panes';
import { Sidebar } from './components/Sidebar';
import { ConfirmLayer, IconButton, MenuLayer, Spinner, TooltipLayer } from './components/ui';
import { useGlobalKeys } from './components/useGlobalKeys';
import './styles/sidebar.css';
import './styles/views.css';

export function App() {
  const boot = useStore(appStore, (a) => a.boot);
  const bootError = useStore(appStore, (a) => a.bootError);
  const hasState = useStore(appStore, (a) => !!a.state);
  const settings = useApp((s) => s.settings);
  useEffect(() => applyTheme(settings), [settings]);

  if (boot === 'unauthorized') {
    return (
      <div className="boot">
        <div className="boot-card">
          <h1>Sign in to Jogger</h1>
          <p>
            This browser doesn’t have the daemon’s session cookie yet. Run <code>npx jogger open</code> (or <code>node bin/jogger.mjs open</code>) in the Jogger
            folder; it opens the sign-in link with your local token.
          </p>
        </div>
      </div>
    );
  }
  if (!hasState) {
    return (
      <div className="boot">
        <div className="boot-card">
          {boot === 'error' ? (
            <>
              <h1>Can’t reach the Jogger daemon</h1>
              <p>
                {bootError ? `${bootError}. ` : ''}Start it with <code>npx jogger start</code>. This page retries every few seconds.
              </p>
            </>
          ) : (
            <p className="loading">
              <Spinner /> Connecting…
            </p>
          )}
        </div>
      </div>
    );
  }
  return <Shell />;
}

function Shell() {
  const sidebar = useUi((s) => s.sidebar);
  const hasProjects = useApp((s) => s.projects.length > 0);
  useGlobalKeys();
  return (
    <div className={`shell${sidebar ? '' : ' no-sidebar'}`}>
      <Sidebar />
      <main className="main">
        {!sidebar ? (
          <div className="sb-reveal">
            <IconButton icon={PanelLeft} label="Show sidebar" onClick={toggleSidebar} />
          </div>
        ) : null}
        <ConnectionBanner />
        {hasProjects ? <PaneGrid /> : <FirstRun />}
      </main>
      <CommandPalette />
      <MenuLayer />
      <ConfirmLayer />
      <Lightbox />
      <Toasts />
      <TooltipLayer />
    </div>
  );
}
