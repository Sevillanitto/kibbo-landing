/* Shared decision-tree core (Consumer Rights Wizard + Rights Checker).
 *
 * Owns everything the two tools have in common: loading wizard-config.json,
 * rendering Screen 1 ("What happened?") and Screen 2 ("Which country?") from the
 * config's problems/countries arrays, handling clicks, transitions and back
 * navigation, and optional deep-linking. It does NOT know what Screen 3 looks
 * like — the calling page passes a renderResult(combination, ctx) callback that
 * returns the Screen-3 HTML.
 *
 *   DecisionTree.mount({
 *     stageId: 'wizStage',
 *     renderResult: function (combo, ctx) { return htmlString; },
 *     initialProblem: 'Parcel',   // optional deep link
 *     initialCountry: 'UK'        // optional deep link
 *   });
 *
 * ctx = { problem, country, esc, combo, stage }. A renderResult can include
 * buttons with data-back="problems" or data-back="country"; the core wires them.
 * An optional opts.onResult(ctx) runs after the result screen mounts — used by
 * pages (e.g. the Timeline Generator) that need to attach their own listeners.
 */
(function () {
  function esc(s) {
    return (s || '').replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function mount(opts) {
    var stage = opts.stage || document.getElementById(opts.stageId);
    if (!stage || typeof opts.renderResult !== 'function') return;

    var configUrl = opts.configUrl || '/wizard/wizard-config.json';
    var renderResult = opts.renderResult;
    var initP = opts.initialProblem || null;
    var initC = opts.initialCountry || null;

    var CFG = null;
    var state = { problem: null, country: null };
    var presetCountry = null; // set by a country-only deep link (?country=UK) to skip the country screen

    fetch(configUrl, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        CFG = cfg;
        start();
      })
      .catch(function () {
        stage.innerHTML =
          '<p class="wiz-error">Sorry — this could not load. Please refresh, or browse the ' +
          '<a href="/directory.html">Free Resources Directory</a> directly.</p>';
      });

    // A country only "supports" a problem when a real combination exists for it.
    // Used to hide problems/countries that would otherwise render an empty result
    // screen — e.g. Australia only has Bank/Landlord/Scam combinations, so it is
    // never offered for Subscription/Parcel/Work, and ?country=AU shows only those
    // three problems. UK/US have every combination, so they are unaffected.
    function hasCombo(problem, country) {
      return !!(CFG && CFG.combinations && CFG.combinations[problem + '|' + country]);
    }
    function problemsForCountry(country) {
      return (CFG.problems || []).filter(function (p) { return hasCombo(p, country); });
    }
    function countriesForProblem(problem) {
      return (CFG.countries || []).filter(function (c) { return hasCombo(problem, c); });
    }

    function start() {
      var problems = CFG.problems || [];
      var countries = CFG.countries || [];
      var hasP = initP && problems.indexOf(initP) !== -1;
      var hasC = initC && countries.indexOf(initC) !== -1;
      // Only jump straight to the result when the deep-linked pair is a real
      // combination; otherwise fall through to the (filtered) chooser screens.
      if (hasP && hasC && hasCombo(initP, initC)) {
        state.problem = initP;
        state.country = initC;
        showResult();
        return;
      }
      // Country-only deep link (?country=UK): remember it and skip the country
      // screen once a problem is chosen.
      if (hasC) presetCountry = initC;
      showProblems();
    }

    // ---- Screen 1: What happened? ----
    function showProblems() {
      state.problem = null;
      state.country = presetCountry || null;
      stage.innerHTML =
        '<div class="wiz-screen">' +
        '<p class="wiz-step">Step 1 of 3</p>' +
        '<h2 class="wiz-q">What happened?</h2>' +
        '<div class="wiz-choices">' +
        (presetCountry ? problemsForCountry(presetCountry) : (CFG.problems || []))
          .map(function (p) {
            return '<button type="button" class="wiz-choice" data-problem="' + esc(p) + '">' + esc(p) + '</button>';
          })
          .join('') +
        '</div>' +
        '</div>';
      stage.querySelectorAll('[data-problem]').forEach(function (b) {
        b.addEventListener('click', function () {
          state.problem = b.getAttribute('data-problem');
          if (presetCountry) showResult();
          else showCountries();
        });
      });
    }

    // ---- Screen 2: Which country? ----
    function showCountries() {
      presetCountry = null; // the user is choosing a country manually now
      stage.innerHTML =
        '<div class="wiz-screen">' +
        '<p class="wiz-step">Step 2 of 3</p>' +
        '<h2 class="wiz-q">Which country?</h2>' +
        '<div class="wiz-choices">' +
        countriesForProblem(state.problem)
          .map(function (c) {
            return '<button type="button" class="wiz-choice" data-country="' + esc(c) + '">' + esc(c) + '</button>';
          })
          .join('') +
        '<button type="button" class="wiz-back" data-back="problems">← Back</button>' +
        '</div>' +
        '</div>';
      stage.querySelectorAll('[data-country]').forEach(function (b) {
        b.addEventListener('click', function () {
          state.country = b.getAttribute('data-country');
          showResult();
        });
      });
      wireBack();
    }

    // ---- Screen 3: delegated to the page ----
    function showResult() {
      var combo = (CFG.combinations || {})[state.problem + '|' + state.country] || {};
      var ctx = { problem: state.problem, country: state.country, esc: esc, combo: combo, stage: stage };
      stage.innerHTML = renderResult(combo, ctx);
      wireBack();
      if (typeof opts.onResult === 'function') opts.onResult(ctx);
    }

    function wireBack() {
      stage.querySelectorAll('[data-back]').forEach(function (b) {
        b.addEventListener('click', function () {
          var to = b.getAttribute('data-back');
          if (to === 'problems') showProblems();
          else if (to === 'country') showCountries();
        });
      });
    }
  }

  window.DecisionTree = { mount: mount, esc: esc };
})();
