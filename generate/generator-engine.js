/* Kibbo generic letter-generator engine.
 *
 * One reusable engine for every generator. A page defines its generator entirely
 * through `window.KIBBO_GENERATOR` (id, title, price, gumroad_permalink,
 * questions[]) and includes this file — no generator-specific code.
 *
 * Flow: render form from config.questions -> POST /preview (free, rate-limited,
 * returns only the first paragraph + blur hint) -> show blurred teaser with a
 * Gumroad overlay checkout + license-key field -> POST /unlock (verifies the
 * license server-side by product_id) -> reveal the full letter.
 */
(function () {
  var WORKER_URL = 'https://kibbo-generators.carlos-lopez-tejeiro.workers.dev';
  var GUMROAD_BASE = 'https://carlosdevlop.gumroad.com/l/';
  var cfg = window.KIBBO_GENERATOR;
  if (!cfg) return;

  var LS_KEY = 'kibbo_gen_' + cfg.id;

  var form = document.getElementById('genForm');
  var genBtn = document.getElementById('genBtn');
  var errorBox = document.getElementById('genError');
  var fineprint = document.getElementById('genFineprint');
  var result = document.getElementById('genResult');
  var limitBox = document.getElementById('genLimit');

  // Current preview session.
  var state = { previewId: null, answers: null };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function showError(msg) {
    if (!errorBox) return;
    errorBox.textContent = msg;
    errorBox.style.display = msg ? 'block' : 'none';
  }

  // ---- 1. Render the form from config.questions ----
  function renderForm() {
    cfg.questions.forEach(function (q) {
      var field = el('div', 'gen-field');
      var label = el('label', null, q.label);
      label.setAttribute('for', 'q_' + q.id);
      field.appendChild(label);

      var input;
      if (q.type === 'select') {
        input = document.createElement('select');
        var ph = el('option', null, 'Select…');
        ph.value = '';
        input.appendChild(ph);
        (q.options || []).forEach(function (opt) {
          var o = el('option', null, opt);
          o.value = opt;
          input.appendChild(o);
        });
      } else {
        input = document.createElement('input');
        input.type = q.type === 'date' ? 'date' : 'text';
        if (q.type === 'currency') {
          input.setAttribute('inputmode', 'decimal');
          input.placeholder = 'e.g. £120.00';
        }
      }
      input.id = 'q_' + q.id;
      input.name = q.id;
      field.appendChild(input);
      form.appendChild(field);
    });
  }

  function collectAnswers() {
    var answers = {};
    var missing = false;
    cfg.questions.forEach(function (q) {
      var v = (document.getElementById('q_' + q.id).value || '').trim();
      if (!v) missing = true;
      answers[q.id] = v;
    });
    return missing ? null : answers;
  }

  // ---- 2. Generate a free preview ----
  function generate() {
    showError('');
    if (limitBox) limitBox.style.display = 'none';
    var answers = collectAnswers();
    if (!answers) {
      showError('Please fill in every field so the letter is complete.');
      return;
    }
    genBtn.disabled = true;
    genBtn.textContent = 'Generating…';

    fetch(WORKER_URL + '/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generatorId: cfg.id, answers: answers }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { status: res.status, data: data };
        });
      })
      .then(function (r) {
        if (r.status === 429 || (r.data && r.data.error === 'limit_reached')) {
          if (limitBox) limitBox.style.display = 'block';
          return;
        }
        if (r.status !== 200 || !r.data || !r.data.previewId) {
          throw new Error((r.data && (r.data.message || r.data.error)) || 'Please try again.');
        }
        state.previewId = r.data.previewId;
        state.answers = answers;
        persist();
        renderPreview(r.data.preview, r.data.blurLines);
        if (fineprint && typeof r.data.remaining === 'number') {
          fineprint.textContent =
            r.data.remaining + ' free ' + (r.data.remaining === 1 ? 'preview' : 'previews') +
            ' left today · shared across all generators';
        }
      })
      .catch(function (err) {
        showError('Could not generate the letter. ' + err.message);
      })
      .finally(function () {
        genBtn.disabled = false;
        genBtn.textContent = 'Generate letter — free preview';
      });
  }

  // ---- 3. Render the blurred teaser + unlock controls ----
  function renderPreview(visible, blurLines) {
    result.innerHTML = '';
    result.style.display = 'block';
    result.appendChild(el('h2', 'supp-ingredients-heading', 'Your letter'));

    var letter = el('div', 'gen-letter');
    letter.appendChild(el('div', 'gen-visible', visible));

    var locked = el('div', 'gen-locked');
    var blur = el('div', 'gen-blur');
    for (var i = 0; i < (blurLines || 10); i++) blur.appendChild(el('div', 'gen-blur-line'));
    locked.appendChild(blur);

    var overlay = el('div', 'gen-overlay');
    overlay.appendChild(el('p', 'gen-overlay-title', 'Unlock the full letter'));
    overlay.appendChild(
      el('p', 'gen-overlay-sub', 'See the complete demand, the legal citations and the deadline — delivered instantly.')
    );

    var buy = document.createElement('a');
    buy.className = 'supp-limit-btn gumroad-button';
    buy.href = GUMROAD_BASE + cfg.gumroad_permalink + '?wanted=true';
    buy.target = '_blank';
    buy.rel = 'noopener';
    buy.setAttribute('data-gumroad-single-product', 'true');
    buy.textContent = 'Unlock full letter — ' + (cfg.price || '$4.60') + ' →';
    overlay.appendChild(buy);

    var lic = el('div', 'gen-license');
    var input = document.createElement('input');
    input.className = 'supp-access-input';
    input.id = 'licenseKey';
    input.placeholder = 'Paste your license key to unlock';
    input.autocomplete = 'off';
    input.spellcheck = false;
    lic.appendChild(input);
    var unlockBtn = document.createElement('button');
    unlockBtn.className = 'supp-access-btn';
    unlockBtn.type = 'button';
    unlockBtn.id = 'unlockBtn';
    unlockBtn.textContent = 'Unlock';
    lic.appendChild(unlockBtn);
    var msg = el('p', 'supp-access-msg', '');
    msg.id = 'unlockMsg';
    lic.appendChild(msg);
    lic.appendChild(el('p', 'gen-license-hint', 'After paying, Gumroad shows and emails you a license key. Paste it above.'));
    overlay.appendChild(lic);

    locked.appendChild(overlay);
    letter.appendChild(locked);
    result.appendChild(letter);

    var copy = el('button', 'gen-copy', 'Copy letter');
    copy.id = 'copyBtn';
    copy.type = 'button';
    result.appendChild(copy);

    unlockBtn.addEventListener('click', unlock);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') unlock();
    });
    copy.addEventListener('click', copyLetter);
  }

  // ---- 4. Verify the license and reveal the full letter ----
  function unlock() {
    var msg = document.getElementById('unlockMsg');
    var unlockBtn = document.getElementById('unlockBtn');
    var key = (document.getElementById('licenseKey').value || '').trim();
    if (!key) {
      setMsg(msg, 'Please paste your license key.', 'err');
      return;
    }
    unlockBtn.disabled = true;
    unlockBtn.textContent = 'Unlocking…';
    setMsg(msg, '', '');

    fetch(WORKER_URL + '/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        generatorId: cfg.id,
        previewId: state.previewId,
        answers: state.answers,
        licenseKey: key,
      }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { status: res.status, data: data };
        });
      })
      .then(function (r) {
        if (r.status === 200 && r.data && r.data.letter) {
          revealLetter(r.data.letter);
          try {
            localStorage.setItem(LS_KEY + '_letter', r.data.letter);
          } catch (e) {}
          return;
        }
        setMsg(msg, (r.data && r.data.message) || 'Could not verify that license key.', 'err');
      })
      .catch(function () {
        setMsg(msg, 'Could not reach the unlock service. Please try again.', 'err');
      })
      .finally(function () {
        if (unlockBtn) {
          unlockBtn.disabled = false;
          unlockBtn.textContent = 'Unlock';
        }
      });
  }

  function revealLetter(letter) {
    result.innerHTML = '';
    result.style.display = 'block';
    result.appendChild(el('h2', 'supp-ingredients-heading', 'Your letter — unlocked'));
    var box = el('div', 'gen-letter');
    box.appendChild(el('div', 'gen-visible', letter));
    result.appendChild(box);
    var copy = el('button', 'gen-copy', 'Copy letter');
    copy.id = 'copyBtn';
    copy.type = 'button';
    copy.style.display = 'inline-block';
    copy.addEventListener('click', copyLetter);
    result.appendChild(copy);
  }

  function copyLetter() {
    var text = result.querySelector('.gen-visible');
    if (!text) return;
    var copy = document.getElementById('copyBtn');
    navigator.clipboard.writeText(text.textContent).then(function () {
      if (copy) {
        copy.textContent = 'Copied ✓';
        setTimeout(function () {
          copy.textContent = 'Copy letter';
        }, 2000);
      }
    });
  }

  function setMsg(node, text, kind) {
    if (!node) return;
    node.textContent = text;
    node.className = 'supp-access-msg ' + (kind || '');
  }

  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  // Restore an already-unlocked letter after a refresh.
  function restore() {
    try {
      var letter = localStorage.getItem(LS_KEY + '_letter');
      if (letter) revealLetter(letter);
    } catch (e) {}
  }

  renderForm();
  if (genBtn) genBtn.addEventListener('click', generate);
  restore();
})();
