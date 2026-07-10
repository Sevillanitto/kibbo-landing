/* Timeline Generator — Screen 2.5 (date picker) + Screen 3 (SVG timeline).
 *
 * Provides two callbacks to decision-tree-core.js:
 *   window.TIMELINE_RESULT(combo, ctx)   -> returns the date-picker screen HTML.
 *   window.TIMELINE_ON_RESULT(ctx)       -> runs after mount; wires the date input
 *                                           and renders the calculated SVG timeline.
 *
 * All date maths is client-side — no server calls, no API cost. Given the user's
 * start date and the combination's "timeline" array (label + days_from_start),
 * each step's calendar date is start + days, coloured by where it falls relative
 * to today: green = passed, amber = next upcoming, terra = final deadline overdue,
 * neutral = upcoming.
 */
(function () {
  var GREEN = '#3D6B4F', AMBER = '#C8922A', TERRA = '#B85C3A', NEUTRAL = '#B8B2A6', LINE = '#E4E0D8';

  function esc(s) {
    return (s || '').replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function todayMidnight() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function addDays(base, n) { var d = new Date(base.getTime()); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d; }
  function fmt(d) { return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); }
  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  // ---- Screen 2.5: "When did this start?" ----
  window.TIMELINE_RESULT = function (combo, ctx) {
    return (
      '<div class="wiz-screen">' +
      '<p class="wiz-step">Step 3 of 3</p>' +
      '<h2 class="wiz-q">When did this start?</h2>' +
      '<p class="tl-help">Pick the date the problem began — the order date, the move-out date, or the day it happened. Not sure? Leave it on today.</p>' +
      '<div class="tl-datebar">' +
      '<input type="date" id="tlDate" class="tl-date-input" aria-label="Start date">' +
      '<button type="button" id="tlGo" class="tl-go">Show my timeline →</button>' +
      '</div>' +
      '<div id="tlOutput" class="tl-output" aria-live="polite"></div>' +
      '<div class="wiz-actions">' +
      '<button type="button" class="wiz-back" data-back="country">← Change country</button>' +
      '<button type="button" class="wiz-restart" data-back="problems">Start over</button>' +
      '</div>' +
      '</div>'
    );
  };

  // ---- After mount: wire the date input and render the timeline ----
  window.TIMELINE_ON_RESULT = function (ctx) {
    var input = document.getElementById('tlDate');
    var go = document.getElementById('tlGo');
    var out = document.getElementById('tlOutput');
    if (!input || !out) return;

    var steps = (ctx.combo && ctx.combo.timeline) || [];
    var recommended = !!(ctx.combo && ctx.combo.timeline_recommended);

    input.value = iso(todayMidnight()); // default to today

    function parseStart() {
      var v = input.value;
      var d;
      if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        var p = v.split('-');
        d = new Date(+p[0], +p[1] - 1, +p[2]);
      } else {
        d = new Date();
      }
      d.setHours(0, 0, 0, 0);
      return d;
    }

    function render() {
      if (!steps.length) {
        out.innerHTML = '<p class="wiz-note">No timeline is available for this combination yet.</p>';
        return;
      }
      var start = parseStart();
      var today = todayMidnight();
      var dates = steps.map(function (s) { return addDays(start, s.days_from_start || 0); });
      var nextIdx = -1;
      for (var i = 0; i < dates.length; i++) {
        if (dates[i].getTime() >= today.getTime()) { nextIdx = i; break; }
      }
      var colors = dates.map(function (d, i) {
        if (d.getTime() < today.getTime()) {
          return (nextIdx === -1 && i === dates.length - 1) ? TERRA : GREEN;
        }
        return i === nextIdx ? AMBER : NEUTRAL;
      });

      var meta = recommended
        ? '<span class="tl-kind tl-kind-rec">Recommended steps</span> Practical steps and typical timeframes — not fixed legal deadlines.'
        : '<span class="tl-kind tl-kind-legal">Statutory deadlines</span> Based on the UK/US consumer-law time limits in the linked guide.';

      var overdue = nextIdx === -1
        ? '<p class="tl-overdue">⚠ For that start date, the final deadline on this timeline has already passed — act now and take advice.</p>'
        : '';

      var legend =
        '<div class="tl-legend">' +
        '<span><i style="background:' + GREEN + '"></i>Passed</span>' +
        '<span><i style="background:' + AMBER + '"></i>Next up</span>' +
        '<span><i style="background:' + NEUTRAL + '"></i>Upcoming</span>' +
        '<span><i style="background:' + TERRA + '"></i>Overdue</span>' +
        '</div>';

      var cta =
        '<a class="rc-cta" href="/wizard.html?problem=' + encodeURIComponent(ctx.problem) +
        '&country=' + encodeURIComponent(ctx.country) +
        '">Ready to act? → See the resources for this situation in the Consumer Rights Wizard</a>';

      out.innerHTML =
        '<p class="tl-meta">' + meta + '</p>' + overdue + legend + buildSVG(steps, dates, colors) + cta;
    }

    function buildSVG(steps, dates, colors) {
      var row = 88, top = 30, W = 560, lineX = 26;
      var H = top * 2 + (steps.length - 1) * row;
      var p = [];
      p.push('<line x1="' + lineX + '" y1="' + top + '" x2="' + lineX + '" y2="' + (top + (steps.length - 1) * row) + '" stroke="' + LINE + '" stroke-width="2"/>');
      steps.forEach(function (s, i) {
        var cy = top + i * row;
        var col = colors[i];
        p.push('<circle cx="' + lineX + '" cy="' + cy + '" r="9" fill="' + col + '"/>');
        p.push('<circle cx="' + lineX + '" cy="' + cy + '" r="9" fill="none" stroke="#F7F5F0" stroke-width="3"/>');
        p.push(
          '<foreignObject x="52" y="' + (cy - 28) + '" width="' + (W - 68) + '" height="' + row + '">' +
          '<div xmlns="http://www.w3.org/1999/xhtml" class="tl-node">' +
          '<span class="tl-node-date" style="color:' + col + '">' + esc(fmt(dates[i])) + '</span>' +
          '<span class="tl-node-label">' + esc(s.label) + '</span>' +
          '</div></foreignObject>'
        );
      });
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" class="tl-svg" role="img" aria-label="Timeline of steps and their calculated dates">' + p.join('') + '</svg>';
    }

    render();
    if (go) go.addEventListener('click', render);
    input.addEventListener('change', render);
  };
})();
