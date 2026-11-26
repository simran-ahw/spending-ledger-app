// Shared, dependency-free spending logic. Used by the server functions (Deno)
// and copied into the web app at deploy time, so both compute the same numbers.

export const pad = (n) => String(n).padStart(2, '0');
export const r2 = (v) => Math.round(v * 100) / 100;
const D = (ds) => new Date(ds + 'T12:00:00Z');
const isoUTC = (d) => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
export const addDays = (ds, n) => { const d = D(ds); d.setUTCDate(d.getUTCDate() + n); return isoUTC(d); };
export const mondayOf = (ds) => { const d = D(ds); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return isoUTC(d); };
export const shiftYM = (ym, k) => { let [y, m] = ym.split('-').map(Number); m += k; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return y + '-' + pad(m); };
export const dim = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortD = (ds) => MON[+ds.slice(5, 7) - 1] + ' ' + (+ds.slice(8, 10));

export const DEFAULT_SETTINGS = {
  income: 0, target: 0, currency: 'CAD',
  cats: ['Groceries', 'Transport', 'Eating out', 'Loan', 'Rent', 'Bills', 'Shopping', 'Health', 'Entertainment', 'Other'],
  mandatory: ['Rent', 'Loan', 'Bills'],
  cards: ['Credit card', 'Debit card', 'Cash', 'E-transfer', 'Auto-debit'],
  recurring: [], limits: {},
  notify: { purchase: true, limits: true, daily: true, dailyHour: 20, weekly: true },
  tz: 'America/Toronto',
};
export const withDefaults = (s) => ({ ...DEFAULT_SETTINGS, ...(s || {}), notify: { ...DEFAULT_SETTINGS.notify, ...((s && s.notify) || {}) } });

/** Local date and hour in a time zone. */
export function localNow(tz, now = new Date()) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now); }
  catch { parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now); }
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: g('year') + '-' + g('month') + '-' + g('day'), hour: +g('hour') % 24 };
}

export function fmt(v, currency = 'CAD') {
  try { return new Intl.NumberFormat('en-CA', { style: 'currency', currency, maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }).format(v); }
  catch { return '$' + (+v).toFixed(2); }
}

// ---- rows <-> items --------------------------------------------------------
export const rowToItem = (r) => ({ kind: 'exp', id: r.id, date: typeof r.date === 'string' ? r.date.slice(0, 10) : r.date, amount: +r.amount, category: r.category, splits: r.splits || null, merchant: r.merchant || '', note: r.note || '', paidWith: r.paid_with || '', source: r.source || 'manual', recurId: r.recur_id || null, alert: r.alert || null, created: r.created_at ? Date.parse(r.created_at) : 0 });
export const itemToRow = (i) => ({ id: i.id, date: i.date, amount: r2(+i.amount), category: i.category, splits: i.splits && i.splits.length ? i.splits : null, merchant: i.merchant || '', note: i.note || '', paid_with: i.paidWith || '', source: i.source || 'manual', recur_id: i.recurId || null, alert: i.alert || null });

// ---- totals ----------------------------------------------------------------
export const parts = (i) => (i.splits && i.splits.length ? i.splits : [{ category: i.category, amount: +i.amount || 0 }]);
export function catTotals(items, ym) {
  const o = {};
  for (const i of items) if (i.date && i.date.startsWith(ym)) for (const p of parts(i)) o[p.category] = (o[p.category] || 0) + (+p.amount || 0);
  return o;
}
const isFixed = (s, c) => (s.mandatory || []).includes(c);
const ceil10 = (v) => Math.ceil(v / 10) * 10;

export function suggestLimits(items, s, thisYM) {
  const ms = [1, 2, 3].map((k) => shiftYM(thisYM, -k)).filter((m) => items.some((i) => i.date && i.date.startsWith(m))), o = {};
  if (!ms.length) return o;
  const tots = ms.map((m) => catTotals(items, m)), cats = new Set(tots.flatMap((t) => Object.keys(t)));
  for (const c of cats) { const avg = tots.reduce((a, t) => a + (t[c] || 0), 0) / ms.length; if (avg >= 5) o[c] = isFixed(s, c) ? ceil10(avg) : ceil10(avg * 0.9); }
  return o;
}

/** Allowance and projection for a month. `today` is the user's local date. */
export function budgetInfo(items, s, ym, today) {
  const t = catTotals(items, ym), days = dim(ym), cur = ym === today.slice(0, 7), elapsed = cur ? +today.slice(8) : days;
  let fixed = 0, flex = 0; for (const [c, v] of Object.entries(t)) isFixed(s, c) ? (fixed += v) : (flex += v);
  let fixedLast = 0; for (const [c, v] of Object.entries(catTotals(items, shiftYM(ym, -1)))) if (isFixed(s, c)) fixedLast += v;
  const fixedExp = Math.max(fixed, fixedLast), income = +s.income || 0, target = +s.target || 0;
  const flexBudget = income - target - fixedExp, daily = flexBudget / days;
  const projFlex = elapsed ? (flex / elapsed) * days : 0, projected = fixedExp + projFlex, left = days - elapsed;
  return { fixed, flex, fixedExp, income, target, flexBudget, daily, projFlex, projected, projSaved: income - projected, days, elapsed, left, perDay: left > 0 ? (flexBudget - flex) / left : null };
}

/** Messages for categories that `added` items push past 80% or 100% of their limit. */
export function limitWarnings(items, s, added, today) {
  if (!added.length) return [];
  const ids = new Set(added.map((i) => i.id)), lims = s.limits || {}, msgs = [], byYm = {};
  for (const i of added) for (const p of parts(i)) { const k = i.date.slice(0, 7); (byYm[k] ??= {}); byYm[k][p.category] = (byYm[k][p.category] || 0) + (+p.amount || 0); }
  for (const [ym, adds] of Object.entries(byYm)) {
    const base = {};
    for (const i of items) if (i.date && i.date.startsWith(ym) && !ids.has(i.id)) for (const p of parts(i)) base[p.category] = (base[p.category] || 0) + (+p.amount || 0);
    for (const [c, a] of Object.entries(adds)) {
      const L = +lims[c] || 0; if (!L) continue;
      const b = base[c] || 0, n = b + a, f = (v) => fmt(v, s.currency);
      if (n > L && b <= L) msgs.push(`${c} is now over its ${f(L)} limit (${f(n)}).`);
      else if (n > L) msgs.push(`${c} is ${f(n - L)} over its limit.`);
      else if (n >= 0.8 * L && b < 0.8 * L) msgs.push(`${c} has reached ${Math.round((n / L) * 100)}% of its ${f(L)} limit — ${f(L - n)} left` + (ym === today.slice(0, 7) ? ` for ${dim(ym) - +today.slice(8)} more days.` : '.'));
    }
  }
  return msgs;
}

/** Weekly check-in for flexible categories that have a monthly limit. */
export function weekly(items, s, today) {
  const lims = s.limits || {}, cats = Object.keys(lims).filter((c) => +lims[c] > 0 && !isFixed(s, c));
  const dm = {};
  for (const i of items) if (i.date) for (const p of parts(i)) { const d = (dm[i.date] ??= {}); d[p.category] = (d[p.category] || 0) + (+p.amount || 0); }
  const cw = mondayOf(today), lw = addDays(cw, -7);
  const first = items.reduce((m, i) => (i.date && i.date < m ? i.date : m), today), fw = mondayOf(first);
  const spend = (c, ws) => { let v = 0; for (let k = 0; k < 7; k++) v += (dm[addDays(ws, k)] || {})[c] || 0; return v; };
  const allow = (c, ws) => { let v = 0; for (let k = 0; k < 7; k++) v += +lims[c] / dim(addDays(ws, k).slice(0, 7)); return v; };
  let onTrack = 0;
  const rows = cats.map((c) => {
    const ls = spend(c, lw), la = allow(c, lw), has = lw >= fw, ok = has && ls <= la; if (ok) onTrack++;
    let n = 0, w = lw; while (w >= fw && n < 104 && spend(c, w) <= allow(c, w)) { n++; w = addDays(w, -7); }
    return { category: c, thisWeek: spend(c, cw), allowance: allow(c, cw), lastWeek: ls, lastAllowance: la, hasLastWeek: has, onTrack: ok, streak: n };
  });
  return { weekStart: cw, lastWeekStart: lw, rows, onTrack };
}

/** Day streak from the set of local dates the app was opened. */
export function appStreak(days, today) {
  const set = new Set(days);
  let start = set.has(today) ? today : addDays(today, -1), current = 0;
  while (set.has(start)) { current++; start = addDays(start, -1); }
  const sorted = [...set].sort(); let best = 0, run = 0, prev = null;
  for (const d of sorted) { run = prev && addDays(prev, 1) === d ? run + 1 : 1; best = Math.max(best, run); prev = d; }
  const last7 = []; for (let k = 6; k >= 0; k--) { const d = addDays(today, -k); last7.push({ day: d, on: set.has(d) }); }
  const milestones = [3, 7, 14, 30, 60, 100, 200, 365];
  return { current, best: Math.max(best, current), openedToday: set.has(today), last7, next: milestones.find((m) => m > current) || null, badges: milestones.filter((m) => best >= m) };
}

/** Recurring expenses that are due up to `today` and not yet in `items`. */
export function dueRecurring(s, items, today) {
  const have = new Set(items.map((i) => i.id)), out = [];
  for (const t of s.recurring || []) {
    if (!t || !t.id || !t.start) continue;
    for (let ym = t.start; ym <= today.slice(0, 7); ym = shiftYM(ym, 1)) {
      if ((t.skip || []).includes(ym)) continue;
      const date = ym + '-' + pad(Math.min(+t.day || 1, dim(ym))); if (date > today) continue;
      const id = 'r-' + t.id + '-' + ym; if (have.has(id)) continue;
      out.push({ kind: 'exp', id, recurId: t.id, date, amount: +t.amount, category: t.category, splits: t.splits || null, merchant: t.merchant || '', note: t.note || '', paidWith: t.paidWith || '', source: 'recurring' });
    }
  }
  return out;
}

// ---- notification text -----------------------------------------------------
export function dailySummary(items, s, today, streak) {
  const f = (v) => fmt(v, s.currency), B = budgetInfo(items, s, today.slice(0, 7), today);
  const todays = items.filter((i) => i.date === today);
  let flex = 0, total = 0; for (const i of todays) { total += +i.amount; for (const p of parts(i)) if (!isFixed(s, p.category)) flex += p.amount; }
  let body = todays.length ? `${f(total)} across ${todays.length} expense${todays.length > 1 ? 's' : ''} today.` : 'No spending recorded today.';
  if (B.income > 0 && B.daily > 0) body += flex > B.daily ? ` Flexible spending ${f(flex - B.daily)} over your ${f(B.daily)} allowance.` : ` ${f(B.daily - flex)} under your ${f(B.daily)} daily allowance.`;
  if (B.income > 0 && B.target) { const gap = B.projSaved - B.target; body += gap >= 0 ? ` On pace to beat your savings target by ${f(gap)}.` : ` On pace to miss your savings target by ${f(-gap)}.`; }
  let title = 'Today’s spending';
  if (streak && !streak.openedToday && streak.current > 0) { title = `Keep your ${streak.current}-day streak`; body = 'Open the app before midnight to keep it going. ' + body; }
  return { title, body, tag: 'daily-' + today, url: './#overview' };
}

export function weeklySummary(items, s, today) {
  const W = weekly(items, s, today), f = (v) => fmt(v, s.currency);
  if (!W.rows.length) return null;
  const over = W.rows.filter((r) => r.hasLastWeek && !r.onTrack).map((r) => r.category);
  const best = W.rows.filter((r) => r.streak > 1).sort((a, b) => b.streak - a.streak)[0];
  let body = `Last week: ${W.onTrack} of ${W.rows.length} categories on track.`;
  if (over.length) body += ` Over: ${over.join(', ')}.`;
  if (best) body += ` ${best.category} is on a ${best.streak}-week streak.`;
  return { title: 'Weekly check-in', body, tag: 'weekly-' + W.weekStart, url: './#overview' };
}
