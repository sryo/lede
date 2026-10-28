import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// What each screen asks for and names, read from the dashboard's source, where a rule has no function of its own.
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const fn = name => {
  const at = html.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(at >= 0, `${name} exists`);
  return html.slice(at, html.indexOf('\n}\n', at));
};

test('the Pages screen leads with the page that moved most, home’s page included', () => {
  assert.match(fn('renderDim'), /pagesFinding\(H\.pageRows\)/);
});

test('a goal flag can be seen before it is hovered', () => {
  assert.doesNotMatch(html, /\.goal-t\{[^}]*opacity:0[;}]/);
});

test('a page seen from one source draws only that source’s visits arriving', () => {
  assert.match(fn('renderFilter'), /api\('flows',\{referrer:f\.referrer,channel:f\.channel\}\)/);
});

test('list shares that round to nothing say <1%', () => {
  assert.match(fn('rowsInto'), /fmtShare\(r\.value,total\)/);
});

test('links people clicked lead with a sentence', () => {
  assert.match(fn('drawLinks'), /linksStory\(/);
});

test('What happened leads with its biggest item', () => {
  assert.match(fn('renderEvents'), /eventsSentence\(events,DAYS,ser\.start\)/);
});

test('home’s treemap highlights the page its caption names, as well as the sentence’s', () => {
  assert.match(fn('drawHome'), /drawPages\(.*,found\?\.key\)/);
  assert.match(fn('drawPages'), /told:true/);
  assert.match(fn('treemap'), /it\.told\?pathHTML\(it\.label\)/, 'a named block keeps its whole name');
});

test('the online list gives a country room for its name', () => {
  assert.doesNotMatch(html, /\.lrow\.online\{grid-template-columns:[^}]* 64px /);
});

test('the hours card leads with when readers come', () => {
  assert.match(fn('drawHeat'), /hoursStory\(cells\)/);
});

test('with bounce unchanged, the Bounce screen names who bounces most', () => {
  assert.match(fn('renderBounce'), /bounceHeld\(c,bounceStandout\(/);
});

test('bounce rows show how many visits, with the bounced part in red', () => {
  assert.match(fn('rateRows'), /r\.visits\/most/);
});

test('a bounce chart never blows a one-point wobble up to its full height', () => {
  assert.match(fn('renderBounce'), /span:\.1/);
  assert.match(fn('lines'), /hi-lo<span/);
});

test('the Online screen weighs the last half hour against a usual one, from home’s hours', () => {
  assert.match(fn('renderOnline'), /onlinePace\(live,H\?\.hourly/);
  assert.match(fn('drawHome'), /hourly,pace:/);
});

test('home’s here-now block looks like something to open', () => {
  assert.match(fn('drawNow'), /CHEV/);
});

test('today’s pace and the usual crowd read the same 30 days of hours whatever the period', () => {
  assert.doesNotMatch(html, /api\('hourly'\)/, 'every ask for the hours names its 30 days');
  assert.match(fn('renderFilter'), /lastDays\(hourly,DAYS\)/, 'the overview’s hours card shows only the period');
});

test('home’s third tile asks whether visitors stayed: bounce, who bounces most, and how long a visit lasts', () => {
  const home = fn('drawHome');
  assert.match(home, /tile\('t-stay','Did they stay'/);
  assert.match(home, /stayCaption\(S,B\)/);
  assert.match(fn('drawStay'), /stayStandout\(S,B\)/);
  assert.match(html, /const stayStandout=[^\n]*bounceStandout\(/);
  assert.match(fn('drawStay'), /fmtDur\(c\.duration\)/);
});

test('a note can be written from home’s chart, which no longer sends a click on a day to the overview', () => {
  assert.match(fn('drawHome'), /noteDays\(days\.querySelector\('\.viz'\),ser,0\)/);
  assert.match(fn('noteDays'), /e\.stopPropagation\(\)/);
  assert.match(fn('editNote'), /querySelector\('\.notable'\)/, 'after saving, focus returns to whichever chart took the note');
  assert.doesNotMatch(html, /\.chart\.notable/, 'the style follows the chart, on home too');
});

test('the overview leads with what happened in the period, not home’s sentence again', () => {
  const r = fn('renderFilter');
  assert.match(r, /overview\?eventsSentence\(H\?\.events\|\|\[\],DAYS,ser\.start\)/);
  assert.doesNotMatch(r, /overview\?\(H\?\.T\.html/);
});

test('the overview tells where readers came from and what they read in one card, from home’s rows', () => {
  const r = fn('renderFilter');
  assert.match(r, /drawInOut\(/);
  assert.match(r, /f\.path==null&&!overview\?'<section data-group="pages">/, 'no copy of the Pages list');
  assert.match(fn('drawInOut'), /findings\(H\.S,H\.T\.told/);
  assert.match(fn('drawInOut'), /pagesFinding\(H\.pageRows,H\.T\.page\)/);
});

test('the overview’s cards go from the story to the details: in and out, words, readers, hours, funnels, links', () => {
  assert.match(fn('renderFilter'), /What happened[\s\S]*inout[\s\S]*card kw[\s\S]*card aud[\s\S]*By weekday and hour[\s\S]*funnels-card/);
});

test('home has a labelled way into the overview', () => {
  assert.match(fn('drawHome'), /class="more-link home-more"/);
});

test('a funnel’s lost visits say they left', () => {
  assert.match(fn('drawFunnel'), /b\.said/);
  assert.match(fn('drawFunnel'), /b\.share/);
});

test('the Setup panel gives the tracking line, a way to add a site, whether messages are on, and sign out', () => {
  assert.match(html, /id="setup" aria-expanded="false" aria-controls="setup-panel"/);
  const d = fn('drawSetup');
  assert.match(d, /\/t\.js/, 'the line to copy');
  assert.match(d, /\/api\/sites/, 'add a site');
  assert.match(d, /MESSAGES\?/, 'messages on or off');
  assert.match(d, /ALERT_WEBHOOK/, 'how to turn them on');
  assert.match(d, /PASSWORD\?/, 'sign out only when there is a password');
  assert.match(d, /\/api\/signout/);
  assert.match(fn('boot'), /messages:MESSAGES=false,password:PASSWORD=false/);
});

test('the Sources screen shows the biggest movers, and tags each site with its channel', () => {
  assert.match(fn('renderDim'), /waterfallMovers\(H\.S\)/);
  assert.match(fn('dimSection'), /sub:mode==='referrer'&&!compact&&r\.channel&&r\.key\?labelOf\('channel',r\.channel\)/);
});

test('a source’s view tells its own story: the page that moved most, a page its readers favour, and how long they stay', () => {
  const r = fn('renderSource');
  assert.match(r, /pagesFinding\(own\)/);
  assert.match(r, /readsMore\(pages\.rows,H\.pageRows\)/);
  assert.match(r, /Did they stay/);
  assert.match(r, /A visit lasts/);
  assert.match(r, /Pages they read/, 'the list is told apart from where they landed');
  assert.match(r, /DIRECT_MEANS/);
  assert.match(r, /Sources in this channel/);
});

test('a page’s view asks where its readers went with the goals, says if they reach one, and weighs the page against the site', () => {
  const r = fn('renderFilter');
  assert.match(r, /api\('next',\{\.\.\.p,goal:GOALS\.length\?GOALS:null\}\)/);
  assert.match(r, /goalFromPage\(n\.cur,/);
  assert.match(r, /pageVerdict\(S\)/);
  assert.match(r, /pageStory\(totals,into,f\.path,DAYS,/);
  assert.match(r, /f\.path!=null&&f\.path!=='\/'\?'<section class="card goal-card"/, 'the home page is no goal');
});

test('the speed bar says the rating in words beside the wait', () => {
  assert.match(fn('drawSpeed'), /S\.rating/);
});

test('the full Pages list says how long each page is read, from the speed answer it already asks for', () => {
  assert.match(fn('renderDim'), /dimSection\([^\n]*,speed\)/);
  assert.match(fn('dimSection'), /fmtDur\(e\.median\/1000\)\} read/);
});

test('the speed card’s note keeps the layout score, on hover', () => {
  assert.match(fn('drawSpeed'), /S\.layout/);
});
