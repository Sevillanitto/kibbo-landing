/* ============================================================
   Kibbo Education — Library engine
   Fetches /data/education-library.json and renders topic sidebar
   + resource cards into #library-app. No frameworks, no deps.
   Adding a new topic later = appending a {topic, verified,
   resources} object to that JSON file — this file never changes.
   ============================================================ */
(function () {
  'use strict';

  var DATA_URL = '/data/education-library.json';
  var mount = document.getElementById('library-app');
  if (!mount) return;

  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function monthYear(iso) {
    if (!iso) return '';
    var parts = iso.split('-');
    var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
    if (!y || !m) return iso;
    return MONTHS[m - 1] + ' ' + y;
  }

  function slugify(topic) {
    return 'lib-topic-' + topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  fetch(DATA_URL)
    .then(function (res) { return res.json(); })
    .then(function (topics) { render(topics.filter(function (t) { return t.resources && t.resources.length; })); })
    .catch(function () {
      mount.appendChild(el('p', 'lib-error', 'The library data could not be loaded. Please refresh the page.'));
    });

  function render(topics) {
    if (!topics.length) return;

    var layout = el('div', 'blf-layout');

    // ---- Sidebar ----
    var aside = el('aside', 'blf-sidebar');
    aside.setAttribute('aria-label', 'Filter by topic');
    aside.appendChild(el('p', 'blf-sidebar-label', 'Topics'));

    var totalCount = topics.reduce(function (n, t) { return n + t.resources.length; }, 0);

    var details = document.createElement('details');
    details.className = 'blf-cat';
    details.open = true;
    var summary = document.createElement('summary');
    var sName = el('span', 'blf-cat-name', 'All');
    var sCount = el('span', 'blf-count', String(totalCount));
    var arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('class', 'blf-arrow');
    arrow.setAttribute('width', '14'); arrow.setAttribute('height', '14');
    arrow.setAttribute('viewBox', '0 0 24 24'); arrow.setAttribute('fill', 'none');
    arrow.setAttribute('stroke', 'currentColor'); arrow.setAttribute('stroke-width', '2');
    arrow.setAttribute('stroke-linecap', 'round'); arrow.setAttribute('stroke-linejoin', 'round');
    arrow.innerHTML = '<polyline points="6 9 12 15 18 9"></polyline>';
    summary.appendChild(sName); summary.appendChild(sCount); summary.appendChild(arrow);
    details.appendChild(summary);

    var list = el('ul', 'blf-cat-list');
    var buttons = [];

    function addFilterButton(value, name, count, active) {
      var li = document.createElement('li');
      var b = el('button', active ? 'active' : null, name + ' (' + count + ')');
      b.type = 'button';
      b.dataset.value = value;
      li.appendChild(b);
      list.appendChild(li);
      buttons.push(b);
      return b;
    }

    addFilterButton('', 'All', totalCount, true);
    topics.forEach(function (t) {
      addFilterButton(slugify(t.topic), t.topic, t.resources.length, false);
    });

    details.appendChild(list);
    aside.appendChild(details);
    layout.appendChild(aside);

    // ---- Main content ----
    var main = el('main', 'section-main');
    main.style.paddingTop = '0';

    var sections = [];
    topics.forEach(function (t) {
      var section = el('section', 'edu-section lib-topic-section');
      section.id = slugify(t.topic);
      section.dataset.topic = slugify(t.topic);

      var head = el('div', 'pillar-category-header');
      var icon = el('div', 'pillar-category-icon');
      icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#141210" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
      head.appendChild(icon);
      head.appendChild(el('h2', 'pillar-category-name', t.topic));
      head.appendChild(el('span', 'pillar-category-count', t.resources.length + (t.resources.length === 1 ? ' resource' : ' resources')));
      section.appendChild(head);

      if (t.related && t.related.length) {
        section.appendChild(buildRelatedLine(t.related));
      }

      var grid = el('div', 'lib-grid');
      t.resources.forEach(function (r) { grid.appendChild(buildCard(r, t.verified)); });
      section.appendChild(grid);

      section.appendChild(buildSubmitLine(slugify(t.topic).replace('lib-topic-', '')));

      main.appendChild(section);
      sections.push(section);
    });

    layout.appendChild(main);
    mount.appendChild(layout);
    mount.appendChild(buildSubmitLine(null));

    // ---- Filter interaction (same pattern as /education's section filter) ----
    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        var value = b.dataset.value;
        sections.forEach(function (s) { s.hidden = !!value && s.dataset.topic !== value; });
        buttons.forEach(function (x) { x.classList.toggle('active', x === b); });
        details.open = false;
      });
    });
  }

  function buildSubmitLine(categorySlug) {
    var p = el('p', 'lib-submit-line');
    p.appendChild(document.createTextNode('Know a resource that belongs here? '));
    var a = el('a', null, 'Submit it →');
    a.href = categorySlug ? '/library/submit?category=' + encodeURIComponent(categorySlug) : '/library/submit';
    p.appendChild(a);
    return p;
  }

  function buildRelatedLine(related) {
    var p = el('p', 'lib-related-line');
    p.appendChild(document.createTextNode('Related on Kibbo: '));
    related.forEach(function (rel, i) {
      if (i > 0) p.appendChild(document.createTextNode(', '));
      var a = el('a', null, rel.label);
      a.href = rel.url;
      p.appendChild(a);
    });
    return p;
  }

  function buildCard(r, topicVerified) {
    var card = el('div', 'audience-card lib-card');
    card.appendChild(el('h3', null, r.title));
    card.appendChild(el('p', 'lib-card-publisher', r.publisher));

    var meta = el('div', 'lib-card-meta');
    function chip(label, value) {
      if (!value) return;
      var span = el('span', null);
      span.appendChild(el('strong', null, label + ': '));
      span.appendChild(document.createTextNode(Array.isArray(value) ? value.join(', ') : value));
      meta.appendChild(span);
    }
    chip('Type', r.type);
    chip('Level', r.level);
    chip('Length', r.length);
    chip('Language', r.language);
    chip('Licence', r.licence);
    card.appendChild(meta);

    card.appendChild(el('p', 'lib-card-summary', r.summary));

    // One-off cross-links to Kibbo's own investigations and exercises built
    // on the same underlying data — surfaced next to the external link, not
    // in the data. Each id maps to one or more {label, url} links.
    var RELATED_KIBBO = {
      'fbi-ic3-internet-crime-report-2025': [
        { label: 'Related on Kibbo: The AI Scam Playbook →', url: '/investigations/ai-scam-playbook-2026' }
      ],
      'oecd-health-at-a-glance-2025': [
        { label: 'Related on Kibbo: Healthcare Cost Comparison →', url: '/investigations/healthcare-cost-comparison' }
      ],
      'dot-cancellation-delay-dashboard': [
        { label: 'Related on Kibbo: US Airline Ranking investigation →', url: '/investigations/us-airline-ranking-2026-h1' },
        { label: 'Related on Kibbo: US Airline Ranking classroom exercise →', url: '/education/exercises/us-airline-ranking' }
      ],
      'ftc-free-trials-subscriptions': [
        { label: 'Related on Kibbo: The Streaming Price Machine investigation →', url: '/investigations/streaming-price-machine' },
        { label: 'Related on Kibbo: Streaming Price Machine classroom exercise →', url: '/education/exercises/streaming-prices' }
      ]
    };
    (RELATED_KIBBO[r.id] || []).forEach(function (rk) {
      var rel = el('p', 'lib-card-related');
      var relLink = el('a', null, rk.label);
      relLink.href = rk.url;
      rel.appendChild(relLink);
      card.appendChild(rel);
    });

    var footer = el('div', 'lib-card-footer');
    var open = el('a', 'lib-card-open', 'Open resource ↗');
    open.href = r.url;
    open.target = '_blank';
    open.rel = 'noopener';
    footer.appendChild(open);
    footer.appendChild(el('span', 'lib-card-checked', 'Last checked: ' + monthYear(topicVerified)));
    card.appendChild(footer);

    return card;
  }
})();
