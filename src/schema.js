// Layout of one Analytics Engine data point. collect.js writes blobs in this order and
// queries.js reads them back by column name, so this is the single place that maps the two.
// Rows already stored keep their layout, so new fields only ever go at the end.
export const FIELDS = [
  'site', 'path', 'url', 'referrer', 'channel', 'visitor', 'visit', 'type',
  'country', 'utmSource', 'utmMedium', 'utmCampaign', 'target',
  // Kind of device (phone, tablet, computer) and browser family, then the ad keyword (utm_term).
  'device', 'browser', 'utmTerm',
];
// Engagement figures go in doubles: milliseconds the page was read, and how far down it was scrolled (%).
// step is a page view's place in its visit (1, 2, or 3 for any later one; 0 when unknown), so visits and
// bounces can be counted from sampled rows. Then the page view's Web Vitals, sent with its engagement:
// LCP and INP in ms, and CLS times 1000 plus 1 (0: not measured). view is when the page view started, in
// ms, on its page view, engagement events and pings (0 on rows from before it was sent), so a view's
// several engagement events can be told apart from another's; left is 1 on each engagement event sent since
// the tracker marks the view left (hidden, closed or moved on from), 0 on rows from before.
export const NUMBERS = ['engaged', 'scroll', 'step', 'lcp', 'inp', 'cls', 'view', 'left'];

export const COL = {
  ...Object.fromEntries(FIELDS.map((f, i) => [f, `blob${i + 1}`])),
  ...Object.fromEntries(NUMBERS.map((f, i) => [f, `double${i + 1}`])),
};

export function toDataPoint(ev) {
  return { indexes: [ev.site], blobs: FIELDS.map(f => ev[f] ?? ''), doubles: NUMBERS.map(f => ev[f] ?? 0) };
}
