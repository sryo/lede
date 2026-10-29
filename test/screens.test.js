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
  assert.match(fn('rowsInto'), /share=fmtShare/);
  assert.match(fn('rowsInto'), /share\(r\.value,total\)/);
});

test('links people clicked lead with a sentence', () => {
  assert.match(fn('drawLinks'), /linksStory\(/);
});

test('What happened leads with its biggest item', () => {
  assert.match(fn('renderEvents'), /eventsSentence\(events,DAYS,ser\.start,true\)/);
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

test('the overview shows sources and pages as two strips, the named one solid, its rows a tap away', () => {
  const d = fn('drawInOut');
  assert.match(d, /class="strip"/);
  assert.doesNotMatch(d, /rowsInto\(/);
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
  assert.match(fn('renderEvents'), /eventsSentence\(events,DAYS,ser\.start,true\)/);
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

test('home’s Sankey gives a source’s change its own line under the name, so the label column stays narrow', () => {
  assert.match(fn('drawFlow'), /b\.innerHTML=`<span>\$\{told\?`<b>\$\{esc\(name\)\}<\/b>`:esc\(name\)\}<\/span><span class="chg">/);
  assert.match(html, /\.flow\{height:100%;display:grid;grid-template-columns:120px minmax\(0,1fr\) 120px;/);
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
