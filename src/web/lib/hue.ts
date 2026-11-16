import type { Persona, Thread } from '../../shared/protocol';

const PROVIDER_HUES: Record<string, number> = { claude: 40, codex: 160, mock: 280 };

export function providerHue(id: string): number {
  if (id in PROVIDER_HUES) return PROVIDER_HUES[id];
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function identity(t: Pick<Thread, 'provider' | 'handle'>, persona: Persona | undefined): { glyph: string; hue: number } {
  if (persona) return { glyph: persona.glyph || persona.name[0] || '?', hue: persona.hue };
  return { glyph: (t.provider[0] ?? '?').toUpperCase(), hue: providerHue(t.provider) };
}
