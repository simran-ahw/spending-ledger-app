import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../supabase/functions/_shared/logic.js';
import { makeClaude, alertsToItems } from '../supabase/functions/_shared/claude.js';

const S = L.withDefaults({ income: 5000, target: 800, limits: { 'Eating out': 300, Groceries: 500 } });
const it = (id, date, amount, category, extra = {}) => ({ kind: 'exp', id, date, amount, category, ...extra });

test('date helpers', () => {
  assert.equal(L.addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(L.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(L.mondayOf('2026-11-26'), '2026-11-23');
  assert.equal(L.mondayOf('2026-11-23'), '2026-11-23');
  assert.equal(L.dim('2028-02'), 29);
  assert.equal(L.shiftYM('2026-01', -1), '2025-12');
  const n = L.localNow('America/Toronto', new Date('2026-11-27T03:30:00Z'));
  assert.deepEqual(n, { date: '2026-11-26', hour: 22 });
});

test('app streak', () => {
  const s = L.appStreak(['2026-11-20', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25'], '2026-11-26');
  assert.equal(s.current, 4); assert.equal(s.openedToday, false); assert.equal(s.best, 4);
  assert.equal(s.next, 7); assert.deepEqual(s.badges, [3]);
  assert.equal(s.last7.filter((d) => d.on).length, 5); // Nov 20–26 window
  const t = L.appStreak(['2026-11-25', '2026-11-26'], '2026-11-26');
  assert.equal(t.current, 2); assert.equal(t.openedToday, true);
  assert.equal(L.appStreak([], '2026-11-26').current, 0);
  assert.equal(L.appStreak(['2026-11-20'], '2026-11-26').current, 0);
});

test('recurring', () => {
  const s = { ...S, recurring: [{ id: 't1', merchant: 'Netflix', amount: 15.99, category: 'Entertainment', day: 31, start: '2026-09', skip: ['2026-10'] }] };
  const due = L.dueRecurring(s, [it('r-t1-2026-09', '2026-09-30', 15.99, 'Entertainment')], '2026-11-30');
  assert.deepEqual(due.map((d) => d.date), ['2026-11-30']);
  assert.equal(L.dueRecurring(s, [], '2026-11-29').length, 1); // only Sep (Oct skipped, Nov 30 not yet)
});

test('budget and projection', () => {
  const items = [it('a', '2026-10-01', 1800, 'Rent'), it('b', '2026-11-01', 1800, 'Rent'), it('c', '2026-11-05', 300, 'Groceries'), it('d', '2026-11-10', 150, 'Eating out')];
  const B = L.budgetInfo(items, S, '2026-11', '2026-11-15');
  assert.equal(B.fixedExp, 1800); assert.equal(B.flex, 450);
  assert.equal(Math.round(B.daily * 100) / 100, Math.round((5000 - 800 - 1800) / 30 * 100) / 100);
  assert.equal(B.projFlex, 900); assert.equal(B.projSaved, 5000 - 2700);
  assert.equal(B.left, 15);
});

test('limit warnings cross thresholds once', () => {
  const items = [it('x', '2026-11-02', 200, 'Eating out')];
  const add1 = it('y', '2026-11-20', 50, 'Eating out');
  assert.match(L.limitWarnings(items.concat(add1), S, [add1], '2026-11-20')[0], /83% of its \$300\.00 limit/);
  const add2 = it('z', '2026-11-21', 120, 'Eating out');
  assert.match(L.limitWarnings(items.concat(add2), S, [add2], '2026-11-21')[0], /now over its \$300\.00 limit/);
  const small = it('w', '2026-11-21', 10, 'Eating out');
  assert.equal(L.limitWarnings(items.concat(small), S, [small], '2026-11-21').length, 0);
  const split = it('s', '2026-11-21', 400, 'Groceries', { splits: [{ category: 'Groceries', amount: 450 }, { category: 'Eating out', amount: 10 }] });
  assert.equal(L.limitWarnings([split], S, [split], '2026-11-21').length, 1);
});

test('weekly check-in and streaks', () => {
  const items = [];
  for (let w = 0; w < 4; w++) items.push(it('e' + w, L.addDays('2026-10-26', w * 7 + 1), w === 1 ? 200 : 40, 'Eating out'));
  const W = L.weekly(items, S, '2026-11-26');
  const r = W.rows.find((x) => x.category === 'Eating out');
  assert.equal(W.lastWeekStart, '2026-11-16');
  assert.equal(r.onTrack, true); assert.equal(r.streak, 2); // weeks of Nov 16 and Nov 9 ok, Nov 2 over
  assert.ok(L.weeklySummary(items, S, '2026-11-26').body.includes('on track'));
});

test('daily summary adds streak reminder', () => {
  const st = L.appStreak(['2026-11-24', '2026-11-25'], '2026-11-26');
  const d = L.dailySummary([it('a', '2026-11-26', 20, 'Eating out')], S, '2026-11-26', st);
  assert.equal(d.title, 'Keep your 2-day streak');
  assert.match(d.body, /Open the app before midnight/);
  assert.match(d.body, /\$20\.00 across 1 expense today/);
});

test('rows round-trip', () => {
  const i = it('q', '2026-11-26', 12.345, 'Groceries', { splits: [], merchant: 'X', paidWith: 'Visa', source: 'phone' });
  const back = L.rowToItem({ ...L.itemToRow(i), created_at: '2026-11-26T00:00:00Z' });
  assert.equal(back.amount, 12.35); assert.equal(back.paidWith, 'Visa'); assert.equal(back.splits, null);
});

test('Claude request shape and alert handling', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init: { ...init, body: JSON.parse(init.body) } });
    const prompt = JSON.parse(init.body).messages[0].content.at(-1).text;
    const text = prompt.includes('[1]') ? 'Here:\n[{"n":1,"purchase":true,"amount":42.18,"merchant":"Loblaws","date":"2026-11-26","card":"TD Visa 4410","category":"Groceries","duplicate":false},{"n":2,"purchase":false}]' : '{"merchant":"Costco","total":10,"date":"2026-11-26","category":"Groceries","split":[]}';
    return { ok: true, json: async () => ({ content: [{ type: 'text', text }] }) }; };
  const c = makeClaude({ apiKey: 'k', fetchImpl: fakeFetch });
  const parsed = await c.alerts({ entries: [{ n: 1, text: 'TD: $42.18 at LOBLAWS' }, { n: 2, text: 'Your code is 1234' }], cats: S.cats, today: '2026-11-26' });
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].init.body.model, 'claude-haiku-5-5');
  const res = alertsToItems(parsed, { existing: [it('old', '2026-11-26', 5, 'Other')], cats: S.cats, cards: ['TD Visa', 'Amex'], mkId: (n) => 'p-' + n, source: 'phone', textOf: () => 'raw' });
  assert.equal(res.items.length, 1); assert.equal(res.items[0].paidWith, 'TD Visa'); assert.deepEqual(res.skipped, [2]);
  const dup = alertsToItems(parsed, { existing: [it('old', '2026-11-26', 42.18, 'Groceries')], cats: S.cats, cards: [], mkId: (n) => 'p-' + n, source: 'phone', textOf: () => '' });
  assert.equal(dup.items.length, 0); assert.deepEqual(dup.dupes, [1]);
  const r = await c.receipt({ base64: 'AAAA', cats: S.cats, today: '2026-11-26' });
  assert.equal(r.merchant, 'Costco');
  assert.equal(calls[1].init.body.model, 'claude-sonnet-5-5');
  assert.equal(calls[1].init.body.messages[0].content[0].source.type, 'base64');
});
