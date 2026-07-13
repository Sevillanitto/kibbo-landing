/* ============================================================
   Kibbo — Consumer Checklists engine
   Config-driven renderer. Reads window.CHECKLIST_CONFIG and
   renders into #checklist-app. No frameworks, no dependencies.
   Progress persists per checklist in localStorage (no account).
   ============================================================ */
(function () {
  'use strict';

  var cfg = window.CHECKLIST_CONFIG;
  var mount = document.getElementById('checklist-app');
  if (!cfg || !mount) return;

  var storeKey = 'kibbo-checklist-' + cfg.id;
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(storeKey) || '{}') || {}; } catch (e) { saved = {}; }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function isExternal(url) { return /^https?:\/\//i.test(url); }

  var checkboxes = [];

  // ---- Header ----
  var head = el('div', 'cl-head');
  if (cfg.category) head.appendChild(el('span', 'cl-eyebrow', cfg.category));
  head.appendChild(el('h1', 'cl-title', cfg.title));

  var meta = el('div', 'cl-meta');
  function chip(labelStrong, rest) {
    var c = el('span', 'cl-chip');
    if (labelStrong) { var s = el('strong', null, labelStrong); c.appendChild(s); }
    if (rest) c.appendChild(document.createTextNode(' ' + rest));
    return c;
  }
  // count total items
  var totalItems = 0;
  (cfg.zones || []).forEach(function (z) { totalItems += (z.items || []).length; });

  if (cfg.estimated_time) meta.appendChild(chip('⏱ ' + cfg.estimated_time, ''));
  meta.appendChild(chip('✓ ' + totalItems + ' checks', ''));
  if (cfg.difficulty) meta.appendChild(chip(cfg.difficulty, ''));
  if (cfg.last_updated) meta.appendChild(chip(null, 'Updated ' + cfg.last_updated));
  head.appendChild(meta);
  mount.appendChild(head);

  // ---- Progress ----
  var progress = el('div', 'cl-progress');
  var prow = el('div', 'cl-progress-row');
  var plabel = el('span', 'cl-progress-label', 'Your progress');
  var ppct = el('span', 'cl-progress-pct', '0%');
  prow.appendChild(plabel); prow.appendChild(ppct);
  var track = el('div', 'cl-progress-track');
  var fill = el('div', 'cl-progress-fill');
  track.appendChild(fill);
  progress.appendChild(prow); progress.appendChild(track);
  mount.appendChild(progress);

  // ---- Zones + items ----
  (cfg.zones || []).forEach(function (zone, zi) {
    var zEl = el('section', 'cl-zone');
    zEl.appendChild(el('h2', 'cl-zone-name', zone.name));
    zEl.appendChild(el('div', 'cl-zone-rule'));

    (zone.items || []).forEach(function (item, ii) {
      var key = 'z' + zi + 'i' + ii;
      var label = el('label', 'cl-item');

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.key = key;
      if (saved[key]) { cb.checked = true; label.classList.add('done'); }
      cb.addEventListener('change', function () {
        label.classList.toggle('done', cb.checked);
        update();
      });
      checkboxes.push(cb);

      var body = el('div', 'cl-item-body');
      body.appendChild(el('span', 'cl-item-text', item.text));

      // Real tool link only — never a fake/simulated action.
      if (item.tool_url && item.tool_label) {
        var a = el('a', 'cl-toolbtn');
        a.href = item.tool_url;
        if (isExternal(item.tool_url)) { a.target = '_blank'; a.rel = 'noopener'; }
        a.appendChild(document.createTextNode(item.tool_label + ' →'));
        // clicking the tool link should not toggle the checkbox
        a.addEventListener('click', function (ev) { ev.stopPropagation(); });
        body.appendChild(a);
      }

      label.appendChild(cb);
      label.appendChild(body);
      zEl.appendChild(label);
    });

    mount.appendChild(zEl);
  });

  // ---- Actions (Print / Save as PDF + Reset) ----
  var actions = el('div', 'cl-actions');
  var printBtn = el('button', 'cl-print-btn');
  printBtn.type = 'button';
  printBtn.appendChild(document.createTextNode('🖨  Print / Save as PDF'));
  printBtn.addEventListener('click', function () { window.print(); });
  actions.appendChild(printBtn);

  var resetBtn = el('button', 'cl-reset-btn');
  resetBtn.type = 'button';
  resetBtn.appendChild(document.createTextNode('↺  Reset checklist'));
  resetBtn.addEventListener('click', function () {
    checkboxes.forEach(function (cb) {
      cb.checked = false;
      cb.parentNode.classList.remove('done');
    });
    update();
  });
  actions.appendChild(resetBtn);
  mount.appendChild(actions);

  // ---- Common Mistakes ----
  if (cfg.common_mistakes && cfg.common_mistakes.length) {
    var mSec = el('section', 'cl-section');
    mSec.appendChild(el('h2', 'cl-section-title', 'Common mistakes to avoid'));
    var ul = el('ul', 'cl-mistakes');
    cfg.common_mistakes.forEach(function (m) { ul.appendChild(el('li', null, m)); });
    mSec.appendChild(ul);
    mount.appendChild(mSec);
  }

  // ---- Related tools & resources ----
  if (cfg.related && cfg.related.length) {
    var rSec = el('section', 'cl-section');
    rSec.appendChild(el('h2', 'cl-section-title', 'Related tools & resources'));
    var grid = el('div', 'cl-related-grid');
    cfg.related.forEach(function (r) {
      var a = el('a', 'cl-related-item');
      a.href = r.url;
      if (isExternal(r.url)) { a.target = '_blank'; a.rel = 'noopener'; }
      a.appendChild(el('span', null, r.label));
      a.appendChild(el('span', 'cl-related-arrow', '→'));
      grid.appendChild(a);
    });
    rSec.appendChild(grid);
    mount.appendChild(rSec);
  }

  // ---- Live progress ----
  function update() {
    var total = checkboxes.length;
    var done = 0;
    var state = {};
    checkboxes.forEach(function (cb) {
      if (cb.checked) { done++; state[cb.dataset.key] = 1; }
    });
    var pct = total ? Math.round((done / total) * 100) : 0;
    fill.style.width = pct + '%';
    ppct.textContent = pct + '%';
    if (pct === 100) {
      progress.classList.add('complete');
      plabel.textContent = 'Complete — every check done ✓';
    } else {
      progress.classList.remove('complete');
      plabel.textContent = 'Your progress · ' + done + ' of ' + total;
    }
    try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch (e) {}
  }

  update();
})();
