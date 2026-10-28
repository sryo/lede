import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBot, isSpam, unwanted } from '../src/bots.js';
import { parseEvent, collect } from '../src/collect.js';

// Real user agents that must be counted, including the ones easiest to mistake for bots.
const PEOPLE = {
  'Chrome on Windows': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Edge': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  'Safari on macOS, frozen OS version': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  'Safari on iOS 26, reduced UA': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  'Safari on an iPhone 6': 'Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1',
  'Chrome on iOS': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1',
  'Instagram on iOS': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 337.0.3.23.54 (iPhone14,5; iOS 17_5_1; en_US; en; scale=3.00; 1170x2532; 614008222)',
  'Facebook on iOS': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/459.0.0.38.112;FBBV/586003393;FBDV/iPhone13,2;FBMD/iPhone;FBSN/iOS;FBSV/17.4;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5;FBRV/588042327]',
  'LinkedIn on iOS': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.29.6812',
  'Facebook on Android': 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.82 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/462.0.0.47.85;]',
  'Samsung Internet': 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  'Samsung Internet on an old phone': 'Mozilla/5.0 (Linux; Android 9; SAMSUNG SM-J737P) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/9.4 Chrome/67.0.3396.87 Mobile Safari/537.36',
  'UC Browser': 'Mozilla/5.0 (Linux; U; Android 10; en-US; RMX2185 Build/QP1A.190711.020) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.108 UCBrowser/13.4.0.1306 Mobile Safari/537.36',
  'WeChat on the TBS engine': 'Mozilla/5.0 (Linux; Android 10; V2001A Build/QP1A.190711.020; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/66.0.3359.126 MQQBrowser/6.2 TBS/045714 Mobile Safari/537.36 MMWEBID/2733 MicroMessenger/8.0.16.2040(0x28001037) Process/tools WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
  'WeChat on XWEB': 'Mozilla/5.0 (Linux; Android 11; M2012K11AC Build/RKQ1.200826.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/86.0.4240.99 XWEB/3171 MMWEBSDK/20211001 Mobile Safari/537.36 MMWEBID/6170 MicroMessenger/8.0.16.2040(0x28001037) Process/toolsmp WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
  'QQ Browser': 'Mozilla/5.0 (Linux; U; Android 10; zh-cn; PCAM00 Build/QKQ1.190918.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/66.0.3359.126 MQQBrowser/10.8 Mobile Safari/537.36',
  'Baidu app': 'Mozilla/5.0 (Linux; Android 10; ELS-AN00 Build/HUAWEIELS-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/76.0.3809.89 Mobile Safari/537.36 T7/12.10 SP-engine/2.28.0 baiduboxapp/12.10.0.11 (Baidu; P1 10) NABar/1.0',
  'MIUI Browser': 'Mozilla/5.0 (Linux; U; Android 11; zh-cn; M2007J3SC Build/RKQ1.200826.002) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/89.0.4389.116 Mobile Safari/537.36 XiaoMi/MiuiBrowser/15.7.22',
  'Huawei Browser': 'Mozilla/5.0 (Linux; Android 10; HarmonyOS; ELS-AN00; HMSCore 6.1.0.314) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.93 HuaweiBrowser/11.1.5.320 Mobile Safari/537.36',
  'Quark': 'Mozilla/5.0 (Linux; U; Android 11; zh-CN; M2011K2C Build/RKQ1.200928.002) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.108 Quark/5.4.9.201 Mobile Safari/537.36',
  'Douyin, an app webview': 'Mozilla/5.0 (Linux; Android 10; MI 8 Build/QKQ1.190828.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/75.0.3770.156 Mobile Safari/537.36 aweme_190600 JsSdk/1.0 NetType/WIFI Channel/xiaomi_1128_64 AppName/aweme app_version/19.6.0 ByteLocale/zh-CN Region/CN AppSkin/white AppTheme/light BytedanceWebview/d8a21c6',
  'Opera Mini':'Opera/9.80 (Android; Opera Mini/36.2.2254/119.132; U; id) Presto/2.12.423 Version/12.16',
  'KaiOS feature phone': 'Mozilla/5.0 (Mobile; LYF/F300B/LYF-F300B-001-01-15-130718-i;Android; rv:48.0) Gecko/48.0 Firefox/48.0 KAIOS/2.5',
  'LG smart TV': 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager',
  'Firefox': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0',
  'Firefox ESR 115, frozen rv': 'Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0',
  'Firefox on Android': 'Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0',
  'Internet Explorer 11': 'Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko',
};

const BOTS = {
  'IPv6 address': '2001:db8:85a3::8a2e:370:7334',
  'IP and port': '[2001:db8::1]:443',
  'UUID': '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  'non-ASCII': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36 ü',
  'Chrome 74': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.169 Safari/537.36',
  'Chrome 74 on Android, not a webview': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.169 Mobile Safari/537.36',
  'Chrome 41':'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/41.0.2228.0 Safari/537.36',
  'Edge Legacy': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19582',
  'Firefox 40': 'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:40.0) Gecko/20100101 Firefox/40.1',
  'Firefox with the wrong rv': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:91.0) Gecko/20100101 Firefox/120.0',
  'Safari on iOS 9': 'Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1',
  'Internet Explorer 6': 'Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1; SV1)',
  'Internet Explorer 10': 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2; Trident/6.0)',
  'Googlebot': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'headless Chrome': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36',
};

test('real browsers, in-app browsers and old devices are counted', () => {
  for (const [name, ua] of Object.entries(PEOPLE)) assert.equal(isBot(ua), false, name);
});

test('user agents that are addresses, junk or years out of date are bots', () => {
  for (const [name, ua] of Object.entries(BOTS)) assert.equal(isBot(ua), true, name);
});

const beacon = (headers = {}, cf) => {
  const req = new Request('https://worker.test/lede', { method: 'POST', headers: { 'User-Agent': PEOPLE['Chrome on Windows'], Origin: 'https://example.com', ...headers }, body: '{}' });
  return cf ? Object.assign(req, { cf }) : req;
};

test('data-centre networks are dropped unless KEEP_DATACENTER is on', () => {
  assert.equal(unwanted(beacon({}, { asn: 16509 }), {}, PEOPLE['Chrome on Windows']), true, 'AWS');
  assert.equal(unwanted(beacon({}, { asn: 24940 }), {}, PEOPLE['Chrome on Windows']), true, 'Hetzner');
  assert.equal(unwanted(beacon({}, { asn: 16509 }), { KEEP_DATACENTER: 'true' }, PEOPLE['Chrome on Windows']), false);
  // Home broadband, and the networks privacy relays exit through.
  for (const asn of [7922, 13335, 54113, 20940, 15169]) assert.equal(unwanted(beacon({}, { asn }), {}, PEOPLE['Chrome on Windows']), false, String(asn));
  assert.equal(unwanted(beacon(), {}, PEOPLE['Chrome on Windows']), false, 'no cf object');
});

test('Global Privacy Control is respected only when RESPECT_GPC is on', () => {
  const ua = PEOPLE['Chrome on Windows'];
  assert.equal(unwanted(beacon({ 'Sec-GPC': '1' }), {}, ua), false);
  assert.equal(unwanted(beacon({ 'Sec-GPC': '1' }), { RESPECT_GPC: 'true' }, ua), true);
  assert.equal(unwanted(beacon(), { RESPECT_GPC: 'true' }, ua), false);
});

test('referrer spam is dropped, its subdomains too, and real sources are not', () => {
  assert.equal(isSpam('darodar.com'), true);
  assert.equal(isSpam('forum.darodar.com'), true);
  assert.equal(isSpam('google.com'), false);
  assert.equal(isSpam('com'), false);
  assert.equal(parseEvent({ u: 'https://example.com/', r: 'https://www.darodar.com/' }, ['example.com']), null);
  assert.equal(parseEvent({ u: 'https://example.com/', r: 'https://news.ycombinator.com/' }, ['example.com']).referrer, 'news.ycombinator.com');
});

test('collect writes nothing for data centres, GPC or spam, and counts the rest', async () => {
  const points = [];
  const kv = new Map([['sites', '["example.com"]'], ['salt', 's']]);
  const env = { STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) }, EVENTS: { writeDataPoint: p => points.push(p) }, RESPECT_GPC: 'true' };
  const send = (r, headers, cf) => {
    const req = new Request('https://worker.test/lede', { method: 'POST', headers: { 'User-Agent': PEOPLE['Safari on iOS 26, reduced UA'], 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://example.com', ...headers }, body: JSON.stringify({ u: 'https://example.com/', r, l: '' }) });
    return collect(cf ? Object.assign(req, { cf }) : req, env);
  };
  await send('', {}, { asn: 14061, country: 'US' });
  await send('', { 'Sec-GPC': '1' });
  await send('https://free-share-buttons.com/');
  assert.equal(points.length, 0);
  await send('https://duckduckgo.com/', {}, { asn: 3320, country: 'DE' });
  assert.equal(points.length, 1);
});
