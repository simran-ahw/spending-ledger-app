// Shared server helpers: Supabase clients, auth, push sending, CORS.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { buildPushHTTPRequest } from 'npm:@pushforge/builder@2';
import { makeClaude } from './claude.js';
import { rowToItem, withDefaults } from './logic.js';

const env = (k: string) => Deno.env.get(k) ?? '';
const pickKey = (dictName: string, legacy: string) => {
  try { const d = JSON.parse(env(dictName) || '{}'); return d.default || Object.values(d)[0] || env(legacy); } catch { return env(legacy); }
};
export const SUPABASE_URL = env('SUPABASE_URL');
const SECRET_KEY = pickKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY') as string;
const PUBLISHABLE_KEY = pickKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY') as string;

/** Admin client: bypasses row-level security. Only use after checking who is calling. */
export const admin: SupabaseClient = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false } });

export const claude = makeClaude({
  apiKey: env('ANTHROPIC_API_KEY'),
  fastModel: env('CLAUDE_FAST_MODEL') || 'claude-haiku-5-5',
  visionModel: env('CLAUDE_VISION_MODEL') || 'claude-sonnet-5-5',
});
export const AI_DAILY_CAP = +(env('AI_DAILY_CAP') || 150);

export const cors = {
  'Access-Control-Allow-Origin': env('APP_ORIGIN') || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

/** The signed-in user behind a request, or null. */
export async function userFrom(req: Request) {
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const c = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data, error } = await c.auth.getUser();
  return error ? null : data.user;
}

export async function countAiCall(userId: string) {
  const { data, error } = await admin.rpc('bump_ai_usage', { p_user: userId });
  if (error) throw error;
  return data as number;
}

export async function loadUser(userId: string) {
  const [{ data: srow }, { data: rows }] = await Promise.all([
    admin.from('settings').select('data').eq('user_id', userId).maybeSingle(),
    admin.from('expenses').select('*').eq('user_id', userId).gte('date', new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10)),
  ]);
  return { settings: withDefaults(srow?.data), items: (rows ?? []).map(rowToItem) };
}

/** Send a notification to every device the user has subscribed. Removes dead subscriptions. */
export async function pushTo(userId: string, payload: { title: string; body: string; tag?: string; url?: string }) {
  const privateJWK = env('VAPID_PRIVATE_KEY');
  if (!privateJWK) return 0;
  const { data: subs } = await admin.from('push_subscriptions').select('*').eq('user_id', userId);
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      const { endpoint, headers, body } = await buildPushHTTPRequest({
        privateJWK: JSON.parse(privateJWK),
        subscription: { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        message: { payload, adminContact: env('VAPID_CONTACT') || 'mailto:admin@example.com', options: { ttl: 3600 * 12, urgency: 'normal', topic: payload.tag?.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '') } },
      });
      const res = await fetch(endpoint, { method: 'POST', headers, body });
      if (res.status === 404 || res.status === 410) await admin.from('push_subscriptions').delete().eq('user_id', userId).eq('endpoint', s.endpoint);
      else if (res.ok) sent++;
    } catch (e) { console.error('push failed', e); }
  }
  return sent;
}
