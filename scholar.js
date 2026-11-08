// JournalLens on Google Scholar.
//   Profile pages (citations?user=...): badge row under every paper + statistics panel for the profile owner.
//   Result pages (search, "Cited by", versions): badge row under every result + a summary bar.
(() => {
  if (document.querySelector('#mz-panel, #mz-bar')) return;
  const { esc, ordinal, nameMatches, splitName, citeScoreYear, bestQuartile, wosAbbr } = MZ;

  const send = msg => new Promise(res => {
    try { chrome.runtime.sendMessage(msg, r => res(chrome.runtime.lastError ? { error: 'fail' } : (r || { error: 'fail' }))); }
    catch (e) { res({ error: 'fail' }); }
  });

  const profileTable = document.querySelector('#gsc_a_b');
  const resultBox = document.querySelector('#gs_res_ccl_mid');
  if (!profileTable && !resultBox) return;
  const MODE = profileTable ? 'profile' : 'results';

  const cleanName = n => String(n || '').split(/[,(|]/)[0]
    .replace(/\b(prof(essor)?|dr|ph\.?\s?d|eng|assoc(iate)?|assistant|asst)\b\.?/gi, ' ').replace(/\s+/g, ' ').trim();
  const userId = new URL(location.href).searchParams.get('user') || 'unknown';
  const profileName = MODE === 'profile' ? ((document.querySelector('#gsc_prf_in') || {}).textContent || '').trim() : '';

  const S = {
    owner: cleanName(profileName), myNames: [], qMode: 'current', force: false, filter: null,
    recs: new Map(), journals: new Map(), queue: [], active: 0, jcrImported: false, loginProblem: false, started: false
  };

  // ---------------- parsing ----------------
  const nb = s => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  function parseProfileRow(tr) {
    const a = tr.querySelector('a.gsc_a_at');
    const grays = tr.querySelectorAll('td.gsc_a_t .gs_gray');
    let venue = '';
    if (grays[1]) { const c = grays[1].cloneNode(true); c.querySelectorAll('.gs_oph').forEach(x => x.remove()); venue = nb(c.textContent); }
    const yEl = tr.querySelector('td.gsc_a_y span') || tr.querySelector('td.gsc_a_y');
    const cEl = tr.querySelector('a.gsc_a_ac');
    return {
      title: a ? nb(a.textContent) : '', authorsTxt: grays[0] ? nb(grays[0].textContent) : '', venue,
      venueTruncated: /…|\.\.\./.test(venue),
      year: parseInt(yEl ? yEl.textContent : '', 10) || 0, cites: parseInt(cEl ? cEl.textContent : '', 10) || 0,
      host: tr.querySelector('td.gsc_a_t')
    };
  }
  function parseResult(div) {
    const rt = div.querySelector('.gs_rt');
    if (!rt) return null;
    const t = rt.cloneNode(true);
    t.querySelectorAll('.gs_ctc, .gs_ctg, .gs_ctg2, .gs_ct1, .gs_ct2, .gs_ctu').forEach(x => x.remove());
    const title = nb(t.textContent).replace(/^\[[A-Z]+\]\s*/g, '');
    const meta = nb((div.querySelector('.gs_a') || {}).textContent || '');
    const parts = meta.split(' - ');
    const authorsTxt = parts[0] || '';
    const vy = parts.length > 2 ? parts.slice(1, -1).join(' - ') : (parts[1] || '');
    const years = vy.match(/\b(19|20)\d{2}\b/g);
    const year = years ? +years[years.length - 1] : 0;
    const venue = nb(vy.replace(/,?\s*\b(19|20)\d{2}\b\s*$/, ''));
    const cited = [...div.querySelectorAll('.gs_fl a')].map(a => a.textContent).find(x => /^Cited by \d+/.test(x));
    return {
      title, titleTruncated: /…$|\.\.\.$/.test(title), authorsTxt, venue,
      venueTruncated: /…|\.\.\./.test(venue) || /^…/.test(vy),
      year, cites: cited ? +cited.replace(/\D/g, '') : 0,
      host: div.querySelector('.gs_ri') || div
    };
  }
  function venueInfo(v) {
    const preprint = /arxiv|biorxiv|medrxiv|ssrn|preprint|research square|techrxiv|researchgate/i.test(v);
    const name = v.split(',')[0].replace(/\s+\d[\d\s()\-–.:]*$/, '').trim();
    return { name, preprint };
  }
  const kindOf = t => t === 'journal-article' ? 'journal' : t === 'proceedings-article' ? 'conf'
    : /book/.test(t || '') ? 'book' : t === 'posted-content' ? 'preprint' : (t ? 'other' : '');
  const KIND = { conf: 'Conference', book: 'Book / chapter', preprint: 'Preprint', other: 'Other type' };

  // ---------------- author position ----------------
  function position(authors, names, truncated) {
    names = names.filter(Boolean);
    if (!names.length || !authors.length) return { k: 0, n: truncated ? 0 : authors.length };
    const hits = authors.map((a, i) => (names.some(v => nameMatches(a, v)) ? i : -1)).filter(i => i >= 0);
    if (hits.length !== 1) return { k: 0, n: truncated ? 0 : authors.length, ambiguous: hits.length > 1 };
    return { k: hits[0] + 1, n: truncated ? 0 : authors.length };
  }
  function scholarAuthors(txt) {
    const truncated = /\.\.\.|…/.test(txt);
    const list = txt.split(',').map(s => s.replace(/\.\.\.|…/g, '').trim()).filter(Boolean).map(splitName);
    return { list, truncated };
  }
  const roleOf = pos => !pos.k ? 'unknown' : pos.n === 1 ? 'sole' : pos.k === 1 ? 'first' : (pos.n && pos.k === pos.n) ? 'last' : 'middle';
  const targetNames = () => MODE === 'profile' ? [S.owner] : S.myNames;

  // ---------------- journal metrics (one lookup per journal) ----------------
  function journalMetrics(issns) {
    const key = [...issns].sort().join(',');
    if (!S.journals.has(key) || S.force) {
      S.journals.set(key, {
        scopus: send({ type: 'scopus', issns, force: S.force }),
        mjl: send({ type: 'mjl', issns, force: S.force }),
        jcr: send({ type: 'jcr', issns })
      });
    }
    return S.journals.get(key);
  }

  // ---------------- per-paper pipeline ----------------
  async function analyze(el) {
    const p = MODE === 'profile' ? parseProfileRow(el) : parseResult(el);
    if (!p || !p.title) return;
    const rec = { el, p, state: 'loading' };
    S.recs.set(el, rec);
    renderRow(rec);
    const v = venueInfo(p.venue);
    const fam = targetNames().filter(Boolean).map(n => splitName(n).family)[0] || '';
    const paper = await send({ type: 'resolvePaper', title: p.title.replace(/\s*(…|\.\.\.)$/, ''), prefix: !!p.titleTruncated, year: p.year, owner: fam, force: S.force });
    rec.paper = paper && paper.matched ? paper : null;
    rec.kind = rec.paper ? kindOf(rec.paper.type) : (v.preprint ? 'preprint' : '');
    let issns = rec.paper ? rec.paper.issns : [];
    if (!rec.paper && !v.preprint && v.name && !p.venueTruncated) {
      const j = await send({ type: 'journalByName', name: v.name });
      if (j && j.issns) { issns = j.issns; rec.byName = j.title; }
    }
    rec.issns = issns;
    computePosition(rec);
    // Conferences: official CORE / ICORE ranking (exact acronym or near-identical title only)
    const confLike = rec.kind === 'conf' || (!rec.paper && /proceedings|conference|symposium|workshop|congress|\bconf\b/i.test(p.venue));
    const orphan = !rec.paper && !issns.length && !v.preprint && v.name && !p.venueTruncated;
    if (confLike || orphan) {
      rec.state = 'metrics'; renderRow(rec);
      const name = (rec.paper && (rec.paper.eventName || rec.paper.journal)) || (p.venueTruncated ? '' : p.venue);
      const core = await send({ type: 'core', name, acronym: rec.paper && rec.paper.eventAcronym, force: S.force });
      if (core && !core.error && (confLike || core.found)) { rec.core = core; if (core.found && !rec.kind) rec.kind = 'conf'; }
    }
    if (issns.length && rec.kind !== 'preprint') {
      const jm = journalMetrics(issns);
      rec.state = 'metrics';
      renderRow(rec); renderStats();
      const [sc, jc] = await Promise.all([jm.scopus, jm.jcr]);
      rec.scopus = sc; rec.jcr = jc;
      if (sc && sc.error === 'login') S.loginProblem = true;
      if (jc && jc.imported) S.jcrImported = true;
      renderRow(rec); renderStats();
      rec.mjl = await jm.mjl;
    }
    rec.state = 'done';
    renderRow(rec); renderStats();
  }

  function computePosition(rec) {
    if (rec.paper && rec.paper.authors.length) {
      rec.pos = position(rec.paper.authors, targetNames(), false); rec.posSrc = 'Crossref';
    } else {
      const { list, truncated } = scholarAuthors(rec.p.authorsTxt);
      rec.pos = position(list, targetNames(), truncated); rec.posSrc = 'Google Scholar';
    }
    rec.nAuthors = rec.paper && rec.paper.authors.length ? rec.paper.authors.length : 0;
    rec.role = roleOf(rec.pos);
  }

  // ---------------- classification ----------------
  function classify(rec) {
    const c = { sq: '', cs: '', csYear: '', csNote: '', wos: '', jif: '', jifQ: '' };
    const sc = rec.scopus;
    if (sc && sc.found) {
      const pubY = rec.p.year || (rec.paper && rec.paper.year);
      let y = S.qMode === 'pub' ? citeScoreYear(sc.cs, pubY) : citeScoreYear(sc.cs);
      if (!y && S.qMode === 'pub') { y = citeScoreYear(sc.cs); c.csNote = '*'; }
      c.sq = bestQuartile(y) || (y ? 'NR' : '');
      c.cs = y ? y.citeScore : ''; c.csYear = y ? y.year : '';
      if (!sc.info.active) c.disc = sc.info.coverageEnd;
    } else if (sc && sc.found === false) c.sq = 'none';
    if (rec.mjl && rec.mjl.found) c.wos = wosAbbr(rec.mjl.core)[0] || 'WoS';
    else if (rec.mjl && rec.mjl.found === false) c.wos = 'none';
    if (rec.jcr && rec.jcr.imported && rec.jcr.rows.length) {
      c.jif = rec.jcr.rows[0].jif;
      c.jifQ = rec.jcr.rows.map(x => x.quartile).filter(q => /^Q[1-4]$/.test(q)).sort()[0] || '';
    }
    if (rec.core) c.core = rec.core.found ? rec.core.rank : 'none';
    return c;
  }
  const coreBucket = c => !c.core ? '' : c.core === 'none' ? 'none' : ['A*', 'A', 'B', 'C'].includes(c.core) ? c.core : 'other';
  const coreCls = r => ({ 'A*': 'mz-cAs', A: 'mz-cA', B: 'mz-cB', C: 'mz-cC' }[r] || 'mz-grey');
  const scopusBucket = (rec, c) => {
    if (rec.state === 'loading' || (rec.issns && rec.issns.length && !rec.scopus)) return 'pending';
    if (rec.kind === 'conf' || rec.kind === 'book') return 'conf';
    if (/^Q[1-4]$/.test(c.sq)) return c.sq;
    if (c.sq === 'NR') return 'nr';
    if (c.sq === 'none') return 'none';
    if (rec.kind === 'preprint') return 'preprint';
    return 'unresolved';
  };

  // ---------------- badge row ----------------
  function renderRow(rec) {
    const host = rec.p.host;
    if (!host) return;
    let box = host.querySelector(':scope > .mz-row');
    if (!box) { box = document.createElement('div'); box.className = 'mz-row'; host.appendChild(box); }
    if (rec.state === 'loading') { box.innerHTML = '<span class="mz-b mz-wait">JournalLens…</span>'; return; }
    const c = classify(rec);
    const out = [];
    if (/^Q[1-4]$/.test(c.sq)) out.push(`<span class="mz-b mz-${c.sq}" title="Scopus best quartile, CiteScore ${esc(c.csYear)}${c.csNote ? ' (no official CiteScore for the publication year yet; latest shown)' : ''}">Scopus ${c.sq}${c.csNote} · CS ${esc(c.cs)}</span>`);
    else if (c.sq === 'NR') out.push(`<span class="mz-b mz-grey">Scopus · CS ${esc(c.cs)} (no rank)</span>`);
    else if (c.sq === 'none') out.push('<span class="mz-b mz-no">Not in Scopus</span>');
    else if (rec.scopus && rec.scopus.error === 'login') out.push('<span class="mz-b mz-grey" title="Open scopus.com once, then refresh">Scopus: open scopus.com</span>');
    else if (rec.issns && rec.issns.length && !rec.scopus) out.push('<span class="mz-b mz-wait">Scopus…</span>');
    if (c.disc) out.push(`<span class="mz-b mz-no" title="Inactive / discontinued in Scopus">Discontinued in Scopus (${esc(c.disc)})</span>`);
    if (c.wos && c.wos !== 'none') out.push(`<span class="mz-b mz-wos">${esc(c.wos)}</span>`);
    else if (c.wos === 'none') out.push('<span class="mz-b mz-no">Not in WoS</span>');
    else if (rec.issns && rec.issns.length && rec.state !== 'done') out.push('<span class="mz-b mz-wait">WoS…</span>');
    if (c.jif) out.push(`<span class="mz-b mz-jif">IF ${esc(c.jif)}${c.jifQ ? ' · ' + c.jifQ : ''}</span>`);
    if (c.core && c.core !== 'none') out.push(`<span class="mz-b ${coreCls(c.core)}" title="CORE ${esc(rec.core.source)}: ${esc(rec.core.title)} (${esc(rec.core.acronym)})">CORE ${esc(c.core)} · ${esc(rec.core.acronym)}</span>`);
    else if (c.core === 'none') out.push('<span class="mz-b mz-grey" title="No exact match in the CORE conference portal (CORE covers computing conferences)">Not in CORE</span>');
    if (rec.kind && KIND[rec.kind]) out.push(`<span class="mz-b mz-grey">${KIND[rec.kind]}</span>`);

    const pos = rec.pos || {};
    const who = MODE === 'profile' ? '' : 'You: ';
    if (pos.k) {
      const lbl = rec.role === 'sole' ? 'Sole author' : rec.role === 'first' ? 'First author' : rec.role === 'last' ? 'Last author' : `${ordinal(pos.k)} author`;
      out.push(`<span class="mz-b mz-pos mz-${rec.role}" title="Author order from ${esc(rec.posSrc)}">${who}${lbl} · ${pos.k}/${pos.n || '?'}</span>`);
    } else if (MODE === 'profile') {
      out.push(`<span class="mz-b mz-grey" title="${pos.ambiguous ? 'More than one author matches the name' : 'Name not found in the available author list'}">Position ?</span>`);
    }
    if (MODE === 'results' && rec.nAuthors) out.push(`<span class="mz-b mz-grey">${rec.nAuthors} author${rec.nAuthors > 1 ? 's' : ''}</span>`);
    if (!rec.paper && !rec.byName && !(rec.core && rec.core.found) && rec.state === 'done' && rec.kind !== 'preprint')
      out.push('<span class="mz-b mz-grey" title="No exact title match in Crossref and no unique journal-name match">Unresolved</span>');
    if (rec.byName) out.push('<span class="mz-b mz-grey" title="Journal identified from its name on Scholar (no matching DOI)">by journal name</span>');
    if (rec.paper) out.push(`<a class="mz-doi" href="https://doi.org/${esc(rec.paper.doi)}" target="_blank" title="${esc(rec.paper.journal)}">DOI</a>`);
    box.innerHTML = out.join('');
    applyFilter(rec);
  }

  // ---------------- UI: profile panel or results bar ----------------
  const ui = document.createElement('div');
  if (MODE === 'profile') {
    ui.id = 'mz-panel';
    ui.innerHTML = `
      <div class="mz-head"><div class="mz-brand"><span class="jl-mark">JL</span> JournalLens <small>${esc(profileName)}</small></div><div class="mz-prog" id="mz-prog"></div></div>
      <div class="mz-sumline"><span id="mz-chips"></span>
        <span class="mz-actions"><button id="mz-all">Load all papers</button><button id="mz-more" class="mz-ghost">Details ▾</button></span></div>
      <div id="mz-alert"></div>
      <div id="mz-details" hidden>
        <div class="mz-ctrl">
          <label>Owner's name on papers: <input id="mz-owner" type="text"></label>
          <label>Quartile by: <select id="mz-mode"><option value="current">Latest official CiteScore</option><option value="pub">Publication year</option></select></label>
          <button id="mz-copy">Copy results</button>
          <button id="mz-refresh" title="Bypass the cache">Refresh</button>
        </div>
        <div id="mz-stats"></div>
        <div class="mz-foot">Sources: Scopus · Clarivate Master Journal List · imported JCR file · CORE · Crossref. Click a number to filter the list.
          Quartiles follow the Scopus definition (Q1 = 75th percentile and above).
          <span class="mz-dev">JournalLens by <b>Dr. Mohammed Tawfik</b> · <a href="https://kmkholm.github.io/" target="_blank">kmkholm.github.io</a> · <a href="mailto:kmkhol01@gmail.com">kmkhol01@gmail.com</a></span></div>
      </div>`;
    const anchor = document.querySelector('#gsc_a_tw') || document.querySelector('#gsc_a_t');
    anchor.parentNode.insertBefore(ui, anchor);
  } else {
    ui.id = 'mz-bar';
    ui.innerHTML = `<span class="mz-brand"><span class="jl-mark">JL</span> JournalLens</span><span id="mz-prog"></span><span id="mz-sum"></span>
      <select id="mz-mode" title="Quartile by"><option value="current">Latest CiteScore</option><option value="pub">Publication year</option></select>
      <button id="mz-refresh" title="Bypass the cache">Refresh</button><span id="mz-alert"></span>`;
    resultBox.parentNode.insertBefore(ui, resultBox);
  }
  const $ = s => ui.querySelector(s);

  $('#mz-mode').addEventListener('change', e => { S.qMode = e.target.value; for (const r of S.recs.values()) renderRow(r); renderStats(); });
  $('#mz-refresh').addEventListener('click', () => {
    S.force = true; S.journals.clear(); S.loginProblem = false;
    const els = [...S.recs.keys()]; S.recs.clear(); els.forEach(enqueue);
    setTimeout(() => { S.force = false; }, 1500);
  });
  if (MODE === 'profile') {
    chrome.storage.local.get('owner:' + userId).then(o => {
      if (o['owner:' + userId]) S.owner = o['owner:' + userId];
      $('#mz-owner').value = S.owner;
    });
    $('#mz-owner').addEventListener('change', e => {
      S.owner = e.target.value.trim();
      chrome.storage.local.set({ ['owner:' + userId]: S.owner });
      for (const rec of S.recs.values()) if (rec.state !== 'loading') { computePosition(rec); renderRow(rec); }
      renderStats();
    });
    $('#mz-all').addEventListener('click', loadAll);
    const setDetails = open => { $('#mz-details').hidden = !open; $('#mz-more').textContent = open ? 'Details ▴' : 'Details ▾'; };
    chrome.storage.local.get('jlDetailsOpen').then(o => setDetails(!!o.jlDetailsOpen));
    $('#mz-more').addEventListener('click', () => {
      const open = $('#mz-details').hidden; setDetails(open); chrome.storage.local.set({ jlDetailsOpen: open });
    });
    $('#mz-copy').addEventListener('click', copyResults);
  }

  // ---------------- statistics ----------------
  function renderStats() {
    const recs = [...S.recs.values()];
    const total = recs.length;
    const done = recs.filter(r => r.state === 'done').length;
    $('#mz-prog').textContent = total ? (done < total ? `Analysing ${done}/${total}` : `${total} analysed`) : '';
    const warn = S.loginProblem ? 'Could not open a Scopus session — open <a href="https://www.scopus.com/sources.uri" target="_blank">scopus.com</a> once in this browser, then press Refresh.' : '';
    const cl = new Map(recs.map(r => [r, classify(r)]));
    const sb = r => scopusBucket(r, cl.get(r));
    const count = fn => recs.filter(fn).length;

    if (MODE === 'results') {
      $('#mz-alert').innerHTML = warn ? `<span class="mz-warn">${warn}</span>` : '';
      const parts = ['Q1', 'Q2', 'Q3', 'Q4'].map(q => `<span class="mz-b mz-${q}">${q} ${count(r => sb(r) === q)}</span>`);
      parts.push(`<span class="mz-b mz-no">Not in Scopus ${count(r => sb(r) === 'none')}</span>`);
      parts.push(`<span class="mz-b mz-grey">Conf/book ${count(r => sb(r) === 'conf')}</span>`);
      parts.push(`<span class="mz-b mz-wos">WoS ${count(r => cl.get(r).wos && cl.get(r).wos !== 'none')}</span>`);
      parts.push(`<span class="mz-b mz-cAs">CORE A*/A ${count(r => ['A*', 'A'].includes(cl.get(r).core))}</span>`);
      $('#mz-sum').innerHTML = parts.join('');
      return;
    }

    $('#mz-alert').innerHTML = warn ? `<div class="mz-warn">${warn}</div>` : '';
    const cites = fn => recs.filter(fn).reduce((s, r) => s + r.p.cites, 0);
    const pct = n => total ? Math.round(100 * n / total) + '%' : '';
    const tile = (id, label, n, cls, sub) => `<button class="mz-t ${cls}${S.filter === id ? ' mz-on' : ''}" data-f="${id}"><b>${n}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</button>`;

    const scopusTiles = ['Q1', 'Q2', 'Q3', 'Q4']
      .map(q => { const n = count(r => sb(r) === q); return tile('s:' + q, 'Scopus ' + q, n, 'mz-' + q, `${pct(n)} · ${cites(r => sb(r) === q)} cites`); }).join('')
      + tile('s:none', 'Not in Scopus', count(r => sb(r) === 'none'), 'mz-tno')
      + tile('s:conf', 'Conference / book', count(r => sb(r) === 'conf'), 'mz-tgrey')
      + tile('s:preprint', 'Preprints', count(r => sb(r) === 'preprint'), 'mz-tgrey')
      + tile('s:unresolved', 'Unresolved', count(r => sb(r) === 'unresolved' || sb(r) === 'nr'), 'mz-tgrey');
    const wosTiles = ['SCIE', 'SSCI', 'AHCI', 'ESCI'].map(a => tile('w:' + a, a, count(r => cl.get(r).wos === a), 'mz-twos')).join('')
      + tile('w:none', 'Not in WoS', count(r => cl.get(r).wos === 'none'), 'mz-tno');
    const jifTiles = S.jcrImported
      ? ['Q1', 'Q2', 'Q3', 'Q4'].map(q => tile('j:' + q, 'JIF ' + q, count(r => cl.get(r).jifQ === q), 'mz-' + q)).join('')
        + tile('j:none', 'No IF in file', count(r => r.jcr && r.jcr.imported && !r.jcr.rows.length), 'mz-tno')
      : '<div class="mz-note">To show Impact Factors, import the official JCR file in JournalLens settings.</div>';
    const cb = r => coreBucket(cl.get(r));
    const coreTiles = [['A*', 'mz-cAs'], ['A', 'mz-cA'], ['B', 'mz-cB'], ['C', 'mz-cC']]
      .map(([k, cls]) => tile('c:' + k, 'CORE ' + k, count(r => cb(r) === k), cls)).join('')
      + tile('c:other', 'Other CORE rank', count(r => cb(r) === 'other'), 'mz-tgrey')
      + tile('c:none', 'Not in CORE', count(r => cb(r) === 'none'), 'mz-tno');
    const roles = [['first', 'First author'], ['last', 'Last author'], ['sole', 'Sole author'], ['middle', 'Middle'], ['unknown', 'Unknown']];
    const roleTiles = roles.map(([k, l]) => tile('a:' + k, l, count(r => r.role === k && r.state !== 'loading'), 'mz-trole')).join('');
    const q1first = count(r => sb(r) === 'Q1' && r.role === 'first');

    $('#mz-stats').innerHTML = `
      <div class="mz-grp"><h4>Scopus (${S.qMode === 'pub' ? 'quartile in publication year' : 'latest official CiteScore'})</h4><div class="mz-tiles">${scopusTiles}</div></div>
      <div class="mz-grp"><h4>Web of Science</h4><div class="mz-tiles">${wosTiles}</div></div>
      <div class="mz-grp"><h4>Impact Factor (JCR)</h4><div class="mz-tiles">${jifTiles}</div></div>
      <div class="mz-grp"><h4>Conferences (CORE / ICORE ranking)</h4><div class="mz-tiles">${coreTiles}</div></div>
      <div class="mz-grp"><h4>Position of ${esc(S.owner || 'the profile owner')} in the author list</h4><div class="mz-tiles">${roleTiles}</div>
        <div class="mz-note">Scopus Q1 as first author: <b>${q1first}</b> · Papers analysed: <b>${total}</b></div></div>`;
    const chip = (id, label, n, cls) => `<button class="mz-b mz-chip ${cls}${S.filter === id ? ' mz-on' : ''}" data-f="${id}">${label} <b>${n}</b></button>`;
    $('#mz-chips').innerHTML = ['Q1', 'Q2', 'Q3', 'Q4'].map(q => chip('s:' + q, q, count(r => sb(r) === q), 'mz-' + q)).join('')
      + chip('s:none', 'No Scopus', count(r => sb(r) === 'none'), 'mz-no')
      + chip('w:any', 'WoS', count(r => /^(SCIE|SSCI|AHCI|ESCI)$/.test(cl.get(r).wos)), 'mz-wos')
      + chip('c:top', 'CORE A*/A', count(r => ['A*', 'A'].includes(cb(r))), 'mz-cAs')
      + chip('a:first', '1st author', count(r => r.role === 'first'), 'mz-first');
    renderCharts(recs, cl, sb, cb);
    ui.querySelectorAll('#mz-stats .mz-t, #mz-chips .mz-chip').forEach(b => b.onclick = () => {
      S.filter = S.filter === b.dataset.f ? null : b.dataset.f;
      for (const r of S.recs.values()) applyFilter(r);
      renderStats();
    });
  }

  // ---------------- charts (right-hand column, under the co-authors list) ----------------
  const COL = { Q1: '#10b981', Q2: '#f59e0b', Q3: '#f97316', Q4: '#ef4444', none: '#fca5a5', conf: '#7c3aed', other: '#cbd5e1',
    SCIE: '#4338ca', SSCI: '#6366f1', AHCI: '#a5b4fc', ESCI: '#c7d2fe', 'A*': '#047857', A: '#22c55e', B: '#f59e0b', C: '#f97316',
    first: '#22d3ee', last: '#7c3aed', sole: '#4338ca', middle: '#94a3b8', unknown: '#e2e8f0' };
  const W = 260;
  function hbars(items) {
    const max = Math.max(1, ...items.map(i => i.n)), rh = 16;
    return `<svg viewBox="0 0 ${W} ${items.length * rh + 2}" width="100%" role="img">${items.map((it, i) => {
      const w = Math.round((W - 112) * it.n / max), y = i * rh + 1;
      return `<text x="0" y="${y + 11}" font-size="10" fill="#475569">${esc(it.label)}</text>`
        + `<rect x="82" y="${y + 2}" width="${it.n ? Math.max(w, 2) : 0}" height="11" rx="3" fill="${it.color}"/>`
        + `<text x="${86 + w}" y="${y + 11}" font-size="10" font-weight="700" fill="#0f172a">${it.n}</text>`;
    }).join('')}</svg>`;
  }
  // one 100 % bar per dimension: compact replacement for several donuts
  function shareBar(label, items) {
    const tot = items.reduce((s, i) => s + i.n, 0);
    let x = 0, g = '';
    for (const it of items) {
      if (!it.n) continue;
      const w = (W - 4) * it.n / tot;
      g += `<rect x="${x.toFixed(1)}" y="14" width="${w.toFixed(1)}" height="10" fill="${it.color}"><title>${esc(it.label)}: ${it.n}</title></rect>`;
      x += w;
    }
    if (!tot) g = `<rect x="0" y="14" width="${W - 4}" height="10" rx="3" fill="#f1f5f9"/>`;
    const legend = items.filter(i => i.n).map(i => `<tspan fill="${i.color === '#cbd5e1' || i.color === '#e2e8f0' ? '#64748b' : i.color}" font-weight="700">${esc(i.label)} ${i.n}</tspan>`).join('  ');
    return `<svg viewBox="0 0 ${W} 38" width="100%" role="img"><text x="0" y="10" font-size="10.5" font-weight="700" fill="#312e81">${esc(label)}</text>`
      + `<g>${g}</g><text x="0" y="35" font-size="9.5">${legend || '<tspan fill="#94a3b8">—</tspan>'}</text></svg>`;
  }
  function stackedYears(recs, cat) {
    const keys = ['Q1', 'Q2', 'Q3', 'Q4', 'conf', 'other'];
    const by = {};
    for (const r of recs) { const k = cat(r); if (!k || !r.p.year) continue; (by[r.p.year] = by[r.p.year] || {})[k] = (by[r.p.year][k] || 0) + 1; }
    const years = Object.keys(by).map(Number).sort((a, b) => a - b).slice(-12);
    if (!years.length) return '';
    const tot = y => keys.reduce((s, k) => s + (by[y][k] || 0), 0);
    const max = Math.max(1, ...years.map(tot)), base = 70, step = (W - 10) / years.length, bw = Math.min(14, step - 4);
    let g = '';
    years.forEach((y, i) => {
      const x = 6 + i * step;
      let top = base;
      for (const k of keys) {
        const n = by[y][k] || 0; if (!n) continue;
        const h = (base - 10) * n / max; top -= h;
        g += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${COL[k]}"><title>${y} · ${k}: ${n}</title></rect>`;
      }
      g += `<text x="${(x + bw / 2).toFixed(1)}" y="${(top - 2).toFixed(1)}" text-anchor="middle" font-size="8.5" font-weight="700" fill="#0f172a">${tot(y)}</text>`
        + `<text x="${(x + bw / 2).toFixed(1)}" y="${base + 10}" text-anchor="middle" font-size="8.5" fill="#64748b">'${String(y).slice(2)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} 84" width="100%" role="img"><line x1="2" x2="${W - 2}" y1="${base}" y2="${base}" stroke="#e2e8f0"/>${g}</svg>`;
  }

  let chartCard = null, chartTimer = null, chartsOpen = true;
  if (MODE === 'profile') {
    chartCard = document.createElement('div');
    chartCard.id = 'mz-charts';
    const co = document.querySelector('#gsc_rsb_co');
    const rsb = document.querySelector('#gsc_rsb');
    if (co) co.after(chartCard); else if (rsb) rsb.appendChild(chartCard); else ui.appendChild(chartCard);
    chrome.storage.local.get('jlChartsOpen').then(o => { if (o.jlChartsOpen === false) { chartsOpen = false; chartCard.classList.add('mz-closed'); } });
    chartCard.addEventListener('click', e => {
      if (!e.target.closest('.mz-ch-head')) return;
      chartsOpen = !chartsOpen; chartCard.classList.toggle('mz-closed', !chartsOpen);
      chrome.storage.local.set({ jlChartsOpen: chartsOpen });
    });
  }
  function renderCharts(recs, cl, sb, cb) {
    if (!chartCard) return;
    clearTimeout(chartTimer);
    chartTimer = setTimeout(() => {
      const n = f => recs.filter(f).length;
      const yearCat = r => { const b = sb(r); return b === 'pending' ? '' : /^Q[1-4]$/.test(b) ? b : b === 'conf' ? 'conf' : 'other'; };
      const years = stackedYears(recs, yearCat);
      chartCard.innerHTML = `<div class="mz-ch-head"><span class="jl-mark">JL</span> JournalLens <small>${recs.length} papers</small><span class="mz-tog">▾</span></div>
        <div class="mz-ch-body">
        <div class="mz-ch"><h5>Scopus quartiles</h5>${hbars([
          ...['Q1', 'Q2', 'Q3', 'Q4'].map(q => ({ label: q, n: n(r => sb(r) === q), color: COL[q] })),
          { label: 'Not in Scopus', n: n(r => sb(r) === 'none'), color: COL.none },
          { label: 'Conf / book', n: n(r => sb(r) === 'conf'), color: COL.conf }])}</div>
        ${years ? `<div class="mz-ch"><h5>Per year</h5>${years}</div>` : ''}
        <div class="mz-ch">
          ${shareBar('Web of Science', [...['SCIE', 'SSCI', 'ESCI', 'AHCI'].map(a => ({ label: a, n: n(r => cl.get(r).wos === a), color: COL[a] })),
            { label: 'None', n: n(r => cl.get(r).wos === 'none'), color: COL.none }])}
          ${shareBar('CORE conferences', [...['A*', 'A', 'B', 'C'].map(k => ({ label: k, n: n(r => cb(r) === k), color: COL[k] })),
            { label: 'Other', n: n(r => cb(r) === 'other'), color: COL.other }, { label: 'None', n: n(r => cb(r) === 'none'), color: COL.none }])}
          ${shareBar('Author position', [['first', 'First'], ['last', 'Last'], ['sole', 'Sole'], ['middle', 'Middle'], ['unknown', '?']]
            .map(([k, l]) => ({ label: l, n: n(r => r.role === k && r.state !== 'loading'), color: COL[k] })))}
        </div>
        <div class="mz-ch-foot"><a href="https://kmkholm.github.io/" target="_blank">JournalLens · Dr. Mohammed Tawfik</a></div>
        </div>`;
    }, 250);
  }

  function matchesFilter(rec) {
    if (!S.filter) return true;
    const [g, v] = S.filter.split(':');
    const c = classify(rec);
    if (g === 's') { const b = scopusBucket(rec, c); return v === 'unresolved' ? (b === 'unresolved' || b === 'nr') : b === v; }
    if (g === 'w') return v === 'any' ? /^(SCIE|SSCI|AHCI|ESCI)$/.test(c.wos) : c.wos === v;
    if (g === 'j') return v === 'none' ? (rec.jcr && rec.jcr.imported && !rec.jcr.rows.length) : c.jifQ === v;
    if (g === 'a') return rec.role === v;
    if (g === 'c') return v === 'top' ? ['A*', 'A'].includes(coreBucket(c)) : coreBucket(c) === v;
    return true;
  }
  function applyFilter(rec) { if (MODE === 'profile') rec.el.style.display = matchesFilter(rec) ? '' : 'none'; }

  // ---------------- copy as a table (paste into Excel / Word) ----------------
  async function copyResults() {
    const head = ['Title', 'Year', 'Citations', 'Journal', 'ISSN', 'DOI', 'Type', 'Scopus quartile', 'CiteScore', 'CiteScore year', 'WoS index', 'JIF', 'JIF quartile', 'CORE rank', 'CORE source', 'Author position', 'Authors'];
    const lines = [head.join('\t')];
    for (const r of S.recs.values()) {
      const c = classify(r);
      lines.push([r.p.title, r.p.year, r.p.cites, r.paper ? r.paper.journal : (r.byName || r.p.venue), (r.issns || []).join(' '),
        r.paper ? r.paper.doi : '', r.kind || '', /^Q[1-4]$/.test(c.sq) ? c.sq : (c.sq === 'none' ? 'Not in Scopus' : ''), c.cs, c.csYear,
        c.wos === 'none' ? 'Not in WoS' : c.wos, c.jif, c.jifQ, c.core === 'none' ? 'Not in CORE' : (c.core || ''), r.core && r.core.found ? r.core.source : '', r.pos && r.pos.k ? `${r.pos.k}/${r.pos.n || '?'}` : '',
        r.paper ? r.paper.authors.length : ''].map(x => String(x == null ? '' : x).replace(/\t|\n/g, ' ')).join('\t'));
    }
    try { await navigator.clipboard.writeText(lines.join('\n')); $('#mz-copy').textContent = `✓ Copied ${lines.length - 1} papers`; }
    catch (e) { $('#mz-copy').textContent = 'Copy failed'; }
    setTimeout(() => { $('#mz-copy').textContent = 'Copy results'; }, 2500);
  }

  // ---------------- queue + "show more" ----------------
  const items = () => MODE === 'profile' ? [...profileTable.querySelectorAll('tr.gsc_a_tr')] : [...resultBox.querySelectorAll('.gs_r.gs_or, .gs_r.gs_scl')];
  function enqueue(el) { S.started = true; if (!S.recs.has(el) && !S.queue.includes(el)) { S.queue.push(el); pump(); } }
  function pump() {
    while (S.active < 6 && S.queue.length) {
      const el = S.queue.shift();
      S.active++;
      analyze(el).catch(() => {}).finally(() => { S.active--; pump(); });
    }
  }
  async function loadAll() {
    const btn = $('#mz-all');
    btn.disabled = true; btn.textContent = 'Loading all papers…';
    for (let i = 0; i < 100; i++) {
      const more = document.querySelector('#gsc_bpf_more');
      if (!more || more.disabled) break;
      const before = items().length;
      more.click();
      for (let k = 0; k < 40; k++) { await new Promise(r => setTimeout(r, 250)); if (items().length > before) break; }
      if (items().length === before) break;
    }
    items().forEach(enqueue);
    btn.textContent = 'All papers loaded';
  }

  if (MODE === 'profile') new MutationObserver(() => { if (S.started) items().forEach(enqueue); }).observe(profileTable, { childList: true });
  Promise.all([chrome.storage.sync.get({ scholarAuto: true, myNames: [] })]).then(([{ scholarAuto, myNames }]) => {
    S.myNames = myNames || [];
    if (scholarAuto) items().forEach(enqueue);
    else {
      $('#mz-prog').innerHTML = '<button id="mz-start">Analyse this page</button>';
      ui.querySelector('#mz-start').onclick = () => items().forEach(enqueue);
    }
  });
  renderStats();
})();
