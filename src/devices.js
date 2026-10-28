// The kind of device and the browser family a visit came from, read from the user agent. No versions and
// nothing finer, so neither tells people apart.

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

export function browserOf(ua) {
  for (const [name, re] of BROWSERS) if (re.test(ua)) return name;
  // An iPhone or iPad page with no Safari in its user agent is a web view inside some other app.
  return /iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua) ? 'app' : 'other';
}
