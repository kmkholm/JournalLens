const $ = s => document.querySelector(s);
const normIssn = s => { const d = String(s || '').toUpperCase().replace(/[^0-9X]/g, ''); return d.length === 8 ? d.slice(0, 4) + '-' + d.slice(4) : ''; };

// ---------- my names ----------
chrome.storage.sync.get('myNames').then(({ myNames = [] }) => { $('#names').value = myNames.join('\n'); });
$('#saveNames').onclick = async () => {
  const myNames = $('#names').value.split('\n').map(s => s.trim()).filter(Boolean);
  await chrome.storage.sync.set({ myNames });
  $('#status').textContent = `✓ Saved ${myNames.length} variant(s)`;
};

// ---------- CSV ----------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function mapColumns(h) {
  const find = test => h.findIndex(x => test(x.trim()));
  const isJif = x => (/^(\d{4}\s+)?JIF$/i.test(x) || /^Journal Impact Factor$/i.test(x) || /^\d{4}\s+Journal Impact Factor$/i.test(x));
  return {
    title: find(x => /^(journal name|full journal title|journal title|journal)$/i.test(x)),
    abbr: find(x => /abbreviation/i.test(x)),
    issn: find(x => /^issn$/i.test(x)),
    eissn: find(x => /^e-?issn$/i.test(x)),
    category: find(x => /^categor(y|ies)$/i.test(x)),
    edition: find(x => /^edition$/i.test(x)),
    jif: find(isJif),
    jif5: find(x => /5[- ]?year/i.test(x) && /(jif|impact)/i.test(x)),
    quartile: find(x => /jif quartile/i.test(x)),
    rank: find(x => /jif rank/i.test(x))
  };
}

$('#file').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const st = $('#jstatus');
  st.textContent = 'Reading…';
  try {
    const text = (await f.text()).replace(/^﻿/, '');
    const rows = parseCsv(text);
    const hi = rows.findIndex(r => r.some(c => /^issn$/i.test(c.trim())) && r.some(c => /JIF|Impact Factor/i.test(c)));
    if (hi < 0) throw new Error('No header row with ISSN + JIF found. Make sure this is the JCR export file.');
    const h = rows[hi].map(c => c.trim());
    const col = mapColumns(h);
    if (col.jif < 0) throw new Error('No Impact Factor column found in the file.');
    if (col.issn < 0 && col.eissn < 0) throw new Error('No ISSN column found.');
    const pre = rows.slice(0, hi).map(r => r.join(' ')).join(' ');
    const year = ((h[col.jif].match(/(\d{4})/) || pre.match(/JCR Year:?\s*(\d{4})/i) || [])[1]) || '';

    const byIssn = {}; const journals = new Set(); let n = 0;
    for (const r of rows.slice(hi + 1)) {
      if (r.length < 3) continue;
      const get = i => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
      const issns = [normIssn(get(col.issn)), normIssn(get(col.eissn))].filter(Boolean);
      if (!issns.length) continue;
      const rec = {
        title: get(col.title), abbr: get(col.abbr), category: get(col.category), edition: get(col.edition),
        jif: get(col.jif), jif5: get(col.jif5), quartile: get(col.quartile).toUpperCase(), rank: get(col.rank)
      };
      for (const s of issns) (byIssn['jcr:' + s] = byIssn['jcr:' + s] || []).push(rec);
      journals.add(issns[0]); n++;
    }
    if (!n) throw new Error('The file has no journal rows.');

    const old = Object.keys(await chrome.storage.local.get(null)).filter(k => k.startsWith('jcr:'));
    if (old.length) await chrome.storage.local.remove(old);
    await chrome.storage.local.set(byIssn);
    await chrome.storage.local.set({ jcrMeta: { year, fileName: f.name, importedAt: new Date().toISOString(), rows: n, journals: journals.size } });
    st.textContent = `✓ Imported JCR ${year}: ${journals.size} journals (${n} category rows) from ${f.name}`;
  } catch (err) {
    st.textContent = '✗ ' + err.message;
  }
};

$('#clearJcr').onclick = async () => {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter(k => k.startsWith('jcr:') || k === 'jcrMeta');
  await chrome.storage.local.remove(keys);
  $('#jstatus').textContent = '✓ JCR file removed';
};

$('#clearCache').onclick = async () => {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter(k => /^(sc|mjl|cr|rp|rpx|jn|core):|^subj$/.test(k));
  await chrome.storage.local.remove(keys);
  $('#cstatus').textContent = `✓ Cleared ${keys.length} items`;
};

chrome.storage.local.get('jcrMeta').then(({ jcrMeta }) => {
  if (jcrMeta) $('#jstatus').textContent = `Current file: JCR ${jcrMeta.year} — ${jcrMeta.journals} journals — ${jcrMeta.fileName}`;
});

$('#ver').textContent = 'v' + chrome.runtime.getManifest().version;
chrome.storage.sync.get({ scholarAuto: true }).then(({ scholarAuto }) => { $('#auto').checked = scholarAuto; });
$('#auto').onchange = e => chrome.storage.sync.set({ scholarAuto: e.target.checked });
