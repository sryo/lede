import SPAM from './spam.js';

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor|uptime|curl|wget|python|axios|go-http|java\/|httpclient|scrapy|facebookexternalhit|embedly|fetcher|archiver|phantomjs|puppeteer|playwright|selenium|okhttp|node-fetch|undici|inspectiontool|mediapartners/i;

// Only hex digits and separators: an IP address, a UUID or a hash, never a browser.
const NOT_A_NAME = /^[\da-f.:[\]-]+$/i;

// The oldest major version a real browser still sends. Scripts copy user agents from old examples,
// so a version every updating device left behind years ago is a giveaway. Chrome 89 and Firefox 77
// are from 2021 and 2020 (Android 4.4 and OS X 10.10 stopped at Chrome 81 and 87, a cost we accept);
// Safari 12 is the last on the iPhone 6, so only phones from 2012 and older fall below it.
const OLDEST = { chrome: 90, firefox: 78, safari: 12 };

// Browsers that ship an older engine on purpose or run on devices that never update it: Android
// webviews ("; wv)", whose engine belongs to the app or to a system webview that phones without
// Google Play never update), the Chinese browsers and apps that bundle their own frozen Chromium
// (WeChat's TBS and XWEB, QQ, Baidu, Quark, Sogou and the phone makers' own), UC Browser, Samsung
// Internet on old phones, smart TVs, cars, KaiOS feature phones and the Firefox forks.
const OLD_ON_PURPOSE = /; wv\)|MicroMessenger|MQQBrowser|TBS\/|XWEB\/|baiduboxapp|baidubrowser|Quark\/|SogouMobileBrowser|MiuiBrowser|HuaweiBrowser|HeyTapBrowser|OppoBrowser|VivoBrowser|UCBrowser|SamsungBrowser|SMART-TV|SmartTV|Tizen|Web0S|HbbTV|Tesla\/|KAIOS|Goanna|PaleMoon|SeaMonkey|Waterfox/i;

const major = (ua, re) => +(ua.match(re)?.[1] ?? Infinity);

function tooOld(ua) {
  if (OLD_ON_PURPOSE.test(ua)) return false;
  // Internet Explorer 11 dropped "MSIE"; anything older is long gone.
  if (/MSIE \d/.test(ua)) return true;
  if (major(ua, /Chrom(?:e|ium)\/(\d+)/) < OLDEST.chrome) return true;
  if (major(ua, /Firefox\/(\d+)/) < OLDEST.firefox) return true;
  // Version/ is Safari's own version. Android browsers and webviews send a fake "Version/4.0", and
  // in-app browsers on iOS (Instagram, Facebook, LinkedIn) send none, so neither is checked.
  return !/Chrom|Android|CriOS|FxiOS|EdgiOS/.test(ua) && major(ua, /Version\/(\d+)[\d.]* (?:Mobile\/\w+ )?Safari\//) < OLDEST.safari;
}

// Firefox repeats its version in "rv:". Firefox 110–119 froze it at 109 (ESR 115 still does).
function rvMismatch(ua) {
  const m = ua.match(/rv:(\d+)[\d.]*\) Gecko\/[\d.]+ Firefox\/(\d+)/);
  return !!m && m[1] !== m[2] && !(m[1] === '109' && m[2] >= 110 && m[2] <= 119);
}

// Real browsers' user agents are long but not huge, plain ASCII and reasonably current; scripts
// often send a short one, junk, or one copied from an old example.
export function isBot(ua) {
  return ua.length <= 16 || ua.length > 500 || /[^\x20-\x7e]/.test(ua) || NOT_A_NAME.test(ua) || BOT.test(ua) || tooOld(ua) || rvMismatch(ua);
}

// Networks of cloud and hosting providers. People don't browse from servers; scrapers, headless
// browsers and link checkers do. Google's 15169 is left out: it carries Pixel's VPN and Google Fi,
// and Google's own crawlers say so in their user agent. Cloudflare, Fastly and Akamai's CDN are
// left out too, because iCloud Private Relay and similar privacy proxies exit through them.
export const DATACENTERS = new Set([
  16509, 14618, // Amazon Web Services
  396982, // Google Cloud
  8075, // Microsoft Azure
  31898, // Oracle Cloud
  45102, // Alibaba Cloud
  132203, // Tencent Cloud
  14061, // DigitalOcean
  24940, 213230, // Hetzner, Hetzner Cloud
  16276, // OVHcloud
  63949, // Linode (Akamai Connected Cloud)
  20473, // Vultr
  51167, // Contabo
  12876, // Scaleway
]);

// Beacons we don't count: bots, data centres (unless KEEP_DATACENTER="true") and, when
// RESPECT_GPC="true", browsers whose owner asked sites not to track them (Global Privacy Control).
// Cloudflare's Browser Rendering (which takes the pictures on a page's view) sends an ordinary Chrome user
// agent from Cloudflare's own network, but always adds one of these headers, which no person's browser sends.
const RENDERED = ['cf-brapi-request-id', 'cf-brapi-devtools'];

export function unwanted(req, env, ua) {
  return isBot(ua) || !!req.cf?.botManagement?.verifiedBot || RENDERED.some(h => req.headers.has(h))
    || (env.KEEP_DATACENTER !== 'true' && DATACENTERS.has(req.cf?.asn))
    || (env.RESPECT_GPC === 'true' && req.headers.get('Sec-GPC') === '1');
}

const SPAMMERS = new Set(SPAM.trim().split('\n'));

// The host or any domain above it ("x.spam.ru" is spam when "spam.ru" is).
export function isSpam(host) {
  for (let h = host; h.includes('.'); h = h.slice(h.indexOf('.') + 1)) if (SPAMMERS.has(h)) return true;
  return false;
}
