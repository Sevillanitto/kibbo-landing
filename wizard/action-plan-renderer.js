/* Shared Action Plan renderer — the ONE result component for both the Consumer
 * Rights Wizard and the Rights Checker.
 *
 * Provides window.ACTION_PLAN(combo, ctx) to decision-tree-core.js. Renders a
 * resource card for each non-null field (directory / article / tool / template);
 * null fields are simply skipped — never a broken link or empty box.
 *
 * Called from two places with the same combination data:
 *   - wizard.html          — directly after the country step (ctx.stepLabel "Step 3 of 3")
 *   - rights-checker.html  — after its own 5-rights checklist screen
 *                             (ctx.stepLabel "Step 4 of 4"), via the "Continue" button
 *                             on that screen. Both render identical output for the
 *                             same problem+country — there is no second copy of this
 *                             logic anywhere else.
 *
 * When ctx.problem is "Scam" (any country — currently UK/US/Australia per
 * wizard-config.json; EU has no Scam combination so this never fires for EU), a
 * 5th card links to the standalone Scam Recovery Hub (scam-recovery-hub.html,
 * URL unchanged, no longer in main nav) so users can drill into their specific
 * scam sub-type. No other category gets this card.
 */
(function () {
  var CARD_META = {
    directory: { eyebrow: 'Official authority', cta: 'Go to the resource' },
    article: { eyebrow: 'Read the guide', cta: 'Read the article' },
    template: { eyebrow: 'Ready-made template', cta: 'Get the template' },
    tool_analyzer: { eyebrow: 'AI analyzer', cta: 'Open the analyzer' },
    tool_generator: { eyebrow: 'Letter generator', cta: 'Open the generator' },
    scam_hub: { eyebrow: 'Explore by scam type', cta: 'Browse the Scam Recovery Hub' },
  };

  function card(esc, metaKey, title, url) {
    var m = CARD_META[metaKey];
    return (
      '<a class="wiz-card" href="' + url + '">' +
      '<span class="wiz-card-eyebrow">' + m.eyebrow + '</span>' +
      '<span class="wiz-card-title">' + esc(title) + '</span>' +
      '<span class="wiz-card-cta">' + m.cta + ' →</span>' +
      '</a>'
    );
  }

  window.ACTION_PLAN = function (combo, ctx) {
    var esc = ctx.esc;
    var cards = [];
    if (combo.directory) cards.push(card(esc, 'directory', combo.directory.name, combo.directory.url));
    if (combo.article) cards.push(card(esc, 'article', combo.article.title, combo.article.url));
    if (combo.tool) {
      var metaKey = combo.tool.type === 'generator' ? 'tool_generator' : 'tool_analyzer';
      cards.push(card(esc, metaKey, combo.tool.name, combo.tool.url));
    }
    if (combo.template) cards.push(card(esc, 'template', combo.template.name, combo.template.url));
    if (ctx.problem === 'Scam') {
      cards.push(card(esc, 'scam_hub', 'Scam Recovery Hub', '/scam-recovery-hub.html'));
    }

    var html =
      '<div class="wiz-screen">' +
      '<p class="wiz-step">' + esc(ctx.stepLabel || 'Step 3 of 3') + '</p>' +
      '<h2 class="wiz-q">Your action plan: ' + esc(ctx.problem) + ' · ' + esc(ctx.country) + '</h2>';

    if (cards.length) {
      html += '<div class="wiz-result">' + cards.join('') + '</div>';
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
      '<button type="button" class="wiz-back" data-back="' + (ctx.backTarget || 'country') + '">' +
      esc(ctx.backLabel || '← Change country') + '</button>' +
      '<button type="button" class="wiz-restart" data-back="problems">Start over</button>' +
      '</div>' +
      '</div>';
    return html;
  };
})();
