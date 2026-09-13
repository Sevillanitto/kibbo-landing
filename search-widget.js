// Kibbo "What's your problem?" search widget — index.html only.
// Pure client-side keyword-overlap matching against /search-index.json.
// No AI, no network calls beyond the one-time index fetch.
(() => {
  const root = document.querySelector('.problem-search');
  if (!root) return;

  const input = root.querySelector('.ps-input');
  const submitBtn = root.querySelector('.ps-submit');
  const tagButtons = Array.from(root.querySelectorAll('.ps-tag'));
  const tagRow = root.querySelector('.ps-tags');
  const resultWrap = root.querySelector('.ps-result');

  let index = null;
  let indexPromise = null;

  function loadIndex() {
    if (!indexPromise) {
      indexPromise = fetch('/search-index.json')
        .then(r => r.json())
        .then(data => { index = data; return data; })
        .catch(err => { console.error('[search-widget] failed to load search-index.json', err); index = []; return []; });
    }
    return indexPromise;
  }
  loadIndex();

  const STOPWORDS = new Set(['a','an','the','is','are','was','were','to','of','in','on','for','and','or',
    'my','me','i','it','this','that','do','does','did','can','will','won','not','t','s','d','ve','re',
    'with','about','if','be','have','has','had','you','your']);

  function normalize(str) {
    return String(str || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function toWords(str) {
    return normalize(str).split(' ').filter(Boolean);
  }

  function scoreEntry(entry, queryNorm, queryWords) {
    let best = 0;
    // Category-level match against the entry's real block slug (e.g. "housing-rentals"
    // -> "housing rentals"), so a bare category word (the quick tags) reliably surfaces
    // the real content in that block rather than falling back to no-match.
    const blockNorm = normalize((entry.block || '').replace(/-/g, ' '));
    if (blockNorm && queryNorm.length > 2 && (blockNorm.includes(queryNorm) || queryNorm.includes(blockNorm))) {
      best = 8;
    }
    for (const kw of entry.keywords || []) {
      const kwNorm = normalize(kw);
      if (!kwNorm) continue;
      let s = 0;
      // Phrase-level containment match — strongest signal.
      if (queryNorm.length > 3 && (kwNorm.includes(queryNorm) || queryNorm.includes(kwNorm))) {
        s += 12;
      }
      // Word-overlap scoring — real words weighted higher than stopwords.
      const kwWords = kwNorm.split(' ').filter(Boolean);
      let overlap = 0;
      for (const w of queryWords) {
        if (w.length < 2) continue;
        if (kwWords.includes(w)) overlap += STOPWORDS.has(w) ? 0.3 : 1;
      }
      s += overlap;
      if (s > best) best = s;
    }
    // Small tie-break bonus for the core tools (Wizard/Rights Checker/Timeline),
    // per the site's design intent — gated on at least one real (non-stopword)
    // word match or better, so a single incidental stopword hit (e.g. "my")
    // can't manufacture a tool match out of near-nothing.
    if (best >= 1 && (entry.type === 'wizard' || entry.type === 'tool')) best += 1.5;
    return best;
  }

  const MIN_SCORE = 1;

  function runSearch(rawQuery) {
    if (!index) return null;
    const queryNorm = normalize(rawQuery);
    const queryWords = toWords(rawQuery);
    if (!queryWords.length) return null;

    const scored = index
      .map(entry => ({ entry, score: scoreEntry(entry, queryNorm, queryWords) }))
      .sort((a, b) => b.score - a.score);

    if (!scored.length || scored[0].score < MIN_SCORE) {
      return { fallback: true };
    }

    const best = scored[0].entry;
    const related = [];
    const seen = new Set([best.url]);
    for (const s of scored.slice(1)) {
      if (related.length >= 3) break;
      if (s.score < 1) continue;
      if (seen.has(s.entry.url)) continue;
      related.push(s.entry);
      seen.add(s.entry.url);
    }
    return { fallback: false, best, related };
  }

  const TYPE_LABEL = { wizard: 'Wizard', tool: 'Tool', question: 'Question', calculator: 'Calculator', guide: 'Guide' };
  const TYPE_CLASS = { question: 'ps-tag-question', guide: 'ps-tag-guide', calculator: 'ps-tag-calculator', wizard: 'ps-tag-tool', tool: 'ps-tag-tool' };

  function typeBadge(type) {
    const cls = TYPE_CLASS[type] || 'ps-tag-tool';
    const label = TYPE_LABEL[type] || 'Tool';
    return `<span class="ps-type-badge ${cls}">${label}</span>`;
  }

  function renderResult(result) {
    if (!result || result.fallback) {
      resultWrap.innerHTML = `
        <div class="ps-fallback">
          <p class="ps-fallback-text">We couldn't find an exact match — try the Wizard for a personalized action plan.</p>
          <a class="ps-best-action" href="/wizard">Start the Wizard →</a>
        </div>`;
    } else {
      const best = result.best;
      const relatedHtml = result.related.map(r => `
        <a class="ps-related-row" href="${r.url}">
          ${typeBadge(r.type)}
          <span class="ps-related-title">${escapeHtml(r.title)}</span>
          <span class="ps-related-go" aria-hidden="true">→</span>
        </a>`).join('');

      resultWrap.innerHTML = `
        <div class="ps-best">
          <div class="ps-best-label">YOUR BEST MATCH</div>
          <div class="ps-best-card">
            ${typeBadge(best.type)}
            <h3 class="ps-best-title">${escapeHtml(best.title)}</h3>
            <p class="ps-best-desc">${escapeHtml(best.description)}</p>
            <a class="ps-best-action" href="${best.url}">Go to ${escapeHtml(best.title)} →</a>
          </div>
        </div>
        ${result.related.length ? `
        <div class="ps-related">
          <div class="ps-related-label">RELATED</div>
          <div class="ps-related-list">${relatedHtml}</div>
        </div>` : ''}`;
    }
    resultWrap.hidden = false;
    tagRow.hidden = true;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function doSearch(query) {
    loadIndex().then(() => {
      const result = runSearch(query);
      renderResult(result);
    });
  }

  function resetToTags() {
    input.value = '';
    resultWrap.hidden = true;
    resultWrap.innerHTML = '';
    tagRow.hidden = false;
  }

  submitBtn.addEventListener('click', () => {
    const q = input.value.trim();
    if (q) doSearch(q);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (q) doSearch(q);
    }
  });
  input.addEventListener('input', () => {
    if (input.value.trim() === '' && resultWrap.hidden === false) {
      resetToTags();
    }
  });

  tagButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.tag;
      input.value = q;
      doSearch(q);
    });
  });
})();
