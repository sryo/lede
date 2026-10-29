// What a visit came from, read from the user agent: the kind of device, the browser family and its major
// version, and the operating system with its version where the user agent tells it.

// iPadOS 13 and later sends the same user agent as Safari on a Mac, so most iPads land on computer;
// only older iPads, Android tablets and the Kindle's Silk say they're tablets.
// mobile is the Sec-CH-UA-Mobile header, which only Chrome and browsers built on it send. It only settles
// an Android user agent that says neither Mobile nor Tablet, as Chrome's shortened one on a tablet does.
export function deviceOf(ua, mobile) {
  if (/iPad|Tablet|PlayBook|Silk\//i.test(ua)) return 'tablet';
  if (/iPhone|iPod|Mobi|Windows Phone|Opera Mini|KAIOS/i.test(ua)) return 'phone';
  if (/Android/i.test(ua)) return mobile === '?1' ? 'phone' : 'tablet';
  return 'computer';
}

// In order: Edge, Samsung Internet, Opera and apps' own browsers all say Chrome too, so they go first.
// On iPhone, Chrome (CriOS) and Firefox (FxiOS) are Safari underneath but go by their own names.
const BROWSERS = [
  ['edge', /Edg(?:e|A|iOS)?\//],
  ['samsung', /SamsungBrowser\//],
  ['opera', /OPR\/|OPiOS\/|OPT\/|Opera/],
  ['app', /Instagram|FBAN|FBAV|FB_IAB|LinkedInApp|Twitter|Line\/|MicroMessenger|Snapchat|Pinterest|musical_ly|BytedanceWebview|GSA\/|; wv\)/],
  ['firefox', /Firefox\/|FxiOS\//],
  ['chrome', /Chrome\/|CriOS\/|Chromium\//],
  ['safari', /Version\/[\d.]+ (?:Mobile\/\w+ )?Safari\//],
];

// The operating system, with the version iPhones and Android send. Windows 10 and 11 send the same version,
// and Macs have sent 10.15.7 for years whatever they run, so neither is told.
export function osOf(ua) {
  const ios = ua.match(/(?:iPhone|iPad|iPod).*? OS (\d+)_(\d+)/);
  if (ios) return `iOS ${ios[1]}.${ios[2]}`;
  const android = ua.match(/Android (\d+)/);
  if (android) return `Android ${android[1]}`;
  if (/Windows/.test(ua)) return 'Windows';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return 'other';
}

// The browser's major version, by the family browserOf finds; 0 for apps' own browsers and others.
const VERSIONS = { edge: /Edg(?:e|A|iOS)?\/(\d+)/, samsung: /SamsungBrowser\/(\d+)/, opera: /(?:OPR|OPiOS|OPT)\/(\d+)/,
  firefox: /(?:Firefox|FxiOS)\/(\d+)/, chrome: /(?:Chrome|CriOS|Chromium)\/(\d+)/, safari: /Version\/(\d+)/ };
export function versionOf(ua) {
  return Number(VERSIONS[browserOf(ua)]?.exec(ua)?.[1]) || 0;
}

export function browserOf(ua) {
  for (const [name, re] of BROWSERS) if (re.test(ua)) return name;
  // An iPhone or iPad page with no Safari in its user agent is a web view inside some other app.
  return /iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua) ? 'app' : 'other';
}
