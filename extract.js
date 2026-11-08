// Injected into the article tab. Reads only standard bibliographic metadata
// (Highwire/Dublin Core/PRISM meta tags) and author markers already on the page.
(() => {
  const metas = [...document.querySelectorAll('meta')].map(m => ({
    k: (m.getAttribute('name') || m.getAttribute('property') || '').toLowerCase().trim(),
    v: (m.getAttribute('content') || '').trim()
  })).filter(m => m.k && m.v);
  const first = (...keys) => {
    for (const k of keys) { const m = metas.find(x => x.k === k); if (m) return m.v; }
    return '';
  };
  const all = (...keys) => metas.filter(x => keys.includes(x.k)).map(x => x.v);

  const doiRe = /\b(10\.\d{4,9}\/[^\s"'<>]+)/;
  const cleanDoi = s => {
    const m = (s || '').replace(/^doi:\s*/i, '').match(doiRe);
    return m ? m[1].replace(/[.,;)\]]+$/, '') : '';
  };

  let doi = cleanDoi(first('citation_doi', 'prism.doi', 'bepress_citation_doi', 'dc.identifier.doi'));
  if (!doi) for (const v of all('dc.identifier', 'dc.identifier.uri', 'citation_doi')) { doi = cleanDoi(v); if (doi) break; }
  if (!doi) {
    // IEEE Xplore keeps the record in an inline script
    for (const s of document.querySelectorAll('script:not([src])')) {
      const m = s.textContent.match(/"doi"\s*:\s*"(10\.\d{4,9}\/[^"]+)"/);
      if (m) { doi = m[1]; break; }
    }
  }
  if (!doi) doi = cleanDoi(decodeURIComponent(location.pathname));

  const issns = [...new Set(all('citation_issn', 'citation_eissn', 'prism.issn', 'prism.eissn', 'dc.source.issn')
    .flatMap(v => v.split(/[,;\s]+/))
    .map(v => v.toUpperCase().replace(/[^0-9X]/g, ''))
    .filter(v => v.length === 8)
    .map(v => v.slice(0, 4) + '-' + v.slice(4)))];

  // Authors in the order the publisher lists them
  const authors = [];
  for (const m of metas) {
    if (m.k === 'citation_author') authors.push({ name: m.v, email: '', affiliation: '' });
    else if (m.k === 'citation_author_email' && authors.length) authors[authors.length - 1].email = m.v;
    else if (m.k === 'citation_author_institution' && authors.length && !authors[authors.length - 1].affiliation)
      authors[authors.length - 1].affiliation = m.v;
  }
  if (!authors.length) for (const v of all('dc.creator', 'dc.contributor')) authors.push({ name: v, email: '', affiliation: '' });

  // Text found next to "corresponding author" markers (ScienceDirect, Springer, Wiley, T&F, MDPI ...)
  const markerTexts = [];
  const pushText = el => {
    for (let i = 0, e = el; i < 4 && e; i++, e = e.parentElement) {
      const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 3 && t.length < 400) { markerTexts.push(t); return; }
    }
  };
  document.querySelectorAll('[data-corresp-id], [title*="orrespond" i], [aria-label*="orrespond" i], [alt*="orrespond" i], svg title')
    .forEach(el => {
      if (el.tagName.toLowerCase() === 'title' && !/correspond/i.test(el.textContent)) return;
      pushText(el.tagName.toLowerCase() === 'title' ? el.parentElement : el);
    });
  // "*" next to a name counts only when the page itself defines "*" as the corresponding author (MDPI, Hindawi ...)
  if (/\*\s*(author to whom correspondence|corresponding author|correspondence:)/i.test(document.body ? document.body.innerText : '')) {
    for (const s of document.querySelectorAll('sup')) {
      const t = s.textContent.trim();
      if (t.length < 15 && t.includes('*')) pushText(s.parentElement);
    }
  }
  for (const el of document.querySelectorAll('span, sup, div, p, li, a, strong, em')) {
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim();
    if (own && own.length < 40 && /^\(?corresponding author\)?[.:]?$/i.test(own)) pushText(el.parentElement || el);
  }

  return {
    url: location.href,
    pageTitle: first('citation_title', 'dc.title', 'og:title') || document.title,
    doi,
    issns,
    journal: first('citation_journal_title', 'prism.publicationname', 'citation_conference_title'),
    publisher: first('citation_publisher', 'dc.publisher'),
    authors,
    markerTexts: [...new Set(markerTexts)].slice(0, 40)
  };
})();
