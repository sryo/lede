#!/usr/bin/env node
// How long Analytics Engine takes from a write to a query that sees it, on a real Lede: the part of "here
// now"'s delay no dashboard change can remove. Each run sends Lede a ping for a page no one has
// (/__lede-lag/<random>), then asks the SQL API every 2 seconds until the row is there.
//   ANALYTICS_TOKEN=… [ACCOUNT_ID=…] node scripts/ae-lag.mjs --lede https://lede.<you>.workers.dev --site example.com [--runs 20]
// Run it from your own computer: Lede drops data-centre addresses, which a CI runner or a cloud machine has.
// A ping counts nowhere but "here now", where each run's shows as one more person for 5 minutes.

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const lede = arg('--lede'), site = arg('--site'), runs = +arg('--runs', 20), dataset = arg('--dataset', 'lede');
const token = process.env.ANALYTICS_TOKEN;
if (!lede || !site || !token) {
  console.error('Usage: ANALYTICS_TOKEN=… node scripts/ae-lag.mjs --lede <Lede\'s address> --site <a site Lede counts> [--runs 20]');
  process.exit(1);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';

async function account() {
  if (process.env.ACCOUNT_ID) return process.env.ACCOUNT_ID;
  const r = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: { Authorization: `Bearer ${token}` } });
  const list = (await r.json()).result || [];
  if (list.length !== 1) throw new Error(`The token reaches ${list.length} accounts; set ACCOUNT_ID.`);
  return list[0].id;
}

const id = await account();
const seen = async path => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${id}/analytics_engine/sql`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
    // The path is ours (hex digits only), so it goes in as written.
    body: `SELECT count() AS n FROM ${dataset} WHERE index1 = '${site}' AND blob2 = '${path}' AND timestamp > now() - INTERVAL '1' HOUR`,
  });
  if (!r.ok) throw new Error(`The SQL API answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return Number((await r.json()).data?.[0]?.n) > 0;
};

const lags = [];
for (let i = 0; i < runs; i++) {
  const path = `/__lede-lag/${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const sent = Date.now();
  const res = await fetch(new URL('/lede', lede), {
    method: 'POST', headers: { 'User-Agent': UA, Origin: `https://${site}`, 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ t: 'ping', u: `https://${site}${path}`, r: '', l: '', v: sent }),
  });
  if (res.status !== 204) throw new Error(`Lede answered ${res.status}; check --lede.`);
  let lag = null;
  while (Date.now() - sent < 5 * 60e3) {
    await sleep(2000);
    if (await seen(path)) { lag = (Date.now() - sent) / 1000; break; }
  }
  if (lag == null) console.log(`run ${i + 1}: not seen in 5 minutes (dropped as a bot or a data-centre address? run it from your own computer)`);
  else { lags.push(lag); console.log(`run ${i + 1}: ${lag.toFixed(1)} s`); }
}
const sorted = lags.sort((a, b) => a - b), at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
if (sorted.length) console.log(`${sorted.length} of ${runs} seen. Median ${at(0.5).toFixed(1)} s, 90th percentile ${at(0.9).toFixed(1)} s, slowest ${sorted.at(-1).toFixed(1)} s (to the nearest 2 s).`);
