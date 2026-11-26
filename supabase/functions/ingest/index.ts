// Phone webhook: MacroDroid (or any automation app) posts each bank/card notification here.
// URL: https://<project>.supabase.co/functions/v1/ingest?t=<your phone token>
import { admin, json, pushTo } from '../_shared/server.ts';
import { saveAlerts, purchaseLine } from '../_shared/alerts.ts';

const DAILY_LIMIT = 400;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const url = new URL(req.url);
  const token = url.searchParams.get('t') || req.headers.get('x-ledger-token') || '';
  if (token.length < 32) return json({ error: 'token' }, 401);

  const { data: owner } = await admin.from('settings').select('user_id').eq('ingest_token', token).maybeSingle();
  if (!owner) return json({ error: 'token' }, 401);
  const userId = owner.user_id as string;

  // Accept plain text (recommended), JSON {app,title,text}, or a form post.
  let raw = '';
  const type = req.headers.get('content-type') || '';
  try {
    if (type.includes('form')) {
      const f = await req.formData();
      raw = ['app', 'title', 'text', 'message'].map((k) => f.get(k)).filter(Boolean).join(' — ');
    } else {
      raw = await req.text();
      if (raw.trim().startsWith('{')) {
        try { const b = JSON.parse(raw); raw = [b.app, b.title, b.text ?? b.message ?? b.body].filter(Boolean).join(' — ') || raw; } catch { /* keep the text as sent */ }
      }
    }
  } catch { return json({ error: 'body' }, 400); }
  raw = raw.trim().slice(0, 1500);
  if (!raw) return json({ error: 'empty' }, 400);

  const since = new Date(Date.now() - 864e5).toISOString();
  const { count } = await admin.from('ingest_log').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('received_at', since);
  if ((count ?? 0) >= DAILY_LIMIT) return json({ error: 'daily_limit' }, 429);

  const { data: log } = await admin.from('ingest_log').insert({ user_id: userId, raw }).select('id').single();
  try {
    const r = await saveAlerts(userId, [{ n: 1, text: raw, when: new Date().toISOString() }], { source: 'phone', mkId: () => 'p-' + log!.id });
    await admin.from('ingest_log').update({ result: { added: r.items.length, parsed: r.parsed } }).eq('id', log!.id);
    const n = r.settings.notify;
    for (const i of r.items) {
      if (n.purchase) await pushTo(userId, { title: 'Expense logged', body: purchaseLine(i, r.settings.currency) + '. Tap to change.', tag: 'p-' + i.id, url: './#add' });
    }
    if (n.limits && r.warnings.length) await pushTo(userId, { title: 'Spending limit', body: r.warnings.join(' '), tag: 'limit-' + log!.id, url: './#overview' });
    return json({ ok: true, added: r.items.length });
  } catch (e) {
    console.error(e);
    await admin.from('ingest_log').update({ result: { error: String(e).slice(0, 300) } }).eq('id', log!.id);
    return json({ error: 'failed' }, 500);
  }
});
