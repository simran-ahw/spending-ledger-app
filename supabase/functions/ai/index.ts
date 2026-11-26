// Claude features for the signed-in user: read a receipt, read pasted alerts, coaching tips.
import { claude, cors, json, userFrom, countAiCall, AI_DAILY_CAP, loadUser, pushTo } from '../_shared/server.ts';
import { saveAlerts } from '../_shared/alerts.ts';
import { localNow } from '../_shared/logic.js';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const user = await userFrom(req);
  if (!user) return json({ error: 'signed_out' }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  try {
    if (body.task === 'test_push') {
      const sent = await pushTo(user.id, { title: 'Notifications are on', body: 'You’ll get purchase, limit, daily and weekly alerts here.', tag: 'test', url: './#overview' });
      return json({ sent });
    }
    if ((await countAiCall(user.id)) > AI_DAILY_CAP) return json({ error: 'daily_cap' }, 429);

    if (body.task === 'receipt') {
      const base64 = String(body.image || '');
      if (!base64 || base64.length > 7_000_000) return json({ error: 'bad_image' }, 400);
      const mediaType = ['image/jpeg', 'image/png', 'image/webp'].includes(String(body.mediaType)) ? String(body.mediaType) : 'image/jpeg';
      const { settings } = await loadUser(user.id);
      const result = await claude.receipt({ base64, mediaType, cats: settings.cats, today: localNow(settings.tz).date });
      return json({ result });
    }

    if (body.task === 'alerts') {
      const texts = (Array.isArray(body.texts) ? body.texts : []).map(String).filter((t) => t.trim()).slice(0, 80);
      if (!texts.length) return json({ error: 'empty' }, 400);
      const stamp = Date.now().toString(36);
      const r = await saveAlerts(user.id, texts.map((t, k) => ({ n: k + 1, text: t, when: String(body.today || '') })), { source: 'pasted', mkId: (n) => `a-${stamp}-${n}` });
      return json({ added: r.items.length, skipped: r.skipped.length, dupes: r.dupes.length, warnings: r.warnings });
    }

    if (body.task === 'coach') {
      const facts = String(body.facts || '').slice(0, 6000);
      if (!facts) return json({ error: 'empty' }, 400);
      return json({ tips: await claude.coach({ facts }) });
    }

    return json({ error: 'unknown_task' }, 400);
  } catch (e) {
    console.error(e);
    const status = (e as { status?: number }).status;
    return json({ error: status === 429 ? 'busy' : 'failed' }, status === 429 ? 429 : 500);
  }
});

