/* Consumer Rights Wizard — engine.
 *
 * Reads wizard/wizard-config.json and renders a 3-screen decision tree. There is
 * NO problem- or country-specific logic here: screens 1 and 2 are built from the
 * config's "problems" and "countries" arrays, and screen 3 renders whatever
 * non-null fields exist in combinations["Problem|Country"]. Adding a problem,
 * a country, or filling a gap is a config-only change.
 */
(function () {
  var stage = document.getElementById('wizStage');
  if (!stage) return;

  var CFG = null;
  var state = { problem: null, country: null };

  // Presentation for each resource type — the only place card labels live.
  var CARD_META = {
    directory: { eyebrow: 'Official authority', cta: 'Go to the resource' },
    article: { eyebrow: 'Read the guide', cta: 'Read the article' },
    template: { eyebrow: 'Ready-made template', cta: 'Get the template' },
    tool_analyzer: { eyebrow: 'AI analyzer', cta: 'Open the analyzer' },
    tool_generator: { eyebrow: 'Letter generator', cta: 'Open the generator' },
  };

  function esc(s) {
    return (s || '').replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  fetch('/wizard/wizard-config.json', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      CFG = cfg;
      renderProblems();
    })
    .catch(function () {
      stage.innerHTML =
        '<p class="wiz-error">Sorry — the wizard could not load. Please refresh, or browse the ' +
        '<a href="/directory.html">Free Resources Directory</a> directly.</p>';
    });

  // ---- Screen 1: What happened? ----
  function renderProblems() {
    state.problem = null;
    state.country = null;
    var html =
      '<div class="wiz-screen">' +
      '<p class="wiz-step">Step 1 of 3</p>' +
      '<h2 class="wiz-q">What happened?</h2>' +
      '<div class="wiz-choices">' +
      (CFG.problems || [])
        .map(function (p) {
          return '<button type="button" class="wiz-choice" data-problem="' + esc(p) + '">' + esc(p) + '</button>';
        })
        .join('') +
      '</div>' +
      '</div>';
    stage.innerHTML = html;
    stage.querySelectorAll('[data-problem]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.problem = b.getAttribute('data-problem');
        renderCountries();
      });
    });
  }

  // ---- Screen 2: Which country? ----
  function renderCountries() {
    var html =
      '<div class="wiz-screen">' +
      '<p class="wiz-step">Step 2 of 3</p>' +
      '<h2 class="wiz-q">Which country?</h2>' +
      '<div class="wiz-choices">' +
      (CFG.countries || [])
        .map(function (c) {
          return '<button type="button" class="wiz-choice" data-country="' + esc(c) + '">' + esc(c) + '</button>';
        })
        .join('') +
      '</div>' +
      '<button type="button" class="wiz-back" data-back="problems">← Back</button>' +
      '</div>';
    stage.innerHTML = html;
    stage.querySelectorAll('[data-country]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.country = b.getAttribute('data-country');
        renderResult();
      });
    });
    wireBack();
  }

  // ---- Screen 3: Result ----
  function renderResult() {
    var combo = (CFG.combinations || {})[state.problem + '|' + state.country] || {};
    var cards = [];

    if (combo.directory) cards.push(card('directory', combo.directory.name, combo.directory.url));
    if (combo.article) cards.push(card('article', combo.article.title, combo.article.url));
    if (combo.tool) {
      var metaKey = combo.tool.type === 'generator' ? 'tool_generator' : 'tool_analyzer';
      cards.push(card(metaKey, combo.tool.name, combo.tool.url));
    }
    if (combo.template) cards.push(card('template', combo.template.name, combo.template.url));

    var html =
      '<div class="wiz-screen">' +
      '<p class="wiz-step">Step 3 of 3</p>' +
      '<h2 class="wiz-q">Your action plan: ' + esc(state.problem) + ' · ' + esc(state.country) + '</h2>';

    if (cards.length) {
      html += '<div class="wiz-result">' + cards.join('') + '</div>';
      // Be honest about completeness rather than faking it.
      if (cards.length <= 2) {
        html += '<p class="wiz-note">More resources for this combination are on the way.</p>';
      }
    } else {
      html +=
        '<p class="wiz-note">We don’t have tailored resources for this exact combination yet — they’re on the way. ' +
        'In the meantime, the <a href="/directory.html">Free Resources Directory</a> covers the official authorities.</p>';
    }

    html +=
      '<div class="wiz-actions">' +
      '<button type="button" class="wiz-back" data-back="country">← Change country</button>' +
      '<button type="button" class="wiz-restart" data-back="problems">Start over</button>' +
      '</div>' +
      '</div>';

    stage.innerHTML = html;
    wireBack();
  }

  function card(metaKey, title, url) {
    var m = CARD_META[metaKey];
    return (
      '<a class="wiz-card" href="' + url + '">' +
      '<span class="wiz-card-eyebrow">' + m.eyebrow + '</span>' +
      '<span class="wiz-card-title">' + esc(title) + '</span>' +
      '<span class="wiz-card-cta">' + m.cta + ' →</span>' +
      '</a>'
    );
  }

  function wireBack() {
    stage.querySelectorAll('[data-back]').forEach(function (b) {
      b.addEventListener('click', function () {
        var to = b.getAttribute('data-back');
        if (to === 'problems') renderProblems();
        else if (to === 'country') renderCountries();
      });
    });
  }
})();
