/* ============================================================
   Kibbo — Consumer Rights by Country engine
   Config-driven, tabbed renderer. Reads /country-rights-config.json
   and renders one tab + panel per country into #crc-app.
   Adding a country = adding an object to the config. No code changes.
   No frameworks, no dependencies.
   ============================================================ */
(function () {
  'use strict';

  var CONFIG_URL = '/country-rights-config.json';
  var VISIBLE_LIMIT = 10; // show first N of a list, then "Show all" expands the rest
  var mount = document.getElementById('crc-app');
  if (!mount) return;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Resolve which country to show: ?country= param (code or alias), else
  // config.default_country, else the first country in the list.
  function pickCountry(cfg, param) {
    var list = cfg.countries || [];
    if (param) {
      var p = String(param).trim().toUpperCase();
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ((c.code || '').toUpperCase() === p) return c;
        var aliases = c.url_aliases || [];
        for (var j = 0; j < aliases.length; j++) {
          if (String(aliases[j]).toUpperCase() === p) return c;
        }
      }
    }
    if (cfg.default_country) {
      for (var k = 0; k < list.length; k++) {
        if ((list[k].code || '').toUpperCase() === String(cfg.default_country).toUpperCase()) return list[k];
      }
    }
    return list[0] || null;
  }

  // A list section (resources or guides) with show-first-N then expand-in-place.
  // `noun` is the plural word used in the "Show all X <noun> →" button.
  function renderList(heading, items, noun) {
    var wrap = el('div', 'crc-sub');
    wrap.appendChild(el('p', 'crc-sub-h', heading));
    var links = el('div', 'crc-links');
    (items || []).forEach(function (item, idx) {
      var a = el('a', null, item.label);
      a.href = item.url;
      if (idx >= VISIBLE_LIMIT) a.classList.add('crc-hidden');
      links.appendChild(a);
    });
    wrap.appendChild(links);

    if ((items || []).length > VISIBLE_LIMIT) {
      var btn = el('button', 'crc-showmore');
      btn.type = 'button';
      btn.textContent = 'Show all ' + items.length + ' ' + (noun || 'items') + ' →';
      btn.addEventListener('click', function () {
        links.querySelectorAll('.crc-hidden').forEach(function (n) { n.classList.remove('crc-hidden'); });
        btn.remove();
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function renderPanel(country) {
    var panel = el('section', 'crc-panel crc-country');
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-label', country.name);

    var h = el('h2', 'crc-country-h', (country.flag ? country.flag + ' ' : '') + country.name);
    panel.appendChild(h);
    if (country.subtitle) panel.appendChild(el('p', 'crc-country-sub', country.subtitle));

    // Official authorities & free resources
    panel.appendChild(renderList('Official authorities & free resources', country.resources, 'resources'));

    // Guided help — the Wizard, pre-set to this country
    if (country.wizard_preset_url) {
      var guided = el('div', 'crc-sub');
      guided.appendChild(el('p', 'crc-sub-h', 'Guided help'));
      var wiz = el('a', 'crc-wizard', 'Start the Consumer Rights Wizard, pre-set to the ' + country.name + ' →');
      wiz.href = country.wizard_preset_url;
      guided.appendChild(wiz);
      panel.appendChild(guided);
    }

    // Country guides
    panel.appendChild(renderList(country.name + ' guides', country.guides, 'guides'));

    // Templates (optional): links + note, only when either is present
    var hasTemplates = (country.templates && country.templates.length) || country.templates_note;
    if (hasTemplates) {
      var tpl = el('div', 'crc-sub');
      tpl.appendChild(el('p', 'crc-sub-h', country.name + ' templates'));
      if (country.templates && country.templates.length) {
        var tlinks = el('div', 'crc-links');
        country.templates.forEach(function (t) {
          var a = el('a', null, t.label);
          a.href = t.url;
          tlinks.appendChild(a);
        });
        tpl.appendChild(tlinks);
      }
      if (country.templates_note) {
        var note = el('p', 'crc-note', country.templates_note + ' ');
        if (country.templates_note_link) {
          var nl = el('a', null, country.templates_note_link.label);
          nl.href = country.templates_note_link.url;
          note.appendChild(nl);
        }
        tpl.appendChild(note);
      }
      panel.appendChild(tpl);
    }

    return panel;
  }

  function render(cfg, selected) {
    mount.innerHTML = '';

    // ---- Tab bar (one tab per country actually present in the config) ----
    var tabs = el('div', 'crc-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Country');

    (cfg.countries || []).forEach(function (country) {
      var tab = el('button', 'crc-tab');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.dataset.code = country.code;
      var isSel = country === selected;
      tab.classList.toggle('active', isSel);
      tab.setAttribute('aria-selected', isSel ? 'true' : 'false');
      if (country.flag) {
        var flag = el('span', 'crc-tab-flag', country.flag);
        tab.appendChild(flag);
      }
      tab.appendChild(document.createTextNode(country.name));
      tab.addEventListener('click', function () {
        if (country === selected) return;
        selected = country;
        // Update the URL so the tab is deep-linkable / shareable, without reload.
        try {
          var u = new URL(window.location.href);
          u.searchParams.set('country', country.code);
          window.history.replaceState({}, '', u);
        } catch (e) { /* non-fatal */ }
        render(cfg, country);
      });
      tabs.appendChild(tab);
    });
    mount.appendChild(tabs);

    // ---- Selected country's panel ----
    if (selected) mount.appendChild(renderPanel(selected));
  }

  fetch(CONFIG_URL)
    .then(function (r) { if (!r.ok) throw new Error('config ' + r.status); return r.json(); })
    .then(function (cfg) {
      var param = null;
      try { param = new URLSearchParams(window.location.search).get('country'); } catch (e) { param = null; }
      var selected = pickCountry(cfg, param);
      if (!selected) { mount.appendChild(el('p', 'crc-note', 'No country content available.')); return; }
      render(cfg, selected);
    })
    .catch(function () {
      mount.appendChild(el('p', 'crc-note', 'Could not load country resources. Please refresh the page.'));
    });
})();
