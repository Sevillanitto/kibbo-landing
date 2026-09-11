/* Kibbo generic letter-generator engine.
 *
 * One reusable engine for every generator. A page defines its generator entirely
 * through `window.KIBBO_GENERATOR` (id, title, questions[]) and includes this
 * file — no generator-specific code.
 *
 * Flow: render form from config.questions -> POST /preview (free, rate-limited,
 * returns only the first paragraph + blur hint) -> show blurred teaser with an
 * inline email-capture form -> submitting the email calls /api/unlock-generators
 * (Vercel function: Mailchimp + Resend, best-effort) and sets a SITE-WIDE
 * localStorage unlock flag (kibbo_generators_unlocked), then POSTs to the
 * Worker's /unlock endpoint (no license key required any more -- unlocking is
 * free, gated only by having submitted an email once) to reveal the full
 * letter. Once that site-wide flag is set, every generator -- including ones
 * never visited before -- skips the blurred teaser and email form entirely and
 * reveals the full letter as soon as the preview call succeeds.
 *
 * Formerly Gumroad/license-key gated (removed 2026-09-11): no purchase links,
 * no license verification anywhere in this file any more.
 *
 * BILLING PAUSE (added 2026-09-11): the Worker's /preview responds
 * { paused: true } (skipping Anthropic entirely, server-side) while
 * GENERATORS_PAUSED is set -- see worker.js. When paused, this file still
 * runs the email-capture step exactly as normal (same Mailchimp + Resend
 * call, same localStorage flag), but shows a "coming soon" message instead
 * of ever fetching a real letter -- /unlock is never called at all in this
 * state. An already-unlocked visitor skips straight to that message, no
 * email form. Remove nothing here to resume: once GENERATORS_PAUSED is
 * unset on the Worker, /preview stops returning { paused: true } and this
 * file's normal flow (renderPreview -> submitEmail -> unlockFullLetter)
 * runs exactly as it did before the pause, unchanged.
 */
(function () {
  var WORKER_URL = 'https://kibbo-generators.carlos-lopez-tejeiro.workers.dev';
  var UNLOCK_API_URL = '/api/unlock-generators';
  var SITE_UNLOCK_KEY = 'kibbo_generators_unlocked';
  var cfg = window.KIBBO_GENERATOR;
  if (!cfg) return;

  var LS_KEY = 'kibbo_gen_' + cfg.id;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  function isUnlocked() {
    try { return localStorage.getItem(SITE_UNLOCK_KEY) === 'true'; } catch (e) { return false; }
  }

  function setUnlocked() {
    try { localStorage.setItem(SITE_UNLOCK_KEY, 'true'); } catch (e) {}
  }

  // Daily free-preview limit reached: just the notice. No paid bypass any
  // more (unlocking itself is now free, so there's nothing left to buy
  // one's way past a preview-count limit with).
  function showLimit() {
    if (!limitBox) return;
    limitBox.style.display = 'block';
    limitBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---- 1. Render the form from config.questions ----
  // Two config-only additions on top of the original flat form, both optional
  // and backward-compatible with every existing generator's questions[]:
  //   - { type: 'note', html: '...' } — a static info callout, not an input,
  //     skipped entirely by collectAnswers(). Used e.g. to point to a related
  //     evidence-pack template right above a branch selector.
  //   - { showWhen: { field: 'other_question_id', equals: 'Some Option' } } —
  //     hides the field unless the referenced question currently has that
  //     value. Hidden fields are never required; if left blank they're sent
  //     to the Worker as 'N/A' (matching this site's established convention
  //     for conditionally-irrelevant fields) rather than blocking submission.
  function renderForm() {
    cfg.questions.forEach(function (q) {
      if (q.type === 'note') {
        var note = el('div', 'gen-note');
        note.innerHTML = q.html || q.text || '';
        form.appendChild(note);
        return;
      }

      var field = el('div', 'gen-field');
      if (q.showWhen) {
        field.dataset.showWhenField = q.showWhen.field;
        field.dataset.showWhenEquals = q.showWhen.equals;
        field.classList.add('gen-field-branch');
      }
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
      } else if (q.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 4;
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
    updateBranchVisibility();
    form.addEventListener('change', updateBranchVisibility);
  }

  // Show/hide any field with showWhen based on the current value of the
  // question it depends on. Runs once after render, then on every form change.
  function updateBranchVisibility() {
    var branchFields = form.querySelectorAll('.gen-field-branch');
    // Two passes: a showWhen can itself reference a field that's also
    // conditionally hidden (e.g. an "Other — describe" field nested under a
    // branch-only select), so a field's real visibility depends on its
    // reference field's resolved visibility, not just its raw value.
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < branchFields.length; i++) {
        var field = branchFields[i];
        var refInput = document.getElementById('q_' + field.dataset.showWhenField);
        var refField = refInput && refInput.closest('.gen-field');
        var refVisible = !refField || refField.style.display !== 'none';
        var match = !!refInput && refVisible && refInput.value === field.dataset.showWhenEquals;
        field.style.display = match ? '' : 'none';
      }
    }
  }

  function collectAnswers() {
    var answers = {};
    var missing = false;
    cfg.questions.forEach(function (q) {
      if (q.type === 'note') return;
      var input = document.getElementById('q_' + q.id);
      var field = input.closest('.gen-field');
      var visible = !field || field.style.display !== 'none';
      var v = (input.value || '').trim();
      if (visible) {
        if (!v) missing = true;
        answers[q.id] = v;
      } else {
        answers[q.id] = v || 'N/A';
      }
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
          showLimit();
          return;
        }

        // Billing pause: server-side, skips Anthropic entirely (see
        // worker.js). Email capture still runs exactly as normal below --
        // only the final "reveal a real letter" step is replaced.
        if (r.data && r.data.paused) {
          renderPaused();
          return;
        }

        if (r.status !== 200 || !r.data || !r.data.previewId) {
          throw new Error((r.data && (r.data.message || r.data.error)) || 'Please try again.');
        }
        state.previewId = r.data.previewId;
        state.answers = answers;
        persist();

        // Already unlocked site-wide (from a previous generator, or this
        // one on an earlier visit): skip the blurred teaser and email form
        // entirely, go straight to the full letter.
        if (isUnlocked()) {
          unlockFullLetter();
          return;
        }

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

  // Shared email-capture box (.gen-license / .supp-access-* -- the same
  // classes the old license-key input used, so no new CSS). `onSubmit` is
  // called with no arguments once a well-formed email has been entered and
  // the button clicked (or Enter pressed); it owns disabling the button /
  // showing its own success or error message via the returned refs.
  // `btnText`/`btnTextBusy` default to the normal unlock wording; the
  // paused state passes its own so the button never promises an instant
  // letter that isn't actually available yet.
  function buildEmailCaptureBox(onSubmit, btnText, btnTextBusy) {
    btnText = btnText || 'Unlock full letter — free';
    btnTextBusy = btnTextBusy || 'Unlocking…';
    var emailBox = el('div', 'gen-license');
    var emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.className = 'supp-access-input';
    emailInput.id = 'unlockEmail';
    emailInput.placeholder = 'you@example.com';
    emailInput.autocomplete = 'email';
    emailInput.spellcheck = false;
    emailBox.appendChild(emailInput);
    var unlockBtn = document.createElement('button');
    unlockBtn.className = 'supp-access-btn';
    unlockBtn.type = 'button';
    unlockBtn.id = 'unlockBtn';
    unlockBtn.textContent = btnText;
    emailBox.appendChild(unlockBtn);
    var msg = el('p', 'supp-access-msg', '');
    msg.id = 'unlockMsg';
    emailBox.appendChild(msg);
    emailBox.appendChild(el('p', 'gen-license-hint', 'One email unlocks every generator on Kibbo — not just this one.'));

    function submit() {
      var email = (emailInput.value || '').trim();
      if (!EMAIL_RE.test(email)) {
        setMsg(msg, 'Please enter a valid email address.', 'err');
        return;
      }
      unlockBtn.disabled = true;
      unlockBtn.textContent = btnTextBusy;
      setMsg(msg, '', '');

      fetch(UNLOCK_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email }),
      })
        .then(function () {
          // Per spec: a backend hiccup (Mailchimp or Resend individually
          // failing) must never block access -- the API route always
          // responds 200 once the email itself is well-formed.
          setUnlocked();
          onSubmit();
        })
        .catch(function () {
          // Even a network failure reaching our own API shouldn't block a
          // user who typed a real email -- unlock anyway.
          setUnlocked();
          onSubmit();
        });
    }

    unlockBtn.addEventListener('click', submit);
    emailInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submit();
    });

    return emailBox;
  }

  // ---- 3. Render the blurred teaser + inline email-capture unlock ----
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
    overlay.appendChild(buildEmailCaptureBox(unlockFullLetter));

    locked.appendChild(overlay);
    letter.appendChild(locked);
    result.appendChild(letter);

    var copy = el('button', 'gen-copy', 'Copy letter');
    copy.id = 'copyBtn';
    copy.type = 'button';
    result.appendChild(copy);

    copy.addEventListener('click', copyLetter);
  }

  // ---- 3b. Billing pause: email capture still runs, "coming soon" instead
  // of a real letter. An already-unlocked visitor skips straight to the
  // message with no form at all. ----
  function renderPaused() {
    result.innerHTML = '';
    result.style.display = 'block';

    if (isUnlocked()) {
      showComingSoon();
      return;
    }

    result.appendChild(el('h2', 'supp-ingredients-heading', 'Almost ready'));
    var overlay = el('div', 'gen-overlay');
    overlay.appendChild(el('p', 'gen-overlay-title', 'Enter your email to get notified'));
    overlay.appendChild(
      el('p', 'gen-overlay-sub', "We're putting the finishing touches on this generator. Leave your email and you'll have full access the moment it's ready — and it unlocks every generator on Kibbo, not just this one.")
    );
    overlay.appendChild(buildEmailCaptureBox(showComingSoon, 'Notify me — free', 'Submitting…'));
    result.appendChild(overlay);
  }

  // Plain text, no box/border/error styling -- an intentional "coming soon"
  // state, not an error. Reuses .supp-subtext (already plain-text-only,
  // no new CSS needed).
  function showComingSoon() {
    result.innerHTML = '';
    result.style.display = 'block';
    result.appendChild(el('h2', 'supp-ingredients-heading', "You're all set"));
    result.appendChild(
      el(
        'p',
        'supp-subtext',
        "Thanks — you're all set! We're putting the finishing touches on this generator and it'll be ready to create your document very soon. We'll have it live within the next few days — no need to do anything else, just check back here."
      )
    );
  }

  // ---- 5. Retrieve and reveal the full letter (free -- no license check) ----
  function unlockFullLetter() {
    var msg = document.getElementById('unlockMsg');
    var unlockBtn = document.getElementById('unlockBtn');

    fetch(WORKER_URL + '/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        generatorId: cfg.id,
        previewId: state.previewId,
        answers: state.answers,
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
        if (msg) setMsg(msg, (r.data && r.data.message) || 'Could not retrieve your full letter. Please try again.', 'err');
        else showError('Could not retrieve your full letter. Please try generating the preview again.');
      })
      .catch(function () {
        if (msg) setMsg(msg, 'Could not reach the unlock service. Please try again.', 'err');
        else showError('Could not reach the unlock service. Please try again.');
      })
      .finally(function () {
        if (unlockBtn) {
          unlockBtn.disabled = false;
          unlockBtn.textContent = 'Unlock full letter — free';
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
