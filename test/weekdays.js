// The demo sample is built back from today, so it has to come out the same on any day of the week.
// Calls fn(demoStore, 'Mon') with a fresh copy of src/demo.js made on each of seven days in a row.
export async function onEachWeekday(fn) {
  const RealDate = Date;
  for (let i = 0; i < 7; i++) {
    const fixed = RealDate.parse('2026-10-26T12:00:00Z') + i * 864e5;
    const day = new RealDate(fixed).toUTCString().slice(0, 3);
    globalThis.Date = class extends RealDate {
      constructor(...a) { super(...(a.length ? a : [fixed])); }
      static now() { return fixed; }
    };
    let store;
    try {
      ({ demoStore: store } = await import(`../src/demo.js?weekday=${i}`));
      // The sample is made on first use, so make it while the date is still faked.
      await store.summary({ days: 30, filters: {} });
    } finally {
      globalThis.Date = RealDate;
    }
    await fn(store, day);
  }
}
