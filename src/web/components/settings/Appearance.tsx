import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../../../shared/protocol';
import { useApp } from '../../state/app';
import { PALETTES, previewAccent } from '../../lib/theme';
import { useDebouncedCallback } from '../../lib/hooks';
import { Segmented } from '../ui';
import { SectionHead, SettingRow, saveSettings } from './common';

const PALETTE_IDS = Object.keys(PALETTES) as Settings['palette'][];

export function AppearanceSection() {
  const s = useApp((st) => st.settings);
  const [hue, setHue] = useState<number | null>(null);
  const seq = useRef(0);

  const commitHue = useDebouncedCallback((h: number) => {
    const mine = seq.current;
    void saveSettings({ accentHue: h }).finally(() => {
      // Only drop the draft if the slider hasn't moved again since this save started.
      if (seq.current !== mine) return;
      previewAccent(null);
      setHue(null);
    });
  }, 300);

  // Leaving the page mid-drag must not leave a preview stuck on.
  useEffect(() => () => previewAccent(null), []);

  const shownHue = hue ?? s.accentHue;

  return (
    <section className="section">
      <SectionHead title="Appearance" desc="How Jogger looks on this machine. Changes apply immediately." />

      <SettingRow label="Theme" desc="System follows your operating system's light or dark setting.">
        <Segmented
          label="Theme"
          value={s.theme}
          onChange={(theme) => void saveSettings({ theme })}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </SettingRow>

      <SettingRow label="Neutral palette" desc="The tint of backgrounds, surfaces and text.">
        <div className="swatches" role="radiogroup" aria-label="Neutral palette">
          {PALETTE_IDS.map((id) => {
            const p = PALETTES[id];
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={s.palette === id}
                className={`swatch${s.palette === id ? ' is-on' : ''}`}
                data-tip={p.label}
                onClick={() => s.palette !== id && void saveSettings({ palette: id })}
              >
                <span
                  className="swatch-chip"
                  style={{
                    background: `linear-gradient(in oklch 135deg, oklch(97% ${p.c} ${p.h}) 0 50%, oklch(24% ${p.c * 2} ${p.h}) 50% 100%)`,
                  }}
                />
                <span className="swatch-label">{p.label}</span>
              </button>
            );
          })}
        </div>
      </SettingRow>

      <div className="setting setting-stack">
        <div className="setting-text">
          <div className="setting-label">
            Accent hue <span className="muted num">{Math.round(shownHue)}°</span>
          </div>
          <div className="setting-desc">Used for the primary button, focus rings, links and the focused pane.</div>
        </div>
        <div className="accent-row">
          <input
            type="range"
            min={0}
            max={360}
            step={1}
            value={shownHue}
            aria-label="Accent hue"
            className="hue-slider"
            onChange={(e) => {
              const h = Number(e.target.value);
              seq.current++;
              setHue(h);
              previewAccent(h);
              commitHue(h);
            }}
          />
          <div className="accent-preview" aria-hidden>
            <span className="btn btn-primary btn-sm">Primary</span>
            <span className="accent-focus-sample">Focus</span>
            <a href="#" tabIndex={-1} onClick={(e) => e.preventDefault()}>
              Link
            </a>
          </div>
        </div>
      </div>

      <SettingRow label="Density" desc="Compact tightens rows and controls.">
        <Segmented
          label="Density"
          value={s.density}
          onChange={(density) => void saveSettings({ density })}
          options={[
            { value: 'compact', label: 'Compact' },
            { value: 'regular', label: 'Regular' },
          ]}
        />
      </SettingRow>

      <SettingRow label="Background" desc="The texture behind the panes.">
        <Segmented
          label="Background"
          value={s.background}
          onChange={(background) => void saveSettings({ background })}
          options={[
            { value: 'grid', label: 'Grid' },
            { value: 'dots', label: 'Dots' },
            { value: 'plain', label: 'Plain' },
          ]}
        />
      </SettingRow>
    </section>
  );
}
