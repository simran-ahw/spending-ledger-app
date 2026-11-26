// Turn bank/card notification texts into saved expenses, then work out limit warnings.
import { admin, claude, loadUser } from './server.ts';
import { alertsToItems } from './claude.js';
import { itemToRow, limitWarnings, localNow, fmt } from './logic.js';

export type Entry = { n: number; text: string; when?: string };

export async function saveAlerts(userId: string, entries: Entry[], opts: { source: string; mkId: (n: number) => string }) {
  const { settings, items } = await loadUser(userId);
  const today = localNow(settings.tz).date;
  const parsed = await claude.alerts({ entries, cats: settings.cats, today });
  const byN = Object.fromEntries(entries.map((e) => [e.n, e.text]));
  const res = alertsToItems(parsed, { existing: items, cats: settings.cats, cards: settings.cards, mkId: opts.mkId, source: opts.source, textOf: (n: number) => byN[n] });
  if (res.items.length) {
    const { error } = await admin.from('expenses').upsert(res.items.map((i) => ({ ...itemToRow(i), user_id: userId })), { onConflict: 'user_id,id', ignoreDuplicates: true });
    if (error) throw error;
  }
  // deno-lint-ignore no-explicit-any
  const warnings = limitWarnings([...items, ...res.items] as any[], settings, res.items, today);
  return { ...res, warnings, settings, parsed };
}

export const purchaseLine = (i: { amount: number; merchant: string; category: string; splits?: { category: string }[] | null }, currency: string) =>
  `${fmt(i.amount, currency)}${i.merchant ? ' at ' + i.merchant : ''} as ${i.splits && i.splits.length ? i.splits.map((s) => s.category).join(' + ') : i.category}`;
