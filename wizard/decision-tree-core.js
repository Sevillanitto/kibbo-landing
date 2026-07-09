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
 * ctx = { problem, country, esc }. A renderResult can include buttons with
 * data-back="problems" or data-back="country"; the core wires them.
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

    function start() {
      var problems = CFG.problems || [];
      var countries = CFG.countries || [];
      if (initP && initC && problems.indexOf(initP) !== -1 && countries.indexOf(initC) !== -1) {
        state.problem = initP;
        state.country = initC;
        showResult();
      } else {
        showProblems();
      }
    }

    // ---- Screen 1: What happened? ----
    function showProblems() {
      state.problem = null;
      state.country = null;
      stage.innerHTML =
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
      stage.querySelectorAll('[data-problem]').forEach(function (b) {
        b.addEventListener('click', function () {
          state.problem = b.getAttribute('data-problem');
          showCountries();
        });
      });
    }

    // ---- Screen 2: Which country? ----
    function showCountries() {
      stage.innerHTML =
        '<div class="wiz-screen">' +
        '<p class="wiz-step">Step 2 of 3</p>' +
        '<h2 class="wiz-q">Which country?</h2>' +
        '<div class="wiz-choices">' +
        (CFG.countries || [])
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
      stage.innerHTML = renderResult(combo, { problem: state.problem, country: state.country, esc: esc });
      wireBack();
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
