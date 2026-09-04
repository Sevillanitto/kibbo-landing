/* Shared decision-tree core (Consumer Rights Wizard + Rights Checker + Timeline Generator).
 *
 * Owns everything the tools have in common: loading wizard-config.json, rendering
 * Screen 1 ("What happened?") and Screen 2 ("Which country?") from the config's
 * problems/countries arrays, handling clicks, transitions and back navigation, and
 * optional deep-linking. It does NOT know what the final screen looks like — the
 * calling page passes a renderResult(combination, ctx) callback that returns the
 * final screen's HTML. That final screen is always the same shared Action Plan
 * component (window.ACTION_PLAN, see action-plan-renderer.js) for both the Wizard
 * and the Rights Checker — there is only one Action Plan renderer, called from
 * both places.
 *
 *   DecisionTree.mount({
 *     stageId: 'wizStage',
 *     renderResult: function (combo, ctx) { return htmlString; },   // final screen
 *     renderIntermediate: function (combo, ctx) { return htmlString; },  // optional
 *     totalSteps: 3,               // optional, defaults to 3
 *     initialProblem: 'Parcel',    // optional deep link
 *     initialCountry: 'UK'         // optional deep link
 *   });
 *
 * renderIntermediate is optional. When supplied (the Rights Checker's 5-rights
 * checklist screen), it renders after the country is chosen and BEFORE
 * renderResult; a button with data-next="result" inside its returned HTML
 * advances to the final Action Plan screen. When omitted (the Wizard, the
 * Timeline Generator), the country step goes straight to renderResult, exactly
 * as before.
 *
 * ctx = { problem, country, esc, combo, stage, stepLabel, backTarget, backLabel }.
 * A renderResult/renderIntermediate can include buttons with data-back="problems",
 * data-back="country" or data-back="intermediate"; the core wires them. An
 * optional opts.onResult(ctx) runs after the final result screen mounts — used by
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
    var renderIntermediate = typeof opts.renderIntermediate === 'function' ? opts.renderIntermediate : null;
    var TOTAL = opts.totalSteps || 3;
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
      // Only jump straight past the choosers when the deep-linked pair is a real
      // combination; otherwise fall through to the (filtered) chooser screens.
      if (hasP && hasC && hasCombo(initP, initC)) {
        state.problem = initP;
        state.country = initC;
        advance();
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
        '<p class="wiz-step">Step 1 of ' + TOTAL + '</p>' +
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
          if (presetCountry) advance();
          else showCountries();
        });
      });
    }

    // ---- Screen 2: Which country? ----
    function showCountries() {
      presetCountry = null; // the user is choosing a country manually now
      stage.innerHTML =
        '<div class="wiz-screen">' +
        '<p class="wiz-step">Step 2 of ' + TOTAL + '</p>' +
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
          advance();
        });
      });
      wireBack();
    }

    // ---- After the country is known: intermediate screen (if any), then result ----
    function advance() {
      if (renderIntermediate) showIntermediate();
      else showFinalResult();
    }

    function comboFor(state_) {
      return (CFG.combinations || {})[state_.problem + '|' + state_.country] || {};
    }

    // ---- Optional Screen 3: delegated to the page (e.g. Rights Checker's checklist) ----
    function showIntermediate() {
      var combo = comboFor(state);
      var ctx = {
        problem: state.problem, country: state.country, esc: esc, combo: combo, stage: stage,
        stepLabel: 'Step ' + (TOTAL - 1) + ' of ' + TOTAL
      };
      stage.innerHTML = renderIntermediate(combo, ctx);
      wireBack();
      stage.querySelectorAll('[data-next="result"]').forEach(function (b) {
        b.addEventListener('click', showFinalResult);
      });
    }

    // ---- Final screen: the shared Action Plan, delegated to the page ----
    function showFinalResult() {
      var combo = comboFor(state);
      var backTarget = renderIntermediate ? 'intermediate' : 'country';
      var ctx = {
        problem: state.problem, country: state.country, esc: esc, combo: combo, stage: stage,
        stepLabel: 'Step ' + TOTAL + ' of ' + TOTAL,
        backTarget: backTarget,
        backLabel: backTarget === 'intermediate' ? '← Back to your rights checklist' : '← Change country'
      };
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
          else if (to === 'intermediate') showIntermediate();
        });
      });
    }
  }

  window.DecisionTree = { mount: mount, esc: esc };
})();
