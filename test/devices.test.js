import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceOf, browserOf } from '../src/devices.js';

// Real user agents, as each browser sends them today.
const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  // iPadOS 13 and later asks for the desktop site, so an iPad sends what a Mac's Safari sends.
  ipadOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  androidPhone: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  firefoxTablet: 'Mozilla/5.0 (Android 14; Tablet; rv:142.0) Gecko/142.0 Firefox/142.0',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 OPR/122.0.0.0',
  instagramIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22G86 Instagram 394.0.0.46.81 (iPhone15,3; iOS 18_6; en_US; en; scale=3.00; 1290x2796; 785118405)',
  instagramAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/139.0.0.0 Mobile Safari/537.36 Instagram 394.0.0.46.81 Android',
  facebookIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22G86 [FBAN/FBIOS;FBAV/520.0.0.40.104;FBBV/123;FBDV/iPhone15,3;FBMD/iPhone;FBSN/iOS;FBSV/18.6;FBSS/3;FBLC/en_US]',
  chromeIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/139.0.7258.76 Mobile/15E148 Safari/604.1',
  firefoxIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/142.0 Mobile/15E148 Safari/605.1.15',
  edgeIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/139.3405.86 Mobile/15E148 Safari/605.1.15',
  edgeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36 EdgA/139.0.0.0',
};

test('phones, tablets and computers', () => {
  assert.equal(deviceOf(UA.iphoneSafari), 'phone');
  assert.equal(deviceOf(UA.androidPhone), 'phone');
  assert.equal(deviceOf(UA.samsung), 'phone');
  assert.equal(deviceOf(UA.instagramIOS), 'phone');
  assert.equal(deviceOf(UA.androidTablet), 'tablet', 'Android without "Mobile" is a tablet');
  assert.equal(deviceOf(UA.firefoxTablet), 'tablet');
  assert.equal(deviceOf(UA.windowsEdge), 'computer');
  assert.equal(deviceOf(UA.linuxFirefox), 'computer');
  assert.equal(deviceOf(UA.macSafari), 'computer');
  assert.equal(deviceOf(''), 'computer');
});

test('an iPad on iPadOS 13 or later reads as a computer, because it sends a Mac\'s user agent', () => {
  assert.equal(deviceOf(UA.ipadOS), 'computer');
  assert.equal(deviceOf(UA.ipadOS, null), 'computer');
});

test('Sec-CH-UA-Mobile only settles an Android user agent that says neither phone nor tablet', () => {
  assert.equal(deviceOf(UA.androidTablet, '?1'), 'phone');
  assert.equal(deviceOf(UA.androidTablet, '?0'), 'tablet');
  assert.equal(deviceOf(UA.windowsChrome, '?1'), 'computer', 'not on a computer\'s user agent');
  assert.equal(deviceOf(UA.androidPhone, '?0'), 'phone', 'not over a user agent that says Mobile');
  assert.equal(deviceOf(UA.firefoxTablet, '?1'), 'tablet', 'not over one that says Tablet');
});

test('browser families, without versions', () => {
  assert.equal(browserOf(UA.iphoneSafari), 'safari');
  assert.equal(browserOf(UA.macSafari), 'safari');
  assert.equal(browserOf(UA.windowsChrome), 'chrome');
  assert.equal(browserOf(UA.androidPhone), 'chrome');
  assert.equal(browserOf(UA.linuxFirefox), 'firefox');
  assert.equal(browserOf(''), 'other');
  assert.equal(browserOf('Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko)'), 'other');
});

test('browsers built on Chrome are told apart from it', () => {
  assert.equal(browserOf(UA.windowsEdge), 'edge');
  assert.equal(browserOf(UA.edgeAndroid), 'edge');
  assert.equal(browserOf(UA.edgeIOS), 'edge');
  assert.equal(browserOf(UA.samsung), 'samsung');
  assert.equal(browserOf(UA.opera), 'opera');
  assert.equal(browserOf(UA.instagramAndroid), 'app');
});

test('on iPhone, Chrome and Firefox go by their own names, and apps\' own browsers count as apps', () => {
  assert.equal(browserOf(UA.chromeIOS), 'chrome');
  assert.equal(browserOf(UA.firefoxIOS), 'firefox');
  assert.equal(browserOf(UA.instagramIOS), 'app');
  assert.equal(browserOf(UA.facebookIOS), 'app');
  assert.equal(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22G86'), 'app', 'a web view with no Safari in it');
});
