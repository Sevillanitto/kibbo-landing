/* Rights Checker — Screen 3 renderer.
 *
 * Provides window.RIGHTS_RESULT(combo, ctx) to decision-tree-core.js. Renders the
 * 5 standard consumer rights as a ✓ / ✗ checklist based on the combination's
 * "rights" field, then a secondary CTA that deep-links into the Wizard result for
 * the same problem+country (so the Rights Checker feeds into the Wizard's
 * resources rather than dead-ending).
 */
(function () {
  // Fixed order + plain-English description for each right.
  var RIGHTS = [
    ['Refund', 'Get your money back'],
    ['Replacement', 'Have the item replaced'],
    ['Repair', 'Have the item repaired'],
    ['Chargeback', 'Dispute the charge with your bank or card issuer'],
    ['Escalation', 'Escalate to an ombudsman, regulator or authority'],
  ];

  window.RIGHTS_RESULT = function (combo, ctx) {
    var esc = ctx.esc;
    var rights = combo.rights || {};
    var anyTrue = RIGHTS.some(function (r) { return rights[r[0]]; });

    var items = RIGHTS.map(function (r) {
      var on = !!rights[r[0]];
      return (
        '<li class="rc-item ' + (on ? 'on' : 'off') + '">' +
        '<span class="rc-mark" aria-hidden="true">' + (on ? '✓' : '✗') + '</span>' +
        '<span class="rc-text"><span class="rc-name">' + esc(r[0]) + '</span>' +
        '<span class="rc-desc">' + esc(r[1]) + '</span></span>' +
        '</li>'
      );
    }).join('');

    var params =
      '?problem=' + encodeURIComponent(ctx.problem) + '&country=' + encodeURIComponent(ctx.country);

    var html =
      '<div class="wiz-screen">' +
      '<p class="wiz-step">Step 3 of 3</p>' +
      '<h2 class="wiz-q">' + esc(ctx.problem) + ' · ' + esc(ctx.country) + '</h2>' +
      (anyTrue
        ? '<p class="rc-lead">You probably have the right to:</p>'
        : '<p class="rc-lead">This situation doesn’t map neatly onto the standard five consumer rights — but you still have options below.</p>') +
      '<ul class="rc-list">' + items + '</ul>' +
      '<p class="rc-disclaimer">General guidance based on typical UK and US consumer law — not legal advice for your specific case.</p>' +
      '<a class="rc-cta" href="/wizard.html' + params + '">Want to act on this? → See the Consumer Rights Wizard results for this situation</a>' +
      '<div class="wiz-actions">' +
      '<button type="button" class="wiz-back" data-back="country">← Change country</button>' +
      '<button type="button" class="wiz-restart" data-back="problems">Start over</button>' +
      '</div>' +
      '</div>';
    return html;
  };
})();
