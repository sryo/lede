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
export const NUMBERS = ['engaged', 'scroll'];

export const COL = {
  ...Object.fromEntries(FIELDS.map((f, i) => [f, `blob${i + 1}`])),
  ...Object.fromEntries(NUMBERS.map((f, i) => [f, `double${i + 1}`])),
};

export function toDataPoint(ev) {
  return { indexes: [ev.site], blobs: FIELDS.map(f => ev[f] ?? ''), doubles: NUMBERS.map(f => ev[f] ?? 0) };
}
