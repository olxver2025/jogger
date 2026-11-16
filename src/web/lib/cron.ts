// Plain-English previews for the cron patterns people actually use. Anything else gets a neutral label.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function time(h: string, m: string): string | null {
  if (!/^\d+$/.test(h) || !/^\d+$/.test(m)) return null;
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

function dayList(dow: string): string | null {
  if (dow === '1-5') return 'weekdays';
  if (dow === '0,6' || dow === '6,0') return 'weekends';
  if (/^[0-7](,[0-7])*$/.test(dow)) {
    const names = dow.split(',').map((d) => DAYS[Number(d) % 7] + 's');
    return names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  return null;
}

export function describeCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts;
  if (mon !== '*') return null;
  const every = /^\*\/(\d+)$/;
  if (h === '*' && dom === '*' && dow === '*') {
    if (m === '*') return 'Every minute';
    const em = m.match(every);
    if (em) return `Every ${em[1]} minutes`;
    if (/^\d+$/.test(m)) return m === '0' ? 'Every hour, on the hour' : `Every hour at :${m.padStart(2, '0')}`;
    return null;
  }
  const eh = h.match(every);
  if (eh && /^\d+$/.test(m) && dom === '*' && dow === '*') return `Every ${eh[1]} hours at :${m.padStart(2, '0')}`;
  const at = time(h, m);
  if (!at) return null;
  if (dom === '*' && dow === '*') return `Every day at ${at}`;
  if (dom === '*') {
    const days = dayList(dow);
    return days ? `${days[0].toUpperCase() + days.slice(1)} at ${at}` : null;
  }
  if (/^\d+$/.test(dom) && dow === '*') return `Monthly on day ${dom} at ${at}`;
  return null;
}

export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Weekdays 9:00', cron: '0 9 * * 1-5' },
  { label: 'Every day 9:00', cron: '0 9 * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 15 min', cron: '*/15 * * * *' },
  { label: 'Mondays 9:00', cron: '0 9 * * 1' },
];
