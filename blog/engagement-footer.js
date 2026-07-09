/* Kibbo blog engagement footer — one drop-in component for every article.
 *
 * Include once per article, just before </body>:
 *   <div id="engagement-footer"></div>
 *   <script src="/blog/engagement-footer.js"></script>
 *
 * Renders two blocks:
 *   1. "Continue protecting yourself" — a static 4-path box + closing box.
 *   2. "Related articles" + "Next recommended article" — computed at runtime by
 *      fetching blog.html and reading the same data-category attributes the
 *      category filter already relies on. No hardcoded article list: publishing
 *      a new article automatically makes it eligible here.
 */
(function () {
  var mount = document.getElementById('engagement-footer');
  if (!mount || mount.dataset.rendered) return;
  mount.dataset.rendered = '1';

  injectStyles();
  mount.innerHTML = block1();

  // ---- Block 2: related + next, computed from blog.html ----
  var article = document.querySelector('article[data-category]');
  var currentCats = article
    ? article
        .getAttribute('data-category')
        .split(',')
        .map(function (s) { return s.trim(); })
        .filter(Boolean)
    : [];
  var currentSlug = slugOf(window.location.pathname);

  fetch('/blog.html', { credentials: 'same-origin' })
    .then(function (r) { return r.text(); })
    .then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var items = [].slice
        .call(doc.querySelectorAll('article.post-item[data-category]'))
        .map(function (a) {
          var link = a.querySelector('h2 a');
          var time = a.querySelector('time');
          if (!link) return null;
          return {
            url: link.getAttribute('href'),
            slug: slugOf(link.getAttribute('href')),
            title: link.textContent.trim(),
            date: time ? time.getAttribute('datetime') || '' : '',
            cats: a
              .getAttribute('data-category')
              .split(',')
              .map(function (s) { return s.trim(); })
              .filter(Boolean),
          };
        })
        .filter(Boolean);
      if (!items.length) return;
      mount.insertAdjacentHTML('beforeend', block2(items, currentCats, currentSlug));
    })
    .catch(function () {
      /* offline / fetch blocked — Block 1 still shows, Block 2 is skipped */
    });

  // ---------------------------------------------------------------------------

  function slugOf(path) {
    return (path || '')
      .split('#')[0]
      .split('?')[0]
      .replace(/\/$/, '')
      .split('/')
      .pop()
      .replace(/\.html$/, '');
  }

  function esc(s) {
    return (s || '').replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function block1() {
    return (
      '<section class="ef-wrap">' +
      '<h2 class="ef-h2">Continue protecting yourself</h2>' +
      '<div class="ef-grid">' +
      efCard(
        'Free Resources',
        'Official complaint portals, government consumer agencies, scam reporting tools.',
        '',
        '/directory.html',
        'Visit the Free Resources Directory'
      ) +
      efCard(
        'Analyze your documents',
        'Paste a contract, suspicious email, or supplement label.',
        efLinks([
          ['/legal-contract-auditor.html', 'AI Contract Analyzer'],
          ['/phishing-detector.html', 'AI Phishing Detector'],
          ['/supplement-analyzer.html', 'Supplement Analyzer'],
        ]),
        '/analyze.html',
        'Try the analyzers'
      ) +
      efCard(
        'Need a ready-made document?',
        'Generate legal letters in minutes.',
        efLinks([
          ['/generate/lost-parcel-demand.html', 'Lost Parcel Legal Demand'],
          ['/generate/landlord-deposit-demand.html', 'Landlord Deposit Demand Letter'],
        ]),
        '/generate.html',
        'Open Generators'
      ) +
      efCard(
        'Prefer templates?',
        'Download checklists and legal document packs.',
        '',
        '/templates.html',
        'Browse Templates'
      ) +
      '</div>' +
      '<div class="ef-close">' +
      '<h3 class="ef-close-h">Still dealing with this problem?</h3>' +
      '<ul class="ef-check">' +
      '<li>Find the official authority</li>' +
      '<li>Analyze your documents with AI</li>' +
      '<li>Download ready-to-use templates</li>' +
      '<li>Generate legal letters</li>' +
      '</ul>' +
      '<p class="ef-free">Everything is free to start.</p>' +
      '</div>' +
      '</section>'
    );
  }

  function efCard(title, desc, linksHtml, ctaHref, ctaText) {
    return (
      '<div class="ef-card">' +
      '<h3 class="ef-card-h">' + esc(title) + '</h3>' +
      '<p class="ef-card-p">' + esc(desc) + '</p>' +
      (linksHtml || '') +
      '<a class="ef-cta" href="' + ctaHref + '">' + esc(ctaText) + ' →</a>' +
      '</div>'
    );
  }

  function efLinks(pairs) {
    return (
      '<div class="ef-sublinks">' +
      pairs
        .map(function (p) {
          return '<a href="' + p[0] + '">' + esc(p[1]) + '</a>';
        })
        .join('') +
      '</div>'
    );
  }

  function block2(items, currentCats, currentSlug) {
    var others = items.filter(function (a) { return a.slug !== currentSlug; });

    // Same-category first (up to 5), then top up to at least 3 with the most
    // recent articles from any category — never duplicating one already shown.
    var sameCat = others.filter(function (a) {
      return a.cats.some(function (c) { return currentCats.indexOf(c) !== -1; });
    });
    var recent = others.slice().sort(function (x, y) {
      return (y.date || '').localeCompare(x.date || '');
    });

    var related = sameCat.slice(0, 5);
    var seen = {};
    related.forEach(function (a) { seen[a.slug] = 1; });
    for (var i = 0; i < recent.length && related.length < 3; i++) {
      if (!seen[recent[i].slug]) {
        related.push(recent[i]);
        seen[recent[i].slug] = 1;
      }
    }

    // Next recommended: the article after this one in publish-date order
    // (newest-first), wrapping to the first when this is the last.
    var ordered = items.slice().sort(function (x, y) {
      return (y.date || '').localeCompare(x.date || '');
    });
    var idx = ordered.findIndex(function (a) { return a.slug === currentSlug; });
    var next = idx === -1 ? ordered[0] : ordered[(idx + 1) % ordered.length];

    var html = '<section class="ef-related">';
    if (related.length) {
      html +=
        '<h2 class="ef-h2">Related articles</h2><div class="ef-rel-row">' +
        related
          .map(function (a) {
            return (
              '<a class="ef-rel-card" href="' + a.url + '">' +
              '<span class="ef-rel-cat">' + esc(a.cats[0] || 'Article') + '</span>' +
              '<span class="ef-rel-title">' + esc(a.title) + '</span>' +
              '</a>'
            );
          })
          .join('') +
        '</div>';
    }
    if (next && next.slug !== currentSlug) {
      html +=
        '<div class="ef-next">' +
        '<span class="ef-next-label">Next recommended article</span>' +
        '<a class="ef-next-card" href="' + next.url + '">' +
        '<span class="ef-next-title">' + esc(next.title) + '</span>' +
        '<span class="ef-next-go">Read next →</span>' +
        '</a>' +
        '</div>';
    }
    html += '</section>';
    return html;
  }

  function injectStyles() {
    if (document.getElementById('ef-styles')) return;
    var css =
      '#engagement-footer{--ef-bg:#F7F5F0;--ef-green:#3D6B4F;--ef-ink:#141210;--ef-muted:#5C5850;--ef-line:#E4E0D8;--ef-serif:"Syne",system-ui,sans-serif;--ef-sans:"Inter",system-ui,sans-serif;max-width:920px;margin:0 auto;padding:16px clamp(20px,4vw,48px) 8px;box-sizing:border-box;}' +
      '#engagement-footer *{box-sizing:border-box;}' +
      '.ef-wrap,.ef-related{margin-top:56px;}' +
      '.ef-h2{font-family:var(--ef-serif);font-weight:600;font-size:clamp(22px,3vw,28px);letter-spacing:-0.02em;color:var(--ef-ink);margin:0 0 22px;}' +
      '.ef-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;}' +
      '.ef-card{display:flex;flex-direction:column;background:#fff;border:1px solid var(--ef-line);border-radius:14px;padding:22px 20px;}' +
      '.ef-card-h{font-family:var(--ef-serif);font-weight:600;font-size:17px;color:var(--ef-ink);margin:0 0 8px;}' +
      '.ef-card-p{font-family:var(--ef-sans);font-size:14px;line-height:1.55;color:var(--ef-muted);margin:0 0 14px;flex:0 0 auto;}' +
      '.ef-sublinks{display:flex;flex-direction:column;gap:6px;margin:0 0 14px;}' +
      '.ef-sublinks a{font-family:var(--ef-sans);font-size:13px;font-weight:500;color:var(--ef-ink);text-decoration:none;border-bottom:1px solid var(--ef-line);padding-bottom:6px;transition:color .15s ease;}' +
      '.ef-sublinks a:hover{color:var(--ef-green);}' +
      '.ef-cta{margin-top:auto;font-family:var(--ef-sans);font-size:14px;font-weight:600;color:var(--ef-green);text-decoration:none;}' +
      '.ef-cta:hover{text-decoration:underline;}' +
      '.ef-close{margin-top:20px;background:var(--ef-green);border-radius:16px;padding:28px clamp(22px,4vw,36px);color:#fff;}' +
      '.ef-close-h{font-family:var(--ef-serif);font-weight:600;font-size:clamp(19px,2.6vw,24px);margin:0 0 16px;color:#fff;}' +
      '.ef-check{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 20px;}' +
      '.ef-check li{font-family:var(--ef-sans);font-size:15px;line-height:1.5;color:#eef3ee;padding-left:26px;position:relative;}' +
      '.ef-check li::before{content:"\\2714";position:absolute;left:0;top:0;color:#C8922A;font-weight:700;}' +
      '.ef-free{font-family:var(--ef-serif);font-weight:600;font-size:16px;margin:18px 0 0;color:#fff;}' +
      '.ef-rel-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;}' +
      '.ef-rel-card{display:flex;flex-direction:column;gap:8px;background:#fff;border:1px solid var(--ef-line);border-radius:12px;padding:18px 18px;text-decoration:none;transition:border-color .15s ease,transform .15s ease;}' +
      '.ef-rel-card:hover{border-color:var(--ef-green);transform:translateY(-2px);}' +
      '.ef-rel-cat{font-family:var(--ef-sans);font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--ef-green);}' +
      '.ef-rel-title{font-family:var(--ef-serif);font-weight:600;font-size:15px;line-height:1.35;color:var(--ef-ink);}' +
      '.ef-next{margin-top:22px;}' +
      '.ef-next-label{display:block;font-family:var(--ef-sans);font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--ef-muted);margin-bottom:10px;}' +
      '.ef-next-card{display:flex;align-items:center;justify-content:space-between;gap:16px;background:#fff;border:2px solid var(--ef-green);border-radius:14px;padding:22px 24px;text-decoration:none;transition:background .15s ease;}' +
      '.ef-next-card:hover{background:#f2f6f2;}' +
      '.ef-next-title{font-family:var(--ef-serif);font-weight:600;font-size:clamp(16px,2.2vw,19px);line-height:1.3;color:var(--ef-ink);}' +
      '.ef-next-go{font-family:var(--ef-sans);font-size:14px;font-weight:600;color:var(--ef-green);white-space:nowrap;}' +
      '@media (max-width:600px){.ef-next-card{flex-direction:column;align-items:flex-start;gap:8px;}}';
    var style = document.createElement('style');
    style.id = 'ef-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }
})();
