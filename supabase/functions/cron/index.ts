// Runs hourly (pg_cron). For each person, in their own time zone:
//  - adds recurring expenses that are due (once a day)
//  - sends the daily summary at their chosen hour (with a streak reminder if they haven't opened the app)
//  - sends the weekly check-in on Monday at 8 a.m.
import { admin, json, pushTo } from '../_shared/server.ts';
import { appStreak, dailySummary, dueRecurring, itemToRow, localNow, mondayOf, rowToItem, weeklySummary, withDefaults, addDays } from '../_shared/logic.js';

async function once(userId: string, kind: string, key: string) {
  const { error } = await admin.from('notify_log').insert({ user_id: userId, kind, key });
  return !error; // a duplicate key means it already ran
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET') || '';
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'forbidden' }, 403);

  const { data: rows, error } = await admin.from('settings').select('user_id, data');
  if (error) return json({ error: error.message }, 500);
  const report = { users: rows?.length ?? 0, recurring: 0, daily: 0, weekly: 0 };

  for (const row of rows ?? []) {
    const userId = row.user_id as string;
    try {
      const s = withDefaults(row.data);
      const { date: today, hour } = localNow(s.tz);
      const wantRecurring = (s.recurring || []).length > 0 && hour >= 5;
      const wantDaily = s.notify.daily && hour === +s.notify.dailyHour;
      const wantWeekly = s.notify.weekly && hour === 8 && mondayOf(today) === today;
      if (!wantRecurring && !wantDaily && !wantWeekly) continue;

      const { data: exp } = await admin.from('expenses').select('*').eq('user_id', userId).gte('date', addDays(today, -400));
      // deno-lint-ignore no-explicit-any
      const items: any[] = (exp ?? []).map(rowToItem);

      if (wantRecurring && (await once(userId, 'recurring', today))) {
        const due = dueRecurring(s, items, today);
        if (due.length) {
          await admin.from('expenses').upsert(due.map((i) => ({ ...itemToRow(i), user_id: userId })), { onConflict: 'user_id,id', ignoreDuplicates: true });
          items.push(...due); report.recurring += due.length;
        }
      }
      if (wantDaily && (await once(userId, 'daily', today))) {
        const { data: opens } = await admin.from('app_opens').select('day').eq('user_id', userId).gte('day', addDays(today, -400));
        const streak = appStreak((opens ?? []).map((o) => String(o.day).slice(0, 10)), today);
        if (await pushTo(userId, dailySummary(items, s, today, streak))) report.daily++;
      }
      if (wantWeekly && (await once(userId, 'weekly', today))) {
        const w = weeklySummary(items, s, today);
        if (w && (await pushTo(userId, w))) report.weekly++;
      }
    } catch (e) { console.error('cron user failed', userId, e); }
  }
  return json(report);
});
