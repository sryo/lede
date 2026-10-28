// What the Worker keeps in its STORE KV namespace, so setup needs nothing typed into config:
//   sites          JSON list of hostnames that may send events, added from the dashboard
//   salt:YYYY-MM   random secret that hashes that month's visitors; deletes itself when the month is over
//   account        Cloudflare account ID, read from the API token the first time stats are asked for
//   settings:<site> JSON {goals, funnels, notes}: goal paths, funnels (lists of paths) and the owner's notes
//                  on days, {day: YYYY-MM-DD, text}; a field not there was never saved. Read and written in
//                  api.js. Older versions kept each in its own key (goals:<site>, funnels:<site>,
//                  notes:<site>), which are read until the site's settings are first saved.
//   origin         the dashboard's address, for the links in alerts; saved when the dashboard opens
//   spike:<site>   the day's spike alerts sent so far; deletes itself after two days
//   shot:… og:…    a page's picture for its view, and its share picture; see src/shot.js
import { HttpError } from './errors.js';

// Every event reads the sites and the salt, so each isolate keeps them for a minute
// instead of spending two KV reads per page view.
const MEMO_MS = 60_000;
const memo = new WeakMap();

// The promise is kept, so requests arriving together (a dashboard load sends ten) share one read.
// fresh reads anyway, and keeps what it read for the others.
async function remembered(store, key, read, fresh = false) {
  const byKey = memo.get(store) || new Map();
  memo.set(store, byKey);
  const hit = byKey.get(key);
  if (!fresh && hit && Date.now() - hit.at < MEMO_MS) return hit.value;
  const value = read();
  byKey.set(key, { value, at: Date.now() });
  try { return await value; } catch (e) { if (byKey.get(key)?.value === value) byKey.delete(key); throw e; }
}
const forget = (store, key) => memo.get(store)?.delete(key);

function storeOf(env) {
  if (!env.STORE) throw new HttpError(500, 'The STORE KV namespace is missing from wrangler.jsonc. Add it back to kv_namespaces, as Lede’s wrangler.jsonc has it, then deploy again.');
  return env.STORE;
}

// "https://www.Example.com/pricing" → "example.com"; null when it isn't a hostname.
export function normalizeSite(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text || /\s/.test(text)) return null;
  let host;
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname; } catch { return null; }
  host = host.replace(/^www\./, '');
  // Analytics Engine indexes each event by site, and an index holds at most 96 bytes.
  return host.length <= 96 && /^(localhost|([a-z0-9-]+\.)+[a-z0-9-]{2,})$/.test(host) ? host : null;
}

// fresh reads past the per-isolate copy, for the dashboard, which must see a site the moment it is added.
export async function getSites(env, { fresh = false } = {}) {
  const store = storeOf(env);
  return remembered(store, 'sites', async () => JSON.parse(await store.get('sites') || '[]'), fresh);
}

// One read when the site's settings were saved since they moved to one key, four before that.
const PARTS = ['goals', 'funnels', 'notes'];
export async function getSettings(env, site) {
  const store = storeOf(env);
  const saved = await store.get(`settings:${site}`);
  if (saved) return JSON.parse(saved);
  const old = await Promise.all(PARTS.map(k => store.get(`${k}:${site}`)));
  return Object.fromEntries(PARTS.flatMap((k, i) => old[i] == null ? [] : [[k, JSON.parse(old[i])]]));
}

export const saveSettings = (env, site, settings) => storeOf(env).put(`settings:${site}`, JSON.stringify(settings));

export async function addSite(env, input) {
  const site = normalizeSite(input);
  if (!site) throw new HttpError(400, 'That doesn’t look like a site’s address. Type it like example.com.');
  const store = storeOf(env);
  await getSalt(env);
  const sites = await getSites(env, { fresh: true });
  if (sites.includes(site)) return sites;
  const next = [...sites, site];
  await store.put('sites', JSON.stringify(next));
  forget(store, 'sites');
  return next;
}

const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const randomSalt = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const monthOf = date => date.toISOString().slice(0, 7);
// Unix seconds of the first instant of the month `ahead` months after date's.
const monthStart = (date, ahead) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + ahead, 1) / 1000;

// Each month gets its own random salt, kept only until the day after the month ends. Once it's gone
// nobody, not even whoever runs Lede, can work out which visitor IDs belong to the same person.
// The next month's salt is made a few days early, so every Worker instance agrees on it from the start.
export async function getSalt(env, now = new Date()) {
  const store = storeOf(env);
  const month = monthOf(now);
  return remembered(store, `salt:${month}`, async () => {
    const salt = await store.get(`salt:${month}`) || await makeSalt(store, now);
    if (now.getUTCDate() >= 25) {
      const next = new Date(monthStart(now, 1) * 1000);
      if (!await store.get(`salt:${monthOf(next)}`)) {
        await store.put(`salt:${monthOf(next)}`, randomSalt(), { expiration: monthStart(next, 1) + 86400 });
      }
    }
    return salt;
  });
}

// Earlier versions kept one permanent secret and derived each month's salt from it. That month's
// salt is still derived from it, so this month's visitor IDs carry on, and then the secret is deleted.
async function makeSalt(store, now) {
  const legacy = await store.get('salt');
  let salt = randomSalt();
  if (legacy) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(legacy), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    salt = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(monthOf(now))));
  }
  await store.put(`salt:${monthOf(now)}`, salt, { expiration: monthStart(now, 1) + 86400 });
  if (legacy) await store.delete('salt');
  return salt;
}

// The account never changes, so each isolate looks it up once. The promise is kept rather than
// the answer, because a dashboard load asks for it from 15 queries at the same moment.
const accounts = new WeakMap();

// The Analytics Engine SQL API is per account. ACCOUNT_ID wins when set; otherwise the
// token's only account is used and saved.
export function getAccountId(env, fetchImpl = fetch) {
  if (env.ACCOUNT_ID) return Promise.resolve(env.ACCOUNT_ID);
  const store = storeOf(env);
  if (!accounts.has(store)) {
    accounts.set(store, lookUpAccount(env, store, fetchImpl).catch(e => { accounts.delete(store); throw e; }));
  }
  return accounts.get(store);
}

async function lookUpAccount(env, store, fetchImpl) {
  const saved = await store.get('account');
  if (saved) return saved;
  const res = await fetchImpl('https://api.cloudflare.com/client/v4/accounts', { headers: { Authorization: `Bearer ${env.ANALYTICS_TOKEN}` } });
  const body = await res.json().catch(() => ({}));
  const accounts = body.result || [];
  if (accounts.length !== 1) {
    throw new HttpError(503, accounts.length
      ? 'Your Cloudflare token works for more than one account. Run npx wrangler secret put ACCOUNT_ID and paste the ID of the account Lede runs on: open that account in the Cloudflare dashboard, and it’s the long code after dash.cloudflare.com/ in the address.'
      : 'Your Cloudflare token can’t see which account Lede runs on. Make a new token with the link in docs/how-it-works.md, under “Deploy from the command line”, then run npx wrangler secret put ANALYTICS_TOKEN and paste it.');
  }
  await store.put('account', accounts[0].id);
  return accounts[0].id;
}

// The Worker can't tell its own address on a schedule, so it keeps the one the dashboard was last opened at.
// Each isolate checks KV once per address, and writes only when it changed.
const origins = new WeakMap();
export async function rememberOrigin(env, origin) {
  if (!env.STORE || origins.get(env.STORE) === origin) return;
  origins.set(env.STORE, origin);
  if (await env.STORE.get('origin') !== origin) await env.STORE.put('origin', origin);
}
