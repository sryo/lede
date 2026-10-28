// Every view the dashboard can zoom into has an address, so a refresh or a shared link opens the same view.
//   /                          home              /overview, /bounce, /online, /events
//   /sources, /pages           the full lists
//   /sources/google.com        one source (/sources/direct for visits with no referrer)
//   /channels/ai               one channel
//   /page/docs/install         one page (/page/ is the site's home page)
// Extra filters, the 7-day period and the site (when there is more than one) go in the query string.

import { displayHost } from './hosts.js';

const SIMPLE = ['overview', 'bounce', 'online', 'sources', 'pages', 'events'];
const DIRECT = 'direct';

export function viewToUrl(view, { days = 30, site = null } = {}) {
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
  if (days === 7) q.set('days', '7');
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
  const days = q.get('days') === '7' ? 7 : null, site = asciiHost(q.get('site'));
  const parts = pathname.split('/');
  let view = null;
  if (parts.length === 2 && SIMPLE.includes(parts[1])) view = { v: parts[1] };
  // Keywords and funnels were once views of their own; they are cards on the overview now.
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
  return { view, days, site };
}
