// Claude API calls: receipt reading, bank-alert parsing and coaching tips.
// Prompts live on the server so the app can't be used as a general chatbot.

const API = 'https://api.anthropic.com/v1/messages';

export function makeClaude({ apiKey, fastModel = 'claude-haiku-5-5', visionModel = 'claude-sonnet-5-5', fetchImpl = fetch }) {
  async function call(model, content, maxTokens = 1200) {
    const res = await fetchImpl(API, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
    });
    if (!res.ok) { const t = await res.text(); throw Object.assign(new Error('claude ' + res.status + ': ' + t.slice(0, 300)), { status: res.status }); }
    const j = await res.json();
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  const json = (text, open = '{') => {
    const close = open === '{' ? '}' : ']', a = text.indexOf(open), b = text.lastIndexOf(close);
    if (a < 0 || b < a) throw new Error('no JSON in answer');
    return JSON.parse(text.slice(a, b + 1));
  };

  return {
    /** Read a receipt photo. Returns {merchant,date,total,category,split,card,summary} or {error}. */
    async receipt({ base64, mediaType = 'image/jpeg', cats, today }) {
      const prompt = `You are reading a purchase receipt photo for a personal expense tracker. Today is ${today}.
Return ONLY a JSON object, no prose:
{"merchant":string,"date":"YYYY-MM-DD" or null,"total":number (final amount paid incl. tax and tip),"category":the main category,"split":[{"category":string,"amount":number}],"card":string or null (card type and last 4 digits if printed, e.g. "Visa 1234"),"summary":"under 12 words describing what was bought"}
Categories must be one of: [${cats.join(', ')}].
Only fill "split" when the items clearly belong to more than one category (e.g. food plus household goods); then the split amounts, with tax spread proportionally, must add up to the total. Otherwise use [].
If the image is not a receipt, return {"error":"not a receipt"}.`;
      const text = await call(visionModel, [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }, { type: 'text', text: prompt }], 800);
      return json(text);
    },

    /** Turn notification texts into purchases. entries: [{n,text,when}] */
    async alerts({ entries, cats, today }) {
      const out = [];
      for (let k = 0; k < entries.length; k += 40) {
        const chunk = entries.slice(k, k + 40);
        const lines = chunk.map((e) => '[' + e.n + '] received: ' + (e.when || 'unknown') + ' | ' + String(e.text).replace(/\s+/g, ' ').slice(0, 500)).join('\n');
        const prompt = `You turn phone notifications and bank texts into expense records. Today is ${today}; the user is in Canada.
Each line below is one notification, with when it arrived:
${lines}

For each line decide whether it is money the user SPENT: a card purchase, tap/Google Wallet payment, online charge, pre-authorized bill payment, or e-transfer/payment sent.
NOT purchases: verification or one-time codes, deposits or payments received, refunds, declined transactions, balance/statement/due-date notices, promotions, anything else.
If two lines describe the same purchase (e.g. pending then posted), set "duplicate": true on the later one.
Return ONLY a JSON array with one object per line, no prose:
[{"n":number,"purchase":boolean,"amount":number,"merchant":string,"date":"YYYY-MM-DD","card":string or null (card or account as named, e.g. "TD Visa 4410"),"category":one of [${cats.join(', ')}],"duplicate":boolean}]
Use the date in the message if there is one, else the received date. Clean up merchant names (e.g. "LOBLAWS #1023 TORONTO" -> "Loblaws").`;
        const text = await call(fastModel, [{ type: 'text', text: prompt }], 2500);
        for (const j of json(text, '[')) if (j && typeof j === 'object') out.push(j);
      }
      return out;
    },

    /** 4-6 coaching tips from a month's numbers. Returns string[]. */
    async coach({ facts }) {
      const prompt = `You are a practical personal-finance coach. Here is one person's spending data:\n${facts}\nGive 4 to 6 short, specific, actionable insights about their habits and where to save, with dollar figures. One per line, each starting with "- ". No intro or outro.`;
      const text = await call(fastModel, [{ type: 'text', text: prompt }], 700);
      return text.split('\n').map((l) => l.replace(/^\s*[-•*]\s*/, '').replace(/\*\*/g, '').trim()).filter(Boolean).slice(0, 8);
    },
  };
}

/** Match a card name from an alert to the user's saved cards. */
export function matchCard(card, cards) {
  if (!card) return '';
  const l = String(card).toLowerCase();
  return cards.find((x) => l.includes(x.toLowerCase()) || x.toLowerCase().includes(l)) || String(card).slice(0, 40);
}

/** Validate parsed alerts and build expense items (skips non-purchases and duplicates). */
export function alertsToItems(parsed, { existing, cats, cards, mkId, source, textOf }) {
  const items = [], skipped = [], dupes = [];
  for (const j of parsed) {
    const amt = Math.round(+j.amount * 100) / 100;
    if (!j.purchase || j.duplicate || !(amt > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(j.date || '')) { skipped.push(j.n); continue; }
    const id = mkId(j.n);
    if (existing.some((x) => x.id === id) || existing.concat(items).some((x) => x.date === j.date && Math.abs(+x.amount - amt) < 0.01)) { dupes.push(j.n); continue; }
    items.push({ kind: 'exp', id, date: j.date, amount: amt, category: cats.includes(j.category) ? j.category : 'Other', merchant: String(j.merchant || '').slice(0, 80), note: '', paidWith: matchCard(j.card, cards), source, alert: String(textOf(j.n) || '').slice(0, 300) });
  }
  return { items, skipped, dupes };
}
