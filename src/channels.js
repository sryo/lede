// A trailing dot matches any TLD ("google." covers google.com and google.co.uk).
const AI = ['chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com', 'copilot.microsoft.com', 'poe.com', 'meta.ai', 'you.com', 'phind.com', 'grok.com', 'chat.deepseek.com', 'chat.mistral.ai'];
const SEARCH = ['google.', 'bing.com', 'duckduckgo.com', 'search.brave.com', 'yahoo.', 'yandex.', 'baidu.com', 'ecosia.org', 'startpage.com', 'kagi.com', 'qwant.com', 'search.naver.com', 'msn.com'];
const EMAIL = ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.com', 'mail.proton.me', 'app.fastmail.com', 'mail.zoho.com'];
const VIDEO = ['youtube.com', 'youtu.be', 'twitch.tv', 'vimeo.com'];
const SOCIAL = ['facebook.com', 'm.facebook.com', 'l.facebook.com', 'instagram.com', 'linkedin.com', 'lnkd.in', 'x.com', 'twitter.com', 't.co', 'reddit.com', 'old.reddit.com', 'news.ycombinator.com', 'threads.net', 'threads.com', 'bsky.app', 'pinterest.', 'tiktok.com', 'snapchat.com', 'tumblr.com', 'producthunt.com', 'lobste.rs', 'mastodon.social', 'discord.com', 'telegram.org', 'whatsapp.com', 'slack.com', 'messenger.com'];

const PAID_PARAMS = ['gclid', 'gbraid', 'wbraid', 'msclkid', 'ttclid', 'li_fat_id', 'twclid', 'dclid'];
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
  'org.telegram.messenger': 'telegram.org', 'com.slack': 'slack.com', 'com.discord': 'discord.com', 'com.openai.chatgpt': 'chatgpt.com',
};

// "https://www.l.facebook.com/…" → "facebook.com"; '' when there is no usable host.
export function referrerHost(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
  return ALIASES[host] || host;
}

export const CHANNELS = ['paid', 'email', 'ai', 'search', 'video', 'social', 'referral', 'direct'];

function matches(host, list) {
  return list.some(d => d.endsWith('.')
    ? host.startsWith(d) || host.includes('.' + d)
    : host === d || host.endsWith('.' + d));
}

// referrer: hostname without "www." ('' when none). landing: URLSearchParams of the page the visit started on.
export function channelFor(referrer, landing) {
  const medium = (landing.get('utm_medium') || '').toLowerCase();
  const source = (landing.get('utm_source') || landing.get('ref') || '').toLowerCase();
  if (PAID_MEDIUMS.includes(medium) || PAID_PARAMS.some(p => landing.has(p))) return 'paid';
  if (medium === 'email' || medium === 'newsletter' || matches(referrer, EMAIL)) return 'email';
  if (matches(referrer, AI) || matches(source, AI)) return 'ai';
  if (medium === 'organic' || matches(referrer, SEARCH)) return 'search';
  if (medium === 'video' || matches(referrer, VIDEO)) return 'video';
  if (medium === 'social' || medium === 'organic_social' || matches(referrer, SOCIAL)) return 'social';
  if (referrer || source) return 'referral';
  return 'direct';
}
