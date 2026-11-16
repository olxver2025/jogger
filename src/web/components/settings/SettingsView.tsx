import '../../styles/settings.css';
import { useRef } from 'react';
import { Bot, Database, Keyboard, MessageCircle, Palette, Plug, UserRound, type LucideIcon } from 'lucide-react';
import { openView, type SettingsSection } from '../../state/ui';
import { useScrollFade } from '../../lib/hooks';
import { PaneBar } from '../PaneBar';
import { ICON_SM } from '../ui';
import { AppearanceSection } from './Appearance';
import { KeybindingsSection } from './Keybindings';
import { PersonasSection } from './Personas';
import { ProvidersSection } from './Providers';
import { AgentsSection } from './Agents';
import { TelegramSection } from './Telegram';
import { MemorySection } from './Memory';

const SECTIONS: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'keybindings', label: 'Keybindings', icon: Keyboard },
  { id: 'personas', label: 'Personas', icon: UserRound },
  { id: 'providers', label: 'Providers', icon: Plug },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'telegram', label: 'Telegram', icon: MessageCircle },
  { id: 'memory', label: 'Memory', icon: Database },
];

export function SettingsView({ paneIndex, section }: { paneIndex: number; section?: SettingsSection }) {
  const current: SettingsSection = section && SECTIONS.some((s) => s.id === section) ? section : 'appearance';
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);
  const go = (id: SettingsSection) => {
    openView({ kind: 'settings', section: id }, { pane: paneIndex });
    scrollRef.current?.scrollTo({ top: 0 });
  };

  return (
    <>
      <PaneBar paneIndex={paneIndex}>
        <span className="pane-title">Settings</span>
      </PaneBar>
      <div className="settings">
        <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`settings-nav-item${s.id === current ? ' is-on' : ''}`}
              aria-current={s.id === current ? 'page' : undefined}
              onClick={() => go(s.id)}
            >
              <s.icon {...ICON_SM} />
              <span>{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-scroll fade-y" ref={scrollRef}>
          <div className="settings-page">
            {current === 'appearance' && <AppearanceSection />}
            {current === 'keybindings' && <KeybindingsSection />}
            {current === 'personas' && <PersonasSection />}
            {current === 'providers' && <ProvidersSection />}
            {current === 'agents' && <AgentsSection />}
            {current === 'telegram' && <TelegramSection />}
            {current === 'memory' && <MemorySection />}
          </div>
        </div>
        </div>
      </div>
    </>
  );
}
