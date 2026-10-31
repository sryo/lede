// Every view the dashboard can zoom into has an address, so a refresh or a shared link opens the same view.
//   /                          home              /overview, /bounce, /online, /events
//   /sources, /pages           the full lists
//   /sources/google.com        one source (/sources/direct for visits with no referrer)
//   /channels/ai               one channel
//   /page/docs/install         one page (/page/ is the site's home page)
// Extra filters, a period other than the last 30 days (?days=7, ?back=3 for one that ended 3 days ago), a comparison the
// owner placed (?gap=28) and the site (when there is more than one) go in the query string.

import { displayHost } from './hosts.js';
import { alignedGap } from './story.js';

const SIMPLE = ['overview', 'bounce', 'online', 'sources', 'pages', 'events'];
const DIRECT = 'direct';

export function viewToUrl(view, { days = 30, back = 0, gap = null, site = null } = {}) {
  let path = '/';
  const q = new URLSearchParams();
  if (view && SIMPLE.includes(view.v)) path = `/${view.v}`;
  else if (view?.v === 'filter') {
    const { path: page, referrer, channel } = view.f;
    if (page != null) {
      path = '/page' + encodeURI(page);
      if (referrer != null) q.set('referrer', referrer);
      if (channel != null) q.set('channel', channel);
    } else if (referrer != null) {
      path = `/sources/${referrer === '' ? DIRECT : encodeURIComponent(referrer)}`;
      if (channel != null) q.set('channel', channel);
    } else if (channel != null) path = `/channels/${encodeURIComponent(channel)}`;
  }
  if (days !== 30) q.set('days', days);
  if (back) q.set('back', back);
  if (gap != null) q.set('gap', gap);
  if (site) q.set('site', displayHost(site));
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

const asciiHost = host => {
  if (!host) return null;
  try { return new URL(`https://${host}`).hostname; } catch { return host; }
};

export function urlToView(pathname, search) {
  const q = new URLSearchParams(search);
  // Sites are saved in ASCII (xn--…); the address shows them as typed, so it's turned back here.
  // A period is 7 to 45 days: fewer is too few to find a big or quiet day, and the API's longest is 45.
  const d = +q.get('days'), days = Number.isInteger(d) && d >= 7 && d <= 45 && d !== 30 ? d : null, site = asciiHost(q.get('site'));
  // The period lies within the 45 days that know each day's top source; its comparison within the 90 kept, never
  // overlapping it. A gap that is the default one is no choice at all.
  const n = days || 30, b = +q.get('back'), back = Number.isInteger(b) && b > 0 && b + n <= 45 ? b : 0;
  const g = +q.get('gap'), gap = q.has('gap') && Number.isInteger(g) && g >= n && back + g + n <= 90 && g !== alignedGap(n, back) ? g : null;
  const parts = pathname.split('/');
  let view = null;
  if (parts.length === 2 && SIMPLE.includes(parts[1])) view = { v: parts[1] };
  // /keywords and /funnels open the overview, where those cards are, so saved links still land somewhere.
  else if (pathname === '/keywords' || pathname === '/funnels') view = { v: 'overview' };
  else if (parts[1] === 'page' && parts.length >= 3) {
    const f = { path: decodeURI('/' + parts.slice(2).join('/')) };
    if (q.has('referrer')) f.referrer = q.get('referrer');
    if (q.has('channel')) f.channel = q.get('channel');
    view = { v: 'filter', f };
  } else if (parts[1] === 'sources' && parts.length === 3 && parts[2]) {
    const key = decodeURIComponent(parts[2]);
    const f = { referrer: key === DIRECT ? '' : key };
    if (q.has('channel')) f.channel = q.get('channel');
    view = { v: 'filter', f };
  } else if (parts[1] === 'channels' && parts.length === 3 && parts[2]) {
    view = { v: 'filter', f: { channel: decodeURIComponent(parts[2]) } };
  }
  return { view, days, back, gap, site };
}
