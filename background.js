// JournalLens service worker: talks only to official sources.
//   Scopus (Elsevier)        -> CiteScore, rank, percentile, quartile, coverage
//   Master Journal List      -> Web of Science Core Collection index (Clarivate)
//   Crossref                 -> author order, ISSNs, journal title (publisher deposit)
//   JCR file imported by user -> Journal Impact Factor (Clarivate's own export)

const SCOPUS = 'https://www.scopus.com';
const DAY = 86400000;
const TTL = { scopus: 30 * DAY, mjl: 30 * DAY, crossref: 7 * DAY, subj: 90 * DAY, paper: 30 * DAY, miss: 3 * DAY };

class NeedSession extends Error {}
class LoginRequired extends Error {}
class BadPayload extends Error {}   // Scopus occasionally answers with another record; never shown, retried

// ---------- small helpers ----------
const normIssn = s => {
  const d = String(s || '').toUpperCase().replace(/[^0-9X]/g, '');
  return d.length === 8 ? d.slice(0, 4) + '-' + d.slice(4) : '';
};
const digits = s => String(s || '').toUpperCase().replace(/[^0-9X]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One request at a time per service with a gap: Scopus throttles bursts, Crossref asks for polite use.
const lanes = {};
function serial(name, gap, fn) {
  const lane = lanes[name] || (lanes[name] = { p: Promise.resolve(), last: 0 });
  const run = lane.p.then(async () => {
    const wait = lane.last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { lane.last = Date.now(); }
  });
  lane.p = run.catch(() => {});
  return run;
}
// Concurrent asks for the same journal share one lookup
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function cacheGet(key, ttl) {
  const o = (await chrome.storage.local.get(key))[key];
  return o && Date.now() - o.t < ttl ? o.v : null;
}
async function cacheSet(key, v) { await chrome.storage.local.set({ [key]: { t: Date.now(), v } }); }

const tag = (xml, name) => {
  const m = xml.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1].trim() : '';
};
const blocks = (xml, name) => {
  const out = []; const re = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'g'); let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
};
const unesc = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// ---------- tab utilities (used when a direct request has no session) ----------
function waitTab(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); reject(new Error('timeout')); }, timeout);
    function fn(id, info, tab) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer); chrome.tabs.onUpdated.removeListener(fn); resolve(tab);
      }
    }
    chrome.tabs.onUpdated.addListener(fn);
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete' && t.url && !t.url.startsWith('about:')) { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(fn); resolve(t); } }).catch(() => {});
  });
}
async function tabGo(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await sleep(300);
  return waitTab(tabId);
}
async function tabRun(tabId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r ? r.result : undefined;
}
const pageText = () => ({ host: location.host, href: location.href, text: document.body ? document.body.innerText : '', html: document.documentElement.outerHTML });

// ---------- Scopus ----------
function parseSourceIds(html) {
  if (!/sourceSearchForm/.test(html)) throw new NeedSession('no scopus page');
  const m = html.match(/<input[^>]*name="sourceIds"[^>]*>/);
  if (!m) return [];
  const v = (m[0].match(/value="([^"]*)"/) || [])[1] || '';
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

function parseSourceInfo(jsonText, id) {
  const j = JSON.parse(jsonText);
  const x = j.response || '';
  if (!/<ns2:sourceInfo/.test(x)) throw new BadPayload('unexpected source payload');
  const ab = tag(x, 'abstracts');
  if (tag(ab, 'abstractsId') !== String(id)) throw new BadPayload('source id mismatch');
  const metrics = {};
  for (const b of blocks(ab, 'metric')) metrics[tag(b, 'name')] = { value: tag(b, 'value'), year: tag(b, 'year') };
  return {
    id: String(id),
    title: unesc(tag(ab, 'displayName')),
    issn: tag(ab, 'issn'),
    eissn: tag(ab, 'eIssn') || tag(ab, 'eissn'),
    active: tag(ab, 'active') !== 'false',
    coverageStart: tag(ab, 'coverageStartYear'),
    coverageEnd: tag(ab, 'coverageEndYear'),
    publisher: unesc(tag(ab, 'mainPublisherName')),
    openAccess: tag(ab, 'openAccessStatus'),
    sourceType: tag(ab, 'sourceType'),
    snip: metrics.SNIP || null,
    subjects: blocks(ab, 'subjectArea').map(b => tag(b, 'subjectCode'))
  };
}

function parseCiteScore(jsonText, id) {
  const j = JSON.parse(jsonText);
  const x = j.response || '';
  if (!/<ns2:sourceRefPoint /.test(x)) throw new BadPayload('unexpected citescore payload');
  if (tag(x, 'abstractsId') !== String(id)) throw new BadPayload('citescore id mismatch');
  const currentYear = tag(x, 'currentMetricYear');
  const years = blocks(x, 'refPointYearInfo').map(y => {
    const infos = blocks(y, 'refPointInfo');
    const info = infos.find(i => tag(i, 'docType') === 'all') || infos[0] || '';
    return {
      year: tag(y, 'year'),
      status: tag(y, 'status'),
      calculated: tag(y, 'lastCalculatedTimestamp'),
      citeScore: tag(info, 'refPoint'),
      citations: tag(info, 'citationCount'),
      documents: tag(info, 'scholarlyOutput'),
      percentCited: tag(info, 'percentCited'),
      ranks: blocks(info, 'subjectRefPointRank').map(r => ({
        code: tag(r, 'subjectCode'),
        rank: +tag(r, 'rank'),
        total: +tag(r, 'totalSourceCount'),
        percentile: +tag(r, 'percentile')
      })).sort((a, b) => b.percentile - a.percentile)
    };
  });
  return { currentYear, years };
}

function parseSubjects(xml) {
  const map = {};
  const re = /<code>(\d{4})<\/code>\s*<desc>([^<]*)<\/desc>/g; let m;
  while ((m = re.exec(xml))) map[m[1]] = unesc(m[2]);
  const re2 = /<code>(\d{2})<\/code>\s*<desc>([^<]*)<\/desc>/g;
  while ((m = re2.exec(xml))) map[m[1]] = unesc(m[2]);
  return map;
}

async function directText(url, wantJson) {
  const r = await serial('scopus', 500, () => fetch(url, { credentials: 'include', headers: { Accept: wantJson ? 'application/json' : 'text/html' } }));
  const host = new URL(r.url).host;
  if (host !== 'www.scopus.com' || !r.ok) throw new NeedSession('redirect/' + r.status);
  const ct = r.headers.get('content-type') || '';
  if (wantJson && !/json|xml/.test(ct)) throw new NeedSession('not json');
  return r.text();
}

async function subjectMap() {
  const c = await cacheGet('subj', TTL.subj);
  if (c) return c;
  try {
    const map = parseSubjects(await directText(SCOPUS + '/api/rest/subject-area', true));
    if (Object.keys(map).length > 100) { await cacheSet('subj', map); return map; }
  } catch (e) { /* names are cosmetic; codes still shown */ }
  return {};
}

async function scopusDirect(issns) {
  let ids = [];
  for (const s of issns) {
    ids = parseSourceIds(await directText(`${SCOPUS}/sources.uri?field=issn&issn=${s}`, false));
    if (ids.length) break;
  }
  if (!ids.length) return { found: false };
  const id = ids[0];
  const info = await withRetry(async () => parseSourceInfo(await directText(`${SCOPUS}/api/rest/sources/${id}`, true), id));
  const cs = await withRetry(async () => parseCiteScore(await directText(`${SCOPUS}/source/citescore/${id}.uri`, true), id));
  return { found: true, info, cs };
}

async function withRetry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (!(e instanceof BadPayload) || i >= tries) throw e; await sleep(900 * i); }
  }
}

async function scopusViaTab(issns) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  try {
    let ids = [];
    for (const s of issns) {
      await tabGo(tab.id, `${SCOPUS}/sources.uri?field=issn&issn=${s}`);
      let p;
      for (let i = 0; i < 20; i++) {                 // wait out a Cloudflare check if one appears
        p = await tabRun(tab.id, pageText);
        if (p.host === 'www.scopus.com' && /sourceSearchForm/.test(p.html)) break;
        await sleep(700);
      }
      if (p.host !== 'www.scopus.com') throw new LoginRequired(p.href);
      ids = parseSourceIds(p.html);
      if (ids.length) break;
    }
    if (!ids.length) return { found: false };
    const id = ids[0];
    const readJson = async url => {
      await tabGo(tab.id, url);
      for (let i = 0; i < 20; i++) {           // SSO round-trips land back on scopus.com
        const p = await tabRun(tab.id, pageText);
        if (p.host === 'www.scopus.com' && /^\s*\{/.test(p.text)) return p.text;
        if (/id\.elsevier\.com/.test(p.host) && i > 6) throw new LoginRequired(p.href);
        await sleep(700);
      }
      throw new LoginRequired(url);
    };
    const info = await withRetry(async () => parseSourceInfo(await readJson(`${SCOPUS}/api/rest/sources/${id}`), id));
    const cs = await withRetry(async () => parseCiteScore(await readJson(`${SCOPUS}/source/citescore/${id}.uri`), id));
    return { found: true, info, cs };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

let scopusLoginFailAt = 0;
async function scopusLookup(issns, force) {
  issns = [...new Set(issns.map(normIssn).filter(Boolean))].sort();
  if (!issns.length) return { error: 'noissn' };
  const key = 'sc:' + issns.join(',');
  if (!force) { const c = await cacheGet(key, TTL.scopus); if (c) return { ...c, cached: true }; }
  if (Date.now() - scopusLoginFailAt < 120000) return { error: 'login' };
  return once(key, () => scopusFetch(issns, key));
}

async function scopusFetch(issns, key) {
  // Scopus Sources matches only the ISSN it stores (often the print one), so complete the pair first
  if (issns.length < 2) for (const s of [...issns]) {
    try { const j = await crossrefJournal(s); if (j) for (const x of j.issns) if (!issns.includes(x)) issns.push(x); } catch (e) {}
  }
  let res;
  try {
    res = await scopusDirect(issns);
  } catch (e) {
    if (e instanceof BadPayload) return { error: 'fail', detail: 'Scopus returned inconsistent data; try refresh' };
    if (!(e instanceof NeedSession)) throw e;
    try { res = await serial('scopusTab', 0, () => scopusViaTab(issns)); }
    catch (e2) {
      if (e2 instanceof LoginRequired || e2 instanceof NeedSession) { scopusLoginFailAt = Date.now(); return { error: 'login' }; }
      if (e2 instanceof BadPayload) return { error: 'fail', detail: 'Scopus returned inconsistent data; try refresh' };
      throw e2;
    }
  }
  if (res.found) res.subjectNames = await subjectMap();
  res.searched = issns;
  res.fetched = Date.now();
  await cacheSet(key, res);
  return res;
}

// ---------- Clarivate Master Journal List (public search page) ----------
function mjlScrape(issn) {
  const t = document.body ? document.body.innerText : '';
  const m = t.match(/Found (\d+) results?/);
  if (!m) return { ready: false };
  const n = +m[1];
  if (n > 0 && !/ISSN \/ eISSN/.test(t)) return { ready: false };
  if (n === 0 && !/No search results found/i.test(t)) return { ready: false };
  const L = t.split('\n').map(s => s.trim()).filter(Boolean);
  const out = [];
  L.forEach((line, i) => {
    if (line !== 'ISSN / eISSN:') return;
    const near = (label, from, span) => {
      for (let k = from; k < Math.min(L.length, from + span); k++) if (L[k] === label) return L[k + 1] || '';
      return '';
    };
    const pub = L[i - 2] === 'Publisher:' ? L[i - 1] : '';
    const title = L[i - 2] === 'Publisher:' ? L[i - 3] : L[i - 1];
    out.push({
      title,
      publisher: pub,
      issns: L[i + 1] || '',
      core: near('Web of Science Core Collection:', i + 2, 4),
      additional: near('Additional Web of Science Indexes:', i + 2, 6)
    });
  });
  return { ready: true, count: n, results: out };
}

// Two background MJL tabs work in parallel during a batch and close when the queue goes idle
const MJL_SLOTS = 2;
const mjlTabs = new Array(MJL_SLOTS).fill(null);
let mjlNext = 0, mjlBusy = 0, mjlIdle = null;
async function mjlTabId(slot) {
  clearTimeout(mjlIdle);
  if (mjlTabs[slot]) { try { await chrome.tabs.get(mjlTabs[slot]); return mjlTabs[slot]; } catch (e) { mjlTabs[slot] = null; } }
  mjlTabs[slot] = (await chrome.tabs.create({ url: 'about:blank', active: false })).id;
  return mjlTabs[slot];
}
function mjlRelease() {
  clearTimeout(mjlIdle);
  mjlIdle = setTimeout(() => {
    if (mjlBusy) return;
    mjlTabs.forEach((t, i) => { if (t) chrome.tabs.remove(t).catch(() => {}); mjlTabs[i] = null; });
  }, 5000);
}

async function mjlLookup(issns, force) {
  issns = [...new Set(issns.map(normIssn).filter(Boolean))].sort();
  if (!issns.length) return { error: 'noissn' };
  const key = 'mjl:' + issns.join(',');
  if (!force) { const c = await cacheGet(key, TTL.mjl); if (c) return { ...c, cached: true }; }
  const slot = mjlNext++ % MJL_SLOTS;
  return once(key, () => serial('mjl' + slot, 0, async () => {
    mjlBusy++;
    try {
      const tabId = await mjlTabId(slot);
      for (const s of issns) {
        await tabGo(tabId, `https://mjl.clarivate.com/search-results?issn=${s}`);
        let r = { ready: false };
        for (let i = 0; i < 60 && !r.ready; i++) { await sleep(300); r = await tabRun(tabId, mjlScrape, [s]) || { ready: false }; }
        if (!r.ready) return { error: 'timeout' };
        await sleep(400);                                   // confirm the page has settled
        const again = await tabRun(tabId, mjlScrape, [s]);
        if (again && again.ready) r = again;
        const want = issns.map(digits);
        const hit = r.results.find(x => want.some(w => digits(x.issns).includes(w)));
        if (hit) {
          const res = { found: true, ...hit, fetched: Date.now() };
          await cacheSet(key, res);
          return res;
        }
      }
      const res = { found: false, fetched: Date.now() };
      await cacheSet(key, res);
      return res;
    } finally {
      mjlBusy--;
      mjlRelease();
    }
  }));
}

// ---------- Crossref ----------
async function crossref(path) {
  let r = await serial('crossref', 200, () => fetch('https://api.crossref.org' + path, { headers: { Accept: 'application/json' } }));
  if (r.status === 429) { await sleep(3000); r = await serial('crossref', 200, () => fetch('https://api.crossref.org' + path, { headers: { Accept: 'application/json' } })); }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('crossref ' + r.status);
  return (await r.json()).message;
}

async function crossrefWork(doi, force) {
  const key = 'cr:' + doi.toLowerCase();
  if (!force) { const c = await cacheGet(key, TTL.crossref); if (c) return c; }
  const m = await crossref('/works/' + encodeURIComponent(doi));
  if (!m) return { found: false };
  const res = {
    found: true,
    title: (m.title || [])[0] || '',
    journal: (m['container-title'] || [])[0] || '',
    publisher: m.publisher || '',
    type: m.type || '',
    year: ((m.issued || m.published || {})['date-parts'] || [[]])[0][0] || '',
    issns: (m['issn-type'] || []).map(x => ({ value: normIssn(x.value), type: x.type }))
      .concat((m.ISSN || []).map(v => ({ value: normIssn(v), type: '' })))
      .filter((x, i, a) => x.value && a.findIndex(y => y.value === x.value) === i),
    authors: (m.author || []).map(a => ({
      given: a.given || '', family: a.family || a.name || '',
      sequence: a.sequence || '', orcid: a.ORCID || '',
      affiliation: (a.affiliation || []).map(x => x.name).join('; ')
    }))
  };
  await cacheSet(key, res);
  return res;
}

async function crossrefJournalSearch(q) {
  const m = await crossref('/journals?rows=8&query=' + encodeURIComponent(q));
  return (m && m.items || []).map(j => ({
    title: j.title, publisher: j.publisher,
    issns: (j['issn-type'] || []).map(x => normIssn(x.value)).filter(Boolean)
  })).filter(j => j.issns.length);
}

async function crossrefJournal(issn) {
  const m = await crossref('/journals/' + issn);
  if (!m) return null;
  return { title: m.title, publisher: m.publisher, issns: (m['issn-type'] || []).map(x => normIssn(x.value)).filter(Boolean) };
}

// ---------- Google Scholar rows -> DOI (Crossref, strict title match) ----------
const normTitle = s => String(s || '').replace(/&amp;/gi, '&').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/<[^>]+>/g, ' ')
  .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ').trim();

function similarity(a, b) {                       // 1 - normalized Levenshtein distance
  if (a === b) return 1;
  const n = a.length, m = b.length;
  if (!n || !m) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[m] / Math.max(n, m);
}
const yearOf = it => (((it.issued || it.published || {})['date-parts'] || [[]])[0] || [])[0] || 0;

async function resolvePaper({ title, year, owner, prefix, force }) {
  const nt = normTitle(title);
  if (nt.length < 8) return { matched: false };
  const key = 'rp:' + nt.slice(0, 200);
  if (!force) {
    const c = await cacheGet(key, TTL.paper); if (c) return c;
    const miss = await cacheGet('rpx:' + nt.slice(0, 200), TTL.miss); if (miss) return miss;
  }
  const q = '/works?rows=5&select=DOI,title,container-title,ISSN,issn-type,author,type,issued,published,event'
    + '&query.bibliographic=' + encodeURIComponent(title.replace(/&/g, ' ')) +(owner ? '&query.author=' + encodeURIComponent(owner) : '');
  const m = await crossref(q);
  let best = null;
  for (const it of (m && m.items) || []) {
    const t = normTitle((it.title || [])[0]);
    const same = t === nt || (Math.min(t.length, nt.length) > 40 && similarity(t, nt) >= 0.95)
      || (prefix && nt.length >= 40 && t.startsWith(nt));      // Scholar cut the title with "…"
    if (!same) continue;
    const y = yearOf(it);
    if (year && y && Math.abs(+year - y) > 2) continue;
    best = it; break;
  }
  if (!best) { const miss = { matched: false }; await cacheSet('rpx:' + nt.slice(0, 200), miss); return miss; }  // short-lived: Crossref may index it later
  const res = {
    matched: true,
    doi: best.DOI,
    type: best.type || '',
    journal: (best['container-title'] || [])[0] || '',
    year: yearOf(best),
    issns: [...new Set((best['issn-type'] || []).map(x => normIssn(x.value)).concat((best.ISSN || []).map(normIssn)).filter(Boolean))],
    authors: (best.author || []).map(a => ({ given: a.given || '', family: a.family || a.name || '' })),
    eventName: (best.event && best.event.name) || '',
    eventAcronym: (best.event && best.event.acronym) || ''
  };
  await cacheSet(key, res);
  return res;
}

async function journalByName(name) {
  const want = normTitle(name);
  if (want.length < 3) return null;
  const key = 'jn:' + want;
  const c = await cacheGet(key, TTL.paper); if (c) return c;
  const items = await crossrefJournalSearch(name.replace(/&(amp;)?/gi, ' '));   // "&" in the query returns nothing
  const hits = items.filter(j => normTitle(j.title) === want);
  const res = hits.length === 1 ? hits[0] : null;       // ambiguous or fuzzy names are not guessed
  if (res) await cacheSet(key, res);
  return res;
}

// ---------- CORE conference ranking (portal.core.edu.au, official ICORE/CORE lists) ----------
const CORE_STOP = new Set(['the', 'of', 'on', 'and', 'in', 'for', 'a', 'an', 'to', 'with', 'at', 'proceedings', 'annual', 'ieee', 'acm', 'cvf', 'ifip', 'usenix', 'th', 'st', 'nd', 'rd',
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']);
const coreWords = s => normTitle(String(s || '').replace(/\([^)]*\)/g, ' ').replace(/\/+/g, ' '))
  .split(' ').filter(w => w && !CORE_STOP.has(w) && !/^\d+(st|nd|rd|th)?$/.test(w));
const coverage = (a, b) => { const B = new Set(b); return a.length ? a.filter(w => B.has(w)).length / a.length : 0; };

function acronymOf(name) {
  const all = [...String(name || '').matchAll(/\(([A-Z][A-Za-z0-9&+\-]{1,15})(?:['’]?\s?\d{2,4})?\)/g)];
  return all.length ? all[all.length - 1][1] : '';
}

async function coreSearch(q, by) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const url = `https://portal.core.edu.au/conf-ranks/?search=${encodeURIComponent(q)}&by=${by}&source=all&sort=arank&page=${page}`;
    const r = await serial('core', 300, () => fetch(url));
    if (!r.ok) throw new Error('core ' + r.status);
    const html = await r.text();
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map(c => unesc(c[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())).filter(c => c.length >= 4);
    for (const c of rows) out.push({ title: c[0], acronym: c[1], source: c[2], rank: c[3] });
    if (rows.length < 50) break;
  }
  return out;
}

async function coreLookup({ name, acronym, force }) {
  acronym = (acronym || acronymOf(name) || '').trim();
  const venue = coreWords(name);
  if (!acronym && venue.length < 2) return { found: false };
  const key = 'core:' + acronym.toUpperCase() + '|' + venue.join(' ').slice(0, 150);
  if (!force) { const c = await cacheGet(key, TTL.paper); if (c) return c; }
  let pick = null;
  if (acronym) {
    const rows = (await coreSearch(acronym, 'acronym')).filter(r => r.acronym.toUpperCase() === acronym.toUpperCase());
    // the acronym must match exactly and the CORE title words must appear in the venue name
    const good = rows.filter(r => !venue.length || coverage(coreWords(r.title), venue) >= 0.6);
    if (good.length === 1) pick = good[0];
  }
  if (!pick && venue.length >= 3) {
    const q = venue.slice(0, 8).join(' ');
    const rows = await coreSearch(q, 'title');
    const good = rows.filter(r => { const t = coreWords(r.title); return coverage(t, venue) >= 0.9 && coverage(venue, t) >= 0.75; });
    if (good.length === 1) pick = good[0];
  }
  const res = pick ? { found: true, ...pick } : { found: false };
  await cacheSet(key, res);
  return res;
}

// ---------- JCR (user-imported Clarivate export) ----------
async function jcrLookup(issns) {
  const { jcrMeta } = await chrome.storage.local.get('jcrMeta');
  if (!jcrMeta) return { imported: false };
  const want = issns.map(normIssn).filter(Boolean);
  const keys = want.map(s => 'jcr:' + s);
  const got = await chrome.storage.local.get(keys);
  const rows = [];
  for (const k of keys) for (const r of got[k] || []) if (!rows.some(x => x.category === r.category && x.edition === r.edition)) rows.push(r);
  return { imported: true, meta: jcrMeta, rows };
}

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg.type) {
      case 'crossrefWork': return crossrefWork(msg.doi, msg.force);
      case 'journalSearch': return crossrefJournalSearch(msg.q);
      case 'journalByIssn': return crossrefJournal(normIssn(msg.issn));
      case 'scopus': return scopusLookup(msg.issns, msg.force);
      case 'mjl': return mjlLookup(msg.issns, msg.force);
      case 'jcr': return jcrLookup(msg.issns);
      case 'resolvePaper': return resolvePaper(msg);
      case 'journalByName': return journalByName(msg.name);
      case 'core': return coreLookup(msg);
      default: return { error: 'unknown' };
    }
  })().then(reply, e => reply({ error: 'fail', detail: String(e && e.message || e) }));
  return true;
});
