/** Subsequence match with a score that favours word starts and contiguous runs. -1 = no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct - (direct > 0 && /\w/.test(t[direct - 1]) ? 200 : 0);
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const at = t.indexOf(ch, ti);
    if (at < 0) return -1;
    const wordStart = at === 0 || /[\s@/._-]/.test(t[at - 1]);
    run = at === ti ? run + 1 : 0;
    score += 10 + run * 5 + (wordStart ? 15 : 0) - Math.min(at - ti, 10);
    ti = at + 1;
  }
  return score;
}
