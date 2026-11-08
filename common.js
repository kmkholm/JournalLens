// Helpers shared by the popup and the Google Scholar content script.
const MZ = (() => {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normIssn = s => { const d = String(s || '').toUpperCase().replace(/[^0-9X]/g, ''); return d.length === 8 ? d.slice(0, 4) + '-' + d.slice(4) : ''; };
  const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-GB'); };

  // Scopus definition: Q1 = 99th-75th percentile, Q2 = 74th-50th, Q3 = 49th-25th, Q4 = 24th-0
  const quartile = p => (p >= 75 ? 'Q1' : p >= 50 ? 'Q2' : p >= 25 ? 'Q3' : 'Q4');
  const ordinal = n => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));

  const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z\u0600-\u06ff\s-]/g, ' ').replace(/\s+/g, ' ').trim();

  // author = {given, family}; variant = "Given Family" or "Family, Given"
  function nameMatches(author, variant) {
    const toks = s => fold(s).replace(/-/g, ' ').split(' ').filter(Boolean);
    if (String(variant).includes(',')) { const [f, g] = String(variant).split(','); variant = `${g || ''} ${f}`; }
    const v = toks(variant);
    const fam = toks(author.family);
    if (!v.length || !fam.length || v.length < fam.length) return false;
    if (v.slice(-fam.length).join(' ') !== fam.join(' ')) return false;
    const vGiven = v.slice(0, v.length - fam.length);
    if (!vGiven.length) return true;
    const given = toks(author.given);
    return given.length > 0 && given[0].charAt(0) === vGiven[0].charAt(0);
  }
  function splitName(n) {
    n = String(n || '').trim();
    if (n.includes(',')) { const [f, g] = n.split(','); return { family: f.trim(), given: (g || '').trim() }; }
    const p = n.split(/\s+/); return { family: p.pop() || '', given: p.join(' ') };
  }

  // Latest complete CiteScore year, or the one for a given publication year
  function citeScoreYear(cs, year) {
    if (!cs || !cs.years) return null;
    if (year) return cs.years.find(y => y.year === String(year) && y.status === 'Complete') || null;
    return cs.years.find(y => y.year === cs.currentYear && y.status === 'Complete')
      || [...cs.years].reverse().find(y => y.status === 'Complete') || null;
  }
  const bestQuartile = y => (y && y.ranks && y.ranks.length ? quartile(y.ranks[0].percentile) : '');

  const wosAbbr = core => [[/Science Citation Index Expanded/i, 'SCIE'], [/Social Sciences Citation Index/i, 'SSCI'],
    [/Arts & Humanities Citation Index/i, 'AHCI'], [/Emerging Sources Citation Index/i, 'ESCI']]
    .filter(([re]) => re.test(core || '')).map(([, a]) => a);

  return { esc, normIssn, fmtDate, quartile, ordinal, fold, nameMatches, splitName, citeScoreYear, bestQuartile, wosAbbr };
})();
