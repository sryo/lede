// A trailing dot matches any TLD ("google." covers google.com and google.co.uk).
const AI = ['chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com', 'copilot.microsoft.com', 'poe.com', 'meta.ai', 'you.com', 'phind.com', 'grok.com', 'chat.deepseek.com', 'chat.mistral.ai'];
const SEARCH = ['google.', 'bing.com', 'duckduckgo.com', 'search.brave.com', 'yahoo.', 'yandex.', 'ya.ru', 'baidu.com', 'ecosia.org', 'startpage.com', 'kagi.com', 'qwant.com', 'search.naver.com', 'msn.com'];
// Pages on a search engine's domain that people read rather than search from.
const NOT_SEARCH = ['sites.google.com', 'docs.google.com', 'groups.google.com', 'news.yahoo.'];
const EMAIL = ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.com', 'mail.proton.me', 'app.fastmail.com', 'mail.zoho.com', 'safelinks.protection.outlook.com', 'teams.microsoft.com', 'teams.live.com'];
const VIDEO = ['youtube.com', 'youtu.be', 'twitch.tv', 'vimeo.com'];
const SOCIAL = ['facebook.com', 'm.facebook.com', 'l.facebook.com', 'instagram.com', 'linkedin.com', 'lnkd.in', 'x.com', 'twitter.com', 't.co', 'reddit.com', 'old.reddit.com', 'news.ycombinator.com', 'threads.net', 'threads.com', 'bsky.app', 'pinterest.', 'tiktok.com', 'snapchat.com', 'tumblr.com', 'producthunt.com', 'lobste.rs', 'mastodon.social', 'discord.com', 'telegram.org', 'whatsapp.com', 'slack.com', 'messenger.com'];

const PAID_PARAMS = ['gclid', 'gbraid', 'wbraid', 'msclkid', 'ttclid', 'li_fat_id', 'twclid', 'dclid', 'yclid'];
// Tags email tools add to every link in a message.
const EMAIL_PARAMS = ['mc_cid', 'mc_eid', '_hsenc', '_hsmi'];
// The site a click ID or an email tool's tag comes from, for a visit with no referrer and no written source.
const CLICK_SOURCES = { fbclid: 'facebook.com', igshid: 'instagram.com', gclid: 'google.com', gbraid: 'google.com', wbraid: 'google.com', dclid: 'google.com',
  msclkid: 'bing.com', ttclid: 'tiktok.com', twclid: 'x.com', li_fat_id: 'linkedin.com', yclid: 'yandex.ru', mc_cid: 'mailchimp.com', mc_eid: 'mailchimp.com',
  _hsenc: 'hubspot.com', _hsmi: 'hubspot.com' };
const PAID_MEDIUMS = ['cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'paid_social', 'paidsocial', 'display', 'cpm', 'banner'];

// The same source under another name: link redirectors, mobile hosts and Android apps
// (android-app://com.google.android.gm arrives as the host "com.google.android.gm").
const ALIASES = {
  'l.facebook.com': 'facebook.com', 'lm.facebook.com': 'facebook.com', 'm.facebook.com': 'facebook.com', 'mobile.facebook.com': 'facebook.com',
  'com.facebook.katana': 'facebook.com', 'l.instagram.com': 'instagram.com', 'com.instagram.android': 'instagram.com',
  't.co': 'x.com', 'twitter.com': 'x.com', 'mobile.twitter.com': 'x.com', 'mobile.x.com': 'x.com', 'com.twitter.android': 'x.com',
  'old.reddit.com': 'reddit.com', 'new.reddit.com': 'reddit.com', 'out.reddit.com': 'reddit.com', 'np.reddit.com': 'reddit.com', 'com.reddit.frontpage': 'reddit.com',
  'lnkd.in': 'linkedin.com', 'com.linkedin.android': 'linkedin.com', 'm.youtube.com': 'youtube.com', 'com.google.android.youtube': 'youtube.com',
  'com.google.android.gm': 'mail.google.com', 'com.google.android.googlequicksearchbox': 'google.com', 'com.microsoft.office.outlook': 'outlook.live.com',
  'org.telegram.messenger': 'telegram.org', 't.me': 'telegram.org', 'com.slack': 'slack.com', 'com.discord': 'discord.com', 'com.openai.chatgpt': 'chatgpt.com',
  'l.threads.com': 'threads.com', 'go.bsky.app': 'bsky.app', 'pplx.ai': 'perplexity.ai', 'ya.ru': 'yandex.ru',
};

// What people write in utm_source, source or ref for a site that has a host of its own.
const TAG_ALIASES = {
  fb: 'facebook.com', facebook: 'facebook.com', ig: 'instagram.com', instagram: 'instagram.com', twitter: 'x.com', x: 'x.com',
  linkedin: 'linkedin.com', reddit: 'reddit.com', hn: 'news.ycombinator.com', hackernews: 'news.ycombinator.com',
  youtube: 'youtube.com', yt: 'youtube.com', threads: 'threads.com', bluesky: 'bsky.app', bsky: 'bsky.app', mastodon: 'mastodon.social',
  tiktok: 'tiktok.com', pinterest: 'pinterest.com', telegram: 'telegram.org', whatsapp: 'whatsapp.com', discord: 'discord.com', slack: 'slack.com',
  producthunt: 'producthunt.com', google: 'google.com', bing: 'bing.com', duckduckgo: 'duckduckgo.com', gmail: 'mail.google.com',
  chatgpt: 'chatgpt.com', openai: 'chatgpt.com', perplexity: 'perplexity.ai', claude: 'claude.ai', gemini: 'gemini.google.com', copilot: 'copilot.microsoft.com',
};

// One name per source: Google's and Yandex's country domains are one search engine each, and every
// Outlook Safe Links host is Outlook.
function nameOf(host) {
  if (ALIASES[host]) return ALIASES[host];
  if (/^google\.(com?\.)?[a-z]{2,3}$/.test(host)) return 'google.com';
  if (/^yandex\.(com?\.)?[a-z]{2,3}$/.test(host)) return 'yandex.ru';
  if (host.endsWith('.safelinks.protection.outlook.com')) return 'outlook.office.com';
  return host;
}

// "https://www.l.facebook.com/…" → "facebook.com"; '' when there is no usable host.
export function referrerHost(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
  return host && nameOf(host);
}

// A landing page's utm_source (or source, or ref) as a source: "FB" → "facebook.com", "Spring Newsletter" as written,
// lowercased and cut at 64 characters. Without one, the site a click ID or an email tool's tag comes from; else ''.
export function sourceTag(landing) {
  const tag = (landing.get('utm_source') || landing.get('source') || landing.get('ref') || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/^www\./, '').slice(0, 64).trim();
  if (tag) return TAG_ALIASES[tag] || nameOf(tag);
  return CLICK_SOURCES[[...landing.keys()].find(k => CLICK_SOURCES[k])] || '';
}

export const CHANNELS = ['paid', 'email', 'ai', 'search', 'video', 'social', 'referral', 'direct'];

// Which of the lists a host is on, as bits: a lookup for the host and each parent domain of it in one map of
// every whole host, and a pattern per list for the names ending in a dot.
const LISTS = [EMAIL, AI, SEARCH, NOT_SEARCH, VIDEO, SOCIAL];
const [IS_EMAIL, IS_AI, IS_SEARCH, NOT_A_SEARCH, IS_VIDEO, IS_SOCIAL] = LISTS.map((_, i) => 1 << i);
const WHOLE = new Map(), OPEN = [];
LISTS.forEach((list, i) => {
  for (const d of list) if (!d.endsWith('.')) WHOLE.set(d, (WHOLE.get(d) || 0) | 1 << i);
  const open = list.filter(d => d.endsWith('.')).map(d => d.replace(/\./g, '\\.'));
  if (open.length) OPEN.push([new RegExp(`(^|\\.)(${open.join('|')})`), 1 << i]);
});

function listsOf(host) {
  let on = 0;
  if (!host) return on;
  for (const [re, bit] of OPEN) if (re.test(host)) on |= bit;
  for (let at = host; ;) {
    on |= WHOLE.get(at) || 0;
    const dot = at.indexOf('.');
    if (dot < 0) return on;
    at = at.slice(dot + 1);
  }
}
const searchOf = on => on & IS_SEARCH && !(on & NOT_A_SEARCH);

// referrer: hostname without "www." ('' when none). landing: URLSearchParams of the page the visit started on.
// The landing page's source tag counts as much as the referrer, since apps and newsletters often send none.
export function channelFor(referrer, landing) {
  const medium = (landing.get('utm_medium') || '').toLowerCase();
  const source = sourceTag(landing);
  const r = listsOf(referrer), s = listsOf(source), on = r | s;
  if (PAID_MEDIUMS.includes(medium) || PAID_PARAMS.some(p => landing.has(p))) return 'paid';
  if (medium === 'email' || medium === 'newsletter' || EMAIL_PARAMS.some(p => landing.has(p)) || on & IS_EMAIL) return 'email';
  if (on & IS_AI) return 'ai';
  if (medium === 'organic' || searchOf(r) || searchOf(s)) return 'search';
  if (medium === 'video' || on & IS_VIDEO) return 'video';
  if (medium === 'social' || medium === 'organic_social' || on & IS_SOCIAL) return 'social';
  if (referrer || source) return 'referral';
  return 'direct';
}
