const $ = s => document.querySelector(s);
const send = msg => chrome.runtime.sendMessage(msg);
const { esc, normIssn, fmtDate, quartile, ordinal, fold, nameMatches, splitName } = MZ;
const loading = txt => `<div class="loading"><span class="spin"></span>${esc(txt)}</div>`;

let state = { force: false, page: null };

function show(id, html) { const el = $(id); el.hidden = false; el.querySelector('.body').innerHTML = html; }

// ---------------- rendering ----------------
function renderJournal(title, sub) {
  $('#journal').hidden = false;
  $('#jtitle').textContent = title || '';
  $('#jsub').textContent = sub || '';
}

function renderScopus(r) {
  if (r.error === 'login') return show('#c-scopus', `<span class="badge warn">Could not open a Scopus session</span>
    <p>Open <a href="https://www.scopus.com/sources.uri" target="_blank">scopus.com</a> once in this browser (free Scopus Preview or your institutional login is enough), then try again.</p>`);
  if (r.error === 'noissn') return show('#c-scopus', `<span class="badge warn">No ISSN found for this page</span>`);
  if (r.error) return show('#c-scopus', `<span class="badge warn">Scopus request failed</span> <small class="num">${esc(r.detail || '')}</small>`);
  if (!r.found) return show('#c-scopus', `<span class="badge no">Not indexed in Scopus</span>
    <div class="src">Scopus Sources returned no title for ISSN <span class="num">${esc((r.searched || []).join(' · '))}</span>.
    <a href="https://www.scopus.com/sources.uri" target="_blank">Check manually</a></div>`);

  const info = r.info, names = r.subjectNames || {};
  const cur = r.cs.years.find(y => y.year === r.cs.currentYear && y.status === 'Complete')
           || [...r.cs.years].reverse().find(y => y.status === 'Complete');
  const tracker = r.cs.years.find(y => y.status === 'In-Progress');
  let html = '';
  if (!info.active) html += `<div class="summary" style="background:#fdecec;border-color:#f3b0b0">⚠ Inactive / discontinued in Scopus — last coverage year: <span class="num">${esc(info.coverageEnd)}</span></div>`;
  if (cur && cur.ranks.length) {
    const best = cur.ranks[0];
    const q = quartile(best.percentile);
    html += `<div class="hero">
      <div class="qtile ${q}"><div class="v">${q}</div><div class="l">Best quartile ${esc(cur.year)}</div></div>
      <div class="metric"><div class="v">${esc(cur.citeScore)}</div><div class="l">CiteScore ${esc(cur.year)}</div></div>
      <div class="metric"><div class="v">${esc(best.percentile)}<small>th</small></div><div class="l">Highest percentile</div></div>
    </div>
    <table class="ranks"><tr><th>Category</th><th>Rank</th><th>Percentile</th><th>Quartile</th></tr>
    ${cur.ranks.map(k => {
      const qq = quartile(k.percentile);
      return `<tr><td class="cat">${esc(names[k.code] || k.code)}</td><td class="num">#${k.rank}/${k.total}</td><td class="num">${k.percentile}</td><td><span class="chip ${qq}">${qq}</span></td></tr>`;
    }).join('')}</table>`;
  } else if (cur) {
    html += `<div class="hero"><div class="metric"><div class="v">${esc(cur.citeScore || '—')}</div><div class="l">CiteScore ${esc(cur.year)}</div></div></div>
      <span class="badge warn">No category rank for this year</span>`;
  } else {
    html += `<span class="badge warn">Indexed in Scopus but no official CiteScore yet</span>`;
  }
  html += `<div class="kv">
    ${tracker ? `<div class="k">CiteScoreTracker ${esc(tracker.year)}</div><div class="v">${esc(tracker.citeScore)} <small>(updated monthly — not official)</small></div>` : ''}
    ${info.snip ? `<div class="k">SNIP ${esc(info.snip.year)}</div><div class="v">${esc(info.snip.value)}</div>` : ''}
    <div class="k">Publisher</div><div class="v">${esc(info.publisher)}</div>
    <div class="k">Scopus coverage</div><div class="v">${esc(info.coverageStart)}–${esc(info.coverageEnd)}</div>
    <div class="k">Open access</div><div class="v">${info.openAccess === 'NO' ? 'No' : esc(info.openAccess || '—')}</div>
  </div>
  <div class="src">Source: Scopus (Elsevier)${cur ? ` — CiteScore calculated ${fmtDate(cur.calculated)}` : ''}${r.cached ? ' — cached' : ''} ·
    <a href="https://www.scopus.com/sourceid/${esc(info.id)}" target="_blank">Open in Scopus</a></div>`;
  show('#c-scopus', html);
}

function renderWos(r, issn) {
  const link = `https://mjl.clarivate.com/search-results?issn=${encodeURIComponent(issn || '')}`;
  if (r.error === 'noissn') return show('#c-wos', `<span class="badge warn">No ISSN</span>`);
  if (r.error) return show('#c-wos', `<span class="badge warn">Could not read the Master Journal List</span> <a href="${link}" target="_blank">Open it manually</a>`);
  if (!r.found) return show('#c-wos', `<span class="badge no">Not in Web of Science Core Collection</span>
    <div class="src">Not in SCIE / SSCI / AHCI / ESCI according to the Master Journal List, so it has no official Impact Factor.
    <a href="${link}" target="_blank">Check in MJL</a></div>`);
  const abbr = MZ.wosAbbr(r.core).join(' + ');
  show('#c-wos', `<span class="badge ok">Web of Science Core Collection${abbr ? ' — ' + abbr : ''}</span>
    <div class="index-big">${esc(r.core || '')}</div>
    <div class="kv">
      <div class="k">Title in WoS</div><div class="v">${esc(r.title)}</div>
      <div class="k">ISSN / eISSN</div><div class="v">${esc(r.issns)}</div>
      ${r.additional ? `<div class="k">Other indexes</div><div class="v">${esc(r.additional)}</div>` : ''}
    </div>
    <div class="src">Source: Clarivate Master Journal List${r.cached ? ' — cached' : ''} · <a href="${link}" target="_blank">Open in MJL</a></div>`);
}

function renderJcr(r, inWos) {
  const jcrLink = 'https://jcr.clarivate.com/jcr/home';
  if (!r.imported) return show('#c-jcr', `<span class="badge info">No JCR file imported yet</span>
    <p>The Impact Factor belongs to Clarivate and has no free official source, so JournalLens shows it only from the official JCR export (CSV).
    <a href="#" class="btn" id="goimport">Import JCR file</a></p>
    <div class="src"><a href="${jcrLink}" target="_blank">Open JCR</a></div>`);
  const m = r.meta;
  if (!r.rows.length) return show('#c-jcr', `<span class="badge ${inWos === false ? 'no' : 'warn'}">Not in the imported JCR ${esc(m.year || '')} file</span>
    <div class="src">${inWos === false ? 'Consistent with it not being in WoS Core Collection.' : `The file holds <span class="num">${m.journals}</span> journals; if it covers selected categories only, this journal may be outside it.`}
    · <a href="${jcrLink}" target="_blank">Check in JCR</a></div>`);
  const jif = r.rows[0].jif;
  const best = r.rows.map(x => x.quartile).filter(q => /^Q[1-4]$/.test(q)).sort()[0] || '';
  show('#c-jcr', `<div class="hero">
      ${best ? `<div class="qtile ${best}"><div class="v">${best}</div><div class="l">Best JIF quartile</div></div>` : ''}
      <div class="metric"><div class="v">${esc(jif || '—')}</div><div class="l">Impact Factor ${esc(m.year || '')}</div></div>
      ${r.rows[0].jif5 ? `<div class="metric"><div class="v">${esc(r.rows[0].jif5)}</div><div class="l">5-Year JIF</div></div>` : ''}
    </div>
    <table class="ranks"><tr><th>Category</th><th>Edition</th><th>Rank</th><th>Quartile</th></tr>
    ${r.rows.map(x => `<tr><td class="cat">${esc(x.category)}</td><td class="num">${esc(x.edition)}</td><td class="num">${esc(x.rank || '—')}</td><td>${/^Q[1-4]$/.test(x.quartile) ? `<span class="chip ${x.quartile}">${x.quartile}</span>` : esc(x.quartile || '—')}</td></tr>`).join('')}
    </table>
    <div class="src">Source: official JCR file (${esc(m.fileName)}) — imported ${fmtDate(m.importedAt)} · <a href="${jcrLink}" target="_blank">Open JCR</a></div>`);
}

function renderAuthors(cr, page, myNames) {
  let list = [], src = '';
  if (cr && cr.found && cr.authors.length) {
    list = cr.authors.map(a => ({ ...a })); src = 'Crossref (publisher deposit)';
  } else if (page && page.authors.length) {
    list = page.authors.map(a => ({ ...splitName(a.name), affiliation: a.affiliation, orcid: '' })); src = 'page metadata (citation_author)';
  }
  if (!list.length) return show('#c-auth', `<span class="badge warn">No author list on this page</span>
    <div class="src">Open the article page itself (the DOI landing page) to see the author order.</div>`);

  // corresponding author(s): page e-mail meta (only when not every author has one) + page markers
  const corr = new Set();
  if (page) {
    const withMail = page.authors.filter(a => a.email);
    if (withMail.length && withMail.length < page.authors.length) {
      for (const a of withMail) { const s = splitName(a.name); list.forEach((x, i) => { if (nameMatches(x, `${s.given} ${s.family}`)) corr.add(i); }); }
    }
    for (const t of page.markerTexts || []) {
      const ft = ' ' + fold(t) + ' ';
      const hits = list.map((x, i) => ({ i, f: fold(x.family) })).filter(o => o.f && ft.includes(' ' + o.f + ' '));
      if (hits.length === 1) corr.add(hits[0].i);
    }
  }
  const mine = list.map((x, i) => myNames.some(v => nameMatches(x, v)) ? i : -1).filter(i => i >= 0);
  const n = list.length;

  let html = '';
  if (mine.length === 1) {
    const i = mine[0];
    const roles = [];
    if (i === 0) roles.push('first author');
    if (i === n - 1 && n > 1) roles.push('last author');
    if (corr.has(i)) roles.push('corresponding author');
    html += `<div class="summary">You are the ${ordinal(i + 1)} of <span class="num">${n}</span> authors${roles.length ? ' — ' + roles.join(' + ') : ''}</div>`;
  }
  html += `<ul class="authors">${list.map((a, i) => {
    const tags = [];
    if (i === 0) tags.push('<span class="t first">First author</span>');
    if (i === n - 1 && n > 1) tags.push('<span class="t last">Last author</span>');
    if (corr.has(i)) tags.push('<span class="t corr">✉ Corresponding</span>');
    if (mine.includes(i)) tags.push('<span class="t me">You</span>');
    return `<li class="${mine.includes(i) ? 'me' : ''}"><div class="n">${i + 1}</div><div class="who">
      <div class="nm">${esc(`${a.given} ${a.family}`.trim())}${a.orcid ? ` <a href="${esc(a.orcid)}" target="_blank" title="ORCID">iD</a>` : ''}</div>
      ${a.affiliation ? `<div class="aff">${esc(a.affiliation)}</div>` : ''}
      ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}</div></li>`;
  }).join('')}</ul>
  <div class="src">Order from: ${src}.
  ${corr.size ? 'Corresponding author taken from the publisher page markers.' : 'The publisher page does not mark a corresponding author in a readable way — JournalLens does not guess.'}
  ${myNames.length ? '' : ' Add your name in Settings to see your position automatically.'}</div>`;
  show('#c-auth', html);
}

// ---------------- flow ----------------
async function runJournal(issns, label) {
  issns = [...new Set(issns.map(normIssn).filter(Boolean))];
  if (!issns.length) { $('#empty').hidden = false; $('#empty').textContent = 'No ISSN found. Search by journal name or ISSN above.'; return; }
  if (label) renderJournal(label.title, label.sub || 'ISSN ' + issns.join(' · '));
  show('#c-scopus', loading('Reading Scopus…'));
  show('#c-wos', loading('Reading the Master Journal List…'));
  show('#c-jcr', loading('Searching the JCR file…'));
  const f = state.force;
  let inWos;
  const pW = send({ type: 'mjl', issns, force: f }).then(r => { inWos = r && r.found === true ? true : r && r.found === false ? false : undefined; renderWos(r || {}, issns[0]); return r; });
  send({ type: 'scopus', issns, force: f }).then(r => {
    renderScopus(r || {});
    if (r && r.found && !label) renderJournal(r.info.title, `${r.info.publisher} · ISSN ${issns.join(' · ')}`);
  });
  const jr = await send({ type: 'jcr', issns });
  await pW.catch(() => {});
  renderJcr(jr || { imported: false }, inWos);
  const g = $('#goimport'); if (g) g.onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
}

async function fromPage() {
  const { myNames = [] } = await chrome.storage.sync.get('myNames');
  let page = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extract.js'] });
    page = res && res.result;
  } catch (e) { page = null; }
  state.page = page;
  if (!page || (!page.doi && !page.issns.length && !page.journal)) {
    $('#empty').hidden = false;
    $('#empty').textContent = 'This is not an article page. Search for a journal by name, ISSN or DOI above.';
    return;
  }
  let cr = null;
  if (page.doi) {
    show('#c-auth', loading('Reading authors from Crossref…'));
    cr = await send({ type: 'crossrefWork', doi: page.doi, force: state.force }).catch(() => null);
  }
  const issns = [...page.issns, ...((cr && cr.issns) || []).map(x => x.value)];
  const title = (cr && cr.journal) || page.journal;
  renderJournal(title, `${(cr && cr.publisher) || page.publisher || ''}${page.doi ? ' · DOI ' + page.doi : ''}`);
  if (page.authors.length || (cr && cr.found)) renderAuthors(cr, page, myNames);
  else $('#c-auth').hidden = true;
  if (issns.length) return runJournal(issns, { title, sub: `ISSN ${[...new Set(issns.map(normIssn))].join(' · ')}` });
  if (title) return searchTitle(title, true);
}

async function searchTitle(q, auto) {
  const items = await send({ type: 'journalSearch', q }).catch(() => []);
  const exact = (items || []).filter(j => j.title.toLowerCase().trim() === q.toLowerCase().trim());
  if (auto && exact.length === 1) return runJournal(exact[0].issns, { title: exact[0].title, sub: `${exact[0].publisher} · ISSN ${exact[0].issns.join(' · ')}` });
  const box = $('#picks');
  if (!items || !items.length) { box.hidden = false; box.innerHTML = '<div class="empty">No Crossref results for this name.</div>'; return; }
  box.hidden = false;
  box.innerHTML = items.map((j, i) => `<button class="pick" data-i="${i}"><b>${esc(j.title)}</b><small>${esc(j.publisher)} · ${esc(j.issns.join(' · '))}</small></button>`).join('');
  box.querySelectorAll('.pick').forEach(b => b.onclick = () => {
    const j = items[+b.dataset.i]; box.hidden = true;
    runJournal(j.issns, { title: j.title, sub: `${j.publisher} · ISSN ${j.issns.join(' · ')}` });
  });
}

function resetView() {
  ['#journal', '#c-scopus', '#c-wos', '#c-jcr', '#c-auth', '#empty', '#picks'].forEach(s => $(s).hidden = true);
}

async function manual(q) {
  resetView();
  q = q.trim();
  const doi = (q.match(/10\.\d{4,9}\/\S+/) || [])[0];
  if (doi) {
    const { myNames = [] } = await chrome.storage.sync.get('myNames');
    show('#c-auth', loading('Reading authors from Crossref…'));
    const cr = await send({ type: 'crossrefWork', doi, force: state.force });
    if (!cr || !cr.found) { $('#c-auth').hidden = true; $('#empty').hidden = false; $('#empty').textContent = 'DOI not found in Crossref.'; return; }
    renderJournal(cr.journal, `${cr.publisher} · DOI ${doi}`);
    renderAuthors(cr, null, myNames);
    return runJournal(cr.issns.map(x => x.value), { title: cr.journal, sub: `${cr.publisher} · ISSN ${cr.issns.map(x => x.value).join(' · ')}` });
  }
  const issn = normIssn(q);
  if (issn && /^\s*\d{4}-?\d{3}[\dXx]\s*$/.test(q)) {
    const j = await send({ type: 'journalByIssn', issn }).catch(() => null);
    const issns = j ? [issn, ...j.issns] : [issn];
    return runJournal(issns, { title: j ? j.title : 'ISSN ' + issn, sub: j ? `${j.publisher} · ISSN ${[...new Set(issns)].join(' · ')}` : '' });
  }
  if (q) return searchTitle(q, false);
}

$('#search').onsubmit = e => { e.preventDefault(); state.force = false; manual($('#q').value); };
$('#opts').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
$('#refresh').onclick = e => {
  e.preventDefault(); state.force = true; resetView();
  const q = $('#q').value.trim();
  q ? manual(q) : fromPage();
};
fromPage();
