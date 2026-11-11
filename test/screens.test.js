import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cover } from './raster.mjs';

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
  assert.match(fn('rowsInto'), /share=fmtShare/);
  assert.match(fn('rowsInto'), /share\(r\.value,total\)/);
});

test('links people clicked lead with a sentence', () => {
  assert.match(fn('drawLinks'), /linksStory\(/);
});

test('What happened leads with its biggest item', () => {
  assert.match(fn('renderEvents'), /eventsSentence\(events,PER\(\),ser\.start,true\)/);
});

test('home’s treemap highlights the page its caption names, as well as the sentence’s', () => {
  assert.match(fn('drawHome'), /drawPages\(.*,found\?\.key\)/);
  assert.match(fn('drawPages'), /told:true/);
});

test('the online list gives a country room for its name', () => {
  assert.doesNotMatch(html, /\.lrow\.online\{grid-template-columns:[^}]* 64px /);
});

test('the hours card leads with when readers come', () => {
  assert.match(fn('drawHeat'), /hoursStory\(cells\)/);
});

test('with bounce unchanged, the Bounce screen names who bounces most', () => {
  assert.match(fn('renderBounce'), /standout=bounceStandout\(rows,c\);say=bounceHeld\(c,standout\)/);
});


test('a bounce chart never blows a one-point wobble up to its full height', () => {
  assert.match(fn('renderBounce'), /span:\.1/);
  assert.match(fn('lines'), /hi-lo<span/);
});

test('day charts draw sharp: gridlines on the half pixel, a day with any visitors at least 2px, bars square at the baseline', () => {
  assert.match(fn('dayBars'), /y=Y\(v\)\+\.5/);
  assert.match(fn('lines'), /y=Math\.round\(Y\(v\)\)\+\.5/);
  assert.match(fn('dayBars'), /v\?Math\.min\(Y\(v\),base-2\):base/);
  assert.doesNotMatch(fn('dayBars'), /rx=/);
});

test('today, when the period ends today, stands in a flat pale track as tall as a usual day of its weekday, named Today, its hint never a comparison', () => {
  const f = fn('dayBars');
  assert.match(f, /last=\(o\.live\?\?!AGO\)\?n-1:n/);
  // A day d before today is in the period, or in the comparison place for place.
  assert.match(f, /u=last<n\?usualDay\(Array\.from\(\{length:29\},\(_,k\)=>\{const d=28-k;return d<n\?cur\[n-1-d\]:prev&&d-gp>=0&&d-gp<n\?prev\[n-1-\(d-gp\)\]:null\}\)\):0/);
  assert.match(f, /if\(i==last&&u>v\)s\+=`<rect [^`]*fill="var\(--\$\{subj\}-p\)"/);
  assert.match(f, /i<last\?fmtDay\(dayDate\(start,i\)\):'Today'/);
  assert.match(f, /todayHint\(/);
  assert.match(fn('drawMarks'), /i<n-1\|\|ser\.back\?f\(dayDate\(ser\.start,i\)\):'Today'/);
});

test('the daily charts set each day against the day in the same place of the comparison window, in the dashed line, the hint and the titles', () => {
  assert.doesNotMatch(html, /sameWeekday|weeksBack/);
  assert.match(fn('dayBars'), /gp=o\.gap\?\?gapNow\(\)/);
  assert.match(fn('lines'), /gap=gapNow\(\)/);
  assert.match(fn('dayBars'), /dayDate\(start,i-gp\)/);
  assert.match(fn('lines'), /dayDate\(start,i-gap\)/);
  // The comparison's big day sits over the day it is paired with, which is the same place.
  assert.match(fn('drawDays'), /col=was\b/);
  assert.match(fn('drawDays'), /:col>=0\?\{i:col,/);
  assert.match(fn('drawDays'), /prevDot:col,/);
  assert.match(html, /const AGAINST=\(\)=>PER\(\)\.against;/);
  assert.match(html, /const gapNow=\(d=DAYS,b=AGO\)=>GAP\?\?alignedGap\(d,b\);/);
  assert.doesNotMatch(html, /per day\$\{[^}]*\?`, against the \$\{DAYS\} days before/);
});

test('the bounce line is a slider: arrows, a week a page, Home and End, Esc hides the day before it goes back', () => {
  const f = fn('lines');
  assert.match(f, /setAttribute\('role','slider'\)/);
  assert.match(f, /aria-valuetext/);
  assert.match(f, /PageDown:-7,PageUp:7,Home:-n,End:n/);
  assert.match(f, /e\.key==='Escape'&&!t\.hidden\)\{e\.stopPropagation\(\)/);
  assert.match(f, /matches\(':focus-visible'\)/);
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

test('a note can be written from home’s chart; a click on a day stays there rather than opening the overview', () => {
  assert.match(fn('drawHome'), /noteDays\(days\.querySelector\('\.viz'\),ser,0\)/);
  assert.doesNotMatch(html, /Pick a day to note what you did/, 'no line always on: the day itself says it');
  assert.match(fn('dayBars'), /Click to add a note/);
  assert.match(fn('noteDays'), /Press Enter to/);
  assert.match(fn('noteDays'), /e\.stopPropagation\(\)/);
  assert.match(fn('editNote'), /querySelector\('\.notable'\)/, 'after saving, focus returns to whichever chart took the note');
  assert.doesNotMatch(html, /\.chart\.notable/, 'the style follows the chart, on home too');
});

test('the overview leads with what happened in the period, not home’s sentence again', () => {
  const r = fn('renderFilter');
  assert.match(r, /overview\?eventsSentence\(H\?\.events\|\|\[\],PER\(\),ser\.start\)/);
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

test('home goes to the overview from its visitors-per-day tile, with no second link to it under the tiles', () => {
  assert.match(fn('drawHome'), /tile\('t-days',[^\n]*openOverview\)/);
  assert.doesNotMatch(html, /home-more/);
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
  assert.match(r, /readsMore\(pages\.rows,H\.pageRows,label\)/);
  assert.match(r, /Did they stay/);
  assert.match(r, /per visit/);
  assert.match(r, /Pages they read/, 'the list is told apart from where they landed');
  assert.match(r, /DIRECT_MEANS/);
  assert.match(r, /Sources in this channel/);
});

test('a page’s view asks where its readers went with the goals, says if they reach one, and weighs the page against the site', () => {
  const r = fn('renderFilter');
  assert.match(r, /api\('next',\{\.\.\.p,goal:GOALS\.length\?GOALS:null\}\)/);
  assert.match(r, /goalFromPage\(n\.cur,/);
  assert.match(r, /pageVerdict\(S\)/);
  assert.match(r, /pageStory\(totals,into,f\.path,PER\(\),/);
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

test('the overview shows sources and pages as two strips shaded by position, its rows a tap away', () => {
  const d = fn('drawInOut');
  assert.match(d, /class="strip"/);
  assert.match(d, /shadeSeg\(subj,i\)/);
  assert.doesNotMatch(d, /rowsInto\(/);
});

// The strips' textures: what shadeSeg asks for, and the achura rules the page carries for light and dark.
const shadeSeg = new Function(`${html.match(/const GLYPHS4=.*\n/)[0]}${html.match(/const shadeSeg=.*\n/)[0]}return shadeSeg`)();
const achuraLine = html.split('\n').find(l => l.includes('.achura-diag.w1{'));
const darkAt = achuraLine.indexOf('@media (prefers-color-scheme:dark){');
const patterns = css => Object.fromEntries([...css.matchAll(/\.achura-(\w+)\.(w\d)\{--achura-g:url\("data:image\/svg\+xml,(.*?)"\)\}/g)]
  .map(m => [`${m[1]}.${m[2]}`, m[3].match(/ d='([^']*)'/)[1]]));
const PATTERNS = { light: patterns(achuraLine.slice(0, darkAt)), dark: patterns(achuraLine.slice(darkAt)) };
const patternOf = i => { const c = shadeSeg('src', i).match(/achura-(\w+) (w\d)/); return c && `${c[1]}.${c[2]}`; };
// A path that starts with the whole tile is cut out of it, under evenodd.
const ink = d => d.startsWith('M0 0h8v8H0z') ? cover({ invert: true, d: d.slice(11) }) : cover(d);

test('a strip’s first part is plain, and every later part has its texture in both themes', () => {
  assert.equal(patternOf(0), null);
  assert.match(shadeSeg('page', 0), /class="page-s"/);
  for (let i = 1; i <= 8; i++) {
    for (const theme of ['light', 'dark']) assert.ok(PATTERNS[theme][patternOf(i)], `${theme} has ${patternOf(i)}, for the part at ${i}`);
  }
});

test('textures keep the part’s own color and fade it toward the card in even steps', () => {
  assert.match(html, /\.src-h,\.page-h,\.time-h\{--achura-ink:var\(--tile\);--achura-a:1\}/);
  for (const s of ['src', 'page', 'time']) assert.match(html, new RegExp(`\\.${s}-h,\\.${s}-s\\{background:var\\(--${s}\\)\\}`));
  const STEPS = [.23, .45, .65, .85];
  const at = [1, 2, 3, 4].map(i => ({ light: ink(PATTERNS.light[patternOf(i)]), dark: ink(PATTERNS.dark[patternOf(i)]) }));
  at.forEach(({ light, dark }, k) => assert.ok(Math.abs((light + dark) / 2 - STEPS[k]) < .03, `part ${k + 2} inks ${((light + dark) / 2 * 100).toFixed(1)}%, about ${STEPS[k] * 100}%`));
  for (const theme of ['light', 'dark']) assert.ok(at.every((x, k) => !k || x[theme] > at[k - 1][theme]), `${theme} inks more at every step`);
});

test('a funnel is drawn as rows against its first step, the visits lost in pale violet', () => {
  const d = fn('drawFunnel');
  assert.match(d, /class="fsteps"/);
  assert.match(html, /\.fsteps \.gone\{background:var\(--page-p\)/);
  assert.doesNotMatch(d, /<svg/);
});

test('the hours chart marks the window and the hour its sentence names', () => {
  assert.match(fn('drawHeat'), /busyWindow\(cells\)/);
  assert.match(html, /\.heat \.cells i\.best\{/);
});

test('links show shares to a tenth of a point, and bold what the sentence names', () => {
  const d = fn('drawLinks');
  assert.match(d, /share:\(v,t\)=>fmtRate\(v\/t\)/);
  assert.match(d, /named:L\?\.named/);
});

test('home’s crowd wraps to its block in three rows at most: a figure a person while everyone fits, else a round number each, said in the caption', () => {
  const d = fn('drawNow');
  assert.match(d, /lineHTML\(C,'wide',C\.more\)/);
  assert.match(d, /fit=3\*[\s\S]*crowdFigures\(live,new Set\(\),fit\)/, 'the room comes from how many fit on three rows, measured');
  assert.match(d, /crowdCaption\(live,C\.unit\)/);
  assert.doesNotMatch(d, /more earlier/, 'no second count beside the caption’s');
  assert.match(html, /\.now \.crowd\{width:0;min-width:100%\}/, 'the figures take the block’s width, never set it');
});

test('treemap labels wrap at joints or turn, sized by fitLabel, with the change under them when there is room', () => {
  const t = fn('treemap');
  assert.match(t, /fitLabel\(it\.label,w,h,labelWidth,pad\)/);
  assert.match(t, /L\.room\?/);
  assert.doesNotMatch(t, /shorten\(/, 'no cut at a fixed number of letters');
  assert.doesNotMatch(html, /\.blk\.small b\{|\.blk\.told b\{/, 'the lines come from fitLabel, not from CSS wrapping');
});

test('list tags line up in a column, and go under the name on phones', () => {
  assert.match(fn('rowsInto'), /<span class="lbl">/);
});

test('bounce rows use the rows of ten squares, with their visits, and bold who the sentence names', () => {
  const r = fn('rateRows');
  assert.match(r, /squaresSVG\(r\.value/);
  assert.match(r, /visits<\/small>/);
  assert.match(fn('renderBounce'), /standout\?\.dim===dim&&standout\.key===r\.key/);
});

test('the Sources waterfall fades everyone else, and the list bolds every mover named', () => {
  assert.match(fn('drawGrowth'), /s\.kind==='else'\?'var\(--src-t\)'/);
  assert.match(fn('renderDim'), /cap\?\.keys/);
});

test('Setup splits its parts, with each command in a copyable well and messages as a state chip', () => {
  const d = fn('drawSetup');
  assert.match(d, /class="code"/);
  assert.match(d, /class="onoff/);
  assert.match(d, /data-copy=/);
});

test('Online fits its crowd on a row or two and folds who left into one line per page', () => {
  const r = fn('renderOnline');
  assert.match(r, /crowd-key/);
  assert.match(r, /class="earlier/);
});

test('a source’s Did they stay card gives the visit length as a number and keeps its link at the bottom', () => {
  assert.match(fn('renderSource'), /class="card stay-card"/);
  assert.match(fn('renderSource'), /readsMore\(pages\.rows,H\.pageRows,label\)/);
});

test('a page’s goal reach is a number beside the others', () => {
  assert.match(fn('renderFilter'), /Reached \$\{esc\(goalWhat\(\)\)\}/);
});

test('What happened’s own screen names the kinds, not the first item again', () => {
  assert.match(fn('renderEvents'), /eventsSentence\(events,PER\(\),ser\.start,true\)/);
});


test('no word is left alone on a last line: centred and short text is balanced, paragraphs are pretty', () => {
  assert.match(html, /\.state\.error,\.onboard,\.empty,\.tip,h1,h2,\.card-title,\.tile-title\{text-wrap:balance\}/);
  assert.match(html, /p,li,figcaption,\.say-sub,\.cap\{text-wrap:pretty\}/);
});

test('a state is a dot and a word, not a pill that looks like a button', () => {
  const rule = sel => (html.match(new RegExp(`\\n${sel.replace(/[.]/g, '\\.')}\\{([^}]*)\\}`)) || [])[1] || '';
  assert.doesNotMatch(rule('.chip'), /border-radius:999px|box-shadow/);
  assert.doesNotMatch(rule('.setup-panel .onoff'), /border-radius:999px|box-shadow/);
});

test('a quiet footer under the window names Lede and links to the project', () => {
  assert.match(html, /<footer class="foot">[\s\S]*href="https:\/\/github\.com\/sryo\/lede"[\s\S]*<\/footer>/);
  assert.match(html, /\.foot\{/);
});

test('the ribbons use one width for what they count, and put each name inside its band or just before a thin one', () => {
  const draw = fn('ribbons');
  assert.match(draw, /th=Math\.max\(2,r\.v\*u\)/);
  assert.match(draw, /inside=a\.th>=r\.lh\+2,x0=inside\?0:Math\.min\(cx-8,r\.lw\+6\)/);
  assert.match(html, /\.flow\{height:100%;position:relative\}/);
});

test('the ribbons fade nothing: each source and page has its own step of its colour, and a strand keeps its source’s', () => {
  const draw = fn('ribbons');
  assert.match(draw, /fill:step\(side==='l'\?'src':'page',at\),lane:step\('bnc',at\)/);
  assert.match(draw, /class="s" data-a="\$\{q\.a\.r\.i\}" data-p="\$\{q\.l\.r\.i\}" d="\$\{d\}" fill="\$\{q\.a\.r\.fill\}"/);
  assert.doesNotMatch(draw, /--src-[tp]|--page-[tp]|opacity/);
  assert.doesNotMatch(draw, /stroke="var\(--ink\)"|Gradient/);
  assert.match(draw, /<rect \$\{cap\} fill="\$\{q\.l\.r\.fill\}"/);
  assert.match(draw, /at=r\.n\.told\?\.4:/);
});

test('home and the Bounce screen draw sources to pages with the same ribbons, straight across in a wide box', () => {
  assert.match(fn('drawFlow'), /ribbons\(el,left\.map\(n=>row\(n,'left'\)\),right\.map\(n=>row\(n,'right'\)\),m,/);
  assert.match(fn('drawOutcome'), /ribbons\(el,srcs\.map\(/);
  assert.match(fn('ribbons'), /if\(W>H\*1\.5\)\{/);
  assert.doesNotMatch(html, /function columns\(/);
});

test('the Bounce screen keeps its third step in a wide box: each page goes on to Read on and Left after one page, with totals', () => {
  assert.match(fn('drawOutcome'), /ends:\[\['Read on','read on',sum\(stay\.map\(x=>x\.visits-x\.bounces\)\)\],\['<b>Left after one page<\/b>','left after this page',sum\(stay\.map\(x=>x\.bounces\)\)\]\]/);
  const draw = fn('ribbons');
  assert.match(draw, /three=ends&&\(W-2\*xa-ow\)\/2>=50/);
  assert.match(draw, /fill="\$\{q\.o\.k\?q\.r\.lane:'var\(--lost-p\)'\}"/);
  assert.match(draw, /bar\('o',o\.k,xd,W-xd,o\.y,o\.th,o\.fill,o\.e\.hint\)/);
});

test('in a tall box the visits that left after a page are a red lane along its row, with their words on it', () => {
  assert.match(fn('drawOutcome'), /stay\[j\]\.bounces\)\}\),m,/);
  assert.match(fn('ribbons'), /gone=l\.th\*\(r\.n\.gone\|\|0\)\/r\.v/);
  assert.match(fn('ribbons'), /r\.lb\.style\.cssText=on\?`color:\$\{onStep\(r\.lb,r\.lane\)\};right:8px;top:\$\{f\(l\.y\+l\.th-gone\/2\)\}px`:'display:none'/);
  assert.match(html, /\.node\.split \.chg\{display:none\}/);
});

test('popovers float with one shadow: the note editor, and Share and Setup, which a card’s outline can’t flatten', () => {
  assert.match(html, /--pop:0 0 0 1px var\(--line\),0 10px 28px -8px rgba\(0,0,0,\.3\)/);
  assert.match(html, /\.note-edit\{[^}]*box-shadow:var\(--pop\)/);
  assert.match(html, /\.card\.share-panel\{[^}]*box-shadow:var\(--pop\)/);
});

test('the tab shows the site’s icon, and Setup offers the nine colourways with the automatic one', () => {
  assert.match(html, /const iconURL=i=>'data:image\/svg\+xml,'\+encodeURIComponent\(iconSVG\(i\)\)/);
  assert.match(fn('setIcon'), /link\[rel="icon"\][\s\S]*iconURL\(iconFor\(SITE,SITES,ICON\)\)/);
  assert.match(fn('loadGoals'), /ICON=[^;]*b\.icon/);
  assert.match(fn('drawSetup'), /Tab icon[\s\S]*ICONS\.map/);
  assert.match(fn('drawSetup'), /\/api\/icon\?site=/);
});

test('the Online view credits the figures only when it draws some', () => {
  assert.match(fn('renderOnline'), /\$\{rows\.length\?'<p class="credit">Figures: Wee People, ProPublica<\/p>':''\}/);
});

test('a read-only link shows goal results, with no way to change the goals', () => {
  assert.doesNotMatch(fn('loadGoals'), /GOALS=SHARED\?\[\]/, 'the goals load for everyone');
  const line = fn('drawGoalLine');
  assert.match(line, /if\(SHARED&&!GOALS\.length\)\{el\.hidden=true;return\}/, 'no goal is offered on a shared link');
  assert.match(line, /one&&!SHARED\?`<button type="button" class="goal-t"/, 'and the flag is only a toggle for the owner');
  const card = fn('drawGoalCard');
  assert.match(card, /if\(SHARED&&!GOALS\.includes\(path\)\)return/);
  assert.match(card, /SHARED\?'':goalSeg\(/);
});

test('no list stops without a way to see the rest: links, a channel’s sources, bounce rows and audience parts', () => {
  assert.match(fn('cutList'), /All \$\{more\?'':`\$\{fmtInt\(full\.length\)\} `\}\$\{what\}/);
  assert.match(fn('drawLinks'), /cutList\([\s\S]*?\),8,'links'/);
  assert.match(fn('renderSource'), /cutList\([\s\S]*?\),8,'sources'/);
  assert.match(fn('renderBounce'), /cutList\([\s\S]*?,toRows\(data\),12,/);
  assert.match(fn('drawAudience'), /class="mix-more"/);
});

test('a source’s bounce link is the one under its squares, not the first list button on the page', () => {
  assert.match(fn('renderSource'), /querySelector\('#sq-note\+\.more-link'\)\.onclick=e=>openBounce/);
});

test('a list the server cut short asks for its top 1,000 only when its button is pressed', () => {
  assert.match(fn('cutList'), /full=await more\(\)/);
  assert.match(fn('drawLinks'), /L\.cut\?\(\)=>all\(\)/);
  assert.match(fn('renderSource'), /members\.cut\?\(\)=>api\('breakdown',\{\.\.\.f,dim:'referrer',all:1\}\)/);
  assert.match(fn('renderSource'), /d\.cut\?\(\)=>api\('breakdown',\{\.\.\.f,dim:'refUrl',all:1\}\)/);
  assert.match(fn('renderBounce'), /data\.cut\?\(\)=>api\('breakdown',\{dim,all:1\}\)/);
  assert.match(fn('dimSection'), /all:whole\?1:null/);
  assert.match(fn('drawInOut'), /H\.cut\?\.\[group\]/);
});

test('the overview reads campaign tags and the readers’ OS, language, screen and place in three queries; a source shows the pages that linked', () => {
  assert.match(fn('drawCampaigns'), /\[\['Campaigns','campaign'\],\['Mediums','medium'\],\['Sources','tag'\]\]/);
  assert.match(fn('drawCampaigns'), /api\('campaigns'\)/);
  assert.doesNotMatch(fn('drawCampaigns'), /breakdown/, 'switching tags asks nothing more');
  assert.match(fn('drawAudienceMore'), /api\('systems'\)[\s\S]*api\('breakdown',\{dim:'place'\}\)/);
  assert.match(fn('renderSource'), /dim:'refUrl'/);
  assert.match(html, /<section class="card camp" hidden><\/section>/);
});

test('the overview\'s minimap places a period and its comparison through setPeriod, and a drag fetches nothing until it ends', () => {
  const f = fn('drawPeriod');
  assert.match(html, /api\('series',\{days:45\}\)/);
  // One slider each for the period and the comparison, for the keyboard.
  assert.match(f, /role="slider" tabindex="0" data-k="p" aria-label="Period"/);
  assert.match(f, /role="slider" tabindex="0" data-k="b" aria-label="Compared with"/);
  // Both windows are kept inside the 90 days by fitWindows (tested in windows.test.js); moving the period pins the comparison.
  assert.match(f, /fitWindows\(\{L,ae,off,pin,manual,alt\},N\)/);
  assert.match(f, /fit\(pin\)/);
  assert.match(f, /steps=\(\)=>windowSteps\(L,ae,N\)/);
  // A period reaching past the 45 days that know each day's top source asks for its own series.
  assert.match(html, /if\(AGO\+DAYS>45\)return api\(route,\{\.\.\.params,days:DAYS,back:AGO,gap:gapNow\(\)\},fresh\)/);
  assert.match(f, /r=setPeriod\(L,N-1-ae,manual\?off:null\)/);
  assert.doesNotMatch(f, /api\(/);
  assert.match(fn('bindPeriod'), /setDays\(/);
  // A period button means the last N days with the weeks that clear it.
  assert.match(html, /const setDays=d=>setPeriod\(d\);/);
});

test('every sentence about the period is given its words, and a period that ended earlier has a finished last day', () => {
  assert.doesNotMatch(html, /audienceNote\(A,DAYS\)|in these \$\{DAYS\} days/);
  assert.match(html, /audienceNote\(A,PER\(\)\)/);
  assert.match(fn('findEvents'), /quietRuns\(cur,ser\.prev\.visitors,!ser\.back\)/);
});

test('the strip: edges and resizes from the pure rules, focus kept only where it was, keys that leave the browser\'s shortcuts alone', () => {
  const f = fn('drawPeriod');
  assert.match(f, /pickEdge\(\{px:at\(p\),cw,hit:HIT,a:as\(\),ae,off,L\}\)/);
  assert.match(f, /resizeWindows\(\{edge:d\.m\.endsWith\('start'\)\?'start':'end',dd,L0:d\.L0,ae0:d\.ae0\},N\)/);
  // Only a slider that had focus when the commit began gets it back; Tab or a click elsewhere is left alone.
  assert.match(f, /const f=chips\.includes\(document\.activeElement\)\?document\.activeElement\.dataset\.k:null/);
  assert.match(f, /focus\(\{preventScroll:true\}\)/);
  assert.doesNotMatch(f, /\bchip\b/);
  // A comparison the owner never moved is the default again once a commit ends, even when nothing changed.
  assert.match(f, /manual=off!==alignedGap\(L,N-1-ae\)/);
  assert.match(f, /k\.altKey\|\|k\.ctrlKey\|\|k\.metaKey/);
  assert.match(f, /Home:/);
  assert.match(f, /End:/);
  for (const a of ['valuenow', 'valuemin', 'valuemax']) assert.match(f, new RegExp(`aria-${a}`));
  assert.match(f, /if\(counted<0\)\{el\.innerHTML='';return\}/);
  // The labels stay inside the strip: the comparison's on the right, "Nothing counted yet" on the left.
  assert.match(f, /lab\(Math\.min\(Math\.max\(x\(b\),0\),W-bl\.length\*6\.5\),12,bl,'start'\)/);
  assert.match(f, /Math\.max\(x\(first\)-6,19\*6\.5\)/);
  // A cancelled gesture goes back to where it began; a resize mid-drag keeps the finger's place in days.
  assert.match(f, /view\.onpointercancel=/);
  assert.match(f, /i0:at\(p\)\/cw/);
  assert.match(f, /t=setTimeout\(\(\)=>commit\(\),800\)/);
});

test('an SVG def gets an id of its own each time it is drawn, since a hidden screen\'s copy under the stack would win', () => {
  const ids = [...html.matchAll(/<(pattern|clipPath|linearGradient|radialGradient|mask|marker|filter) id="([^"]*)"/g)].map(m => m[2]);
  assert.ok(ids.length >= 2);
  for (const id of ids) assert.match(id, /\$\{/, `${id} is the same in every drawing`);
  // A reference inside a plain string isn't filled in, so it names no def at all.
  for (const [ref] of html.matchAll(/'url\(#[^)]*\)'|url\(#[^$][^)]*\)/g)) assert.fail(`${ref} doesn't point at a def drawn with it`);
});

test('the period strip lives in the header beside 7 and 30 days, on every screen, and previews only a chart that shows the whole site', () => {
  // One markup for the topbar and every layer's header: the presets, a Custom button and the panel with the strip.
  assert.match(html, /const PERIOD='<div class="period" role="group" aria-label="Show the last">[^']*data-days="7"[^']*data-days="30"[^']*class="custom" aria-expanded="false"[^']*<section class="card period-panel" hidden><div class="mm"><\/div><\/section><\/div>';/);
  assert.match(html, /<div class="period" role="group" aria-label="Show the last" id="period">[\s\S]*?class="custom" aria-expanded="false"[\s\S]*?<section class="card period-panel" hidden><div class="mm"><\/div><\/section>/);
  // The overview no longer carries a strip of its own.
  assert.doesNotMatch(fn('renderFilter'), /drawPeriod|class="mm"/);
  // Only a chart of every visitor takes the live preview; filtered charts redraw once the window is let go.
  assert.match(html, /<div class="chart"\$\{overview&&H\?' data-daily="scale"':''\}>/);
  assert.match(fn('drawHome'), /dataset\.daily=''/);
  const t = fn('togglePeriod');
  assert.match(t, /api\('series',\{days:45\}\)/);
  assert.match(t, /drawPeriod\(panel\.querySelector\('\.mm'\),strip,dailyChart,restoreDaily\)/);
  assert.match(html, /const dailyChart=\(\)=>stack\[stack\.length-1\]\.el\.querySelector\('\[data-daily\]'\)/);
  assert.match(fn('drawPeriod'), /const c=getChart\(\);if\(c\)dayBars\(c,/);
  // The Custom button says the range once the period isn't 7 or 30 days ending today with the default comparison.
  assert.match(fn('markPeriods') + html, /b\.textContent=preset\?'Custom':PER\(\)\.range/);
  // Esc, a press elsewhere and opening another screen close it.
  assert.match(html, /addEventListener\('keydown',e=>\{if\(e\.key==='Escape'\)closePeriod\(\)\}\)/);
  assert.match(html, /addEventListener\('pointerdown',e=>\{if\(!e\.target\.closest\('\.period'\)\)closePeriod\(\)\}\)/);
  assert.match(fn('zoom'), /closePeriod\(\)/);
});
