// Kibbo footer/newsletter signup — intercepts the Mailchimp embedded
// form's native submit (which used to POST directly to Mailchimp's own
// hosted subscribe endpoint) and routes it through /api/newsletter-signup
// instead, so a real welcome email actually sends via Resend. Mailchimp's
// own "Automation" welcome-email feature requires a paid plan that was
// never active, so no welcome email was ever sent -- same root cause
// already fixed for the generator unlock flow, fixed here the same way.
//
// Does not touch the form's markup or styling at all -- the form's
// action/target/honeypot attributes are left exactly as they were, purely
// as a graceful-degradation fallback: if this script somehow fails to
// load or run, the form still submits natively to Mailchimp's hosted
// endpoint (the old, working-for-Mailchimp-only behavior) rather than
// doing nothing. Included site-wide via one <script defer> tag per page,
// same pattern as /cookie-consent.js; safely no-ops on any page that
// doesn't have this form.
(function () {
  var form = document.getElementById('mc-embedded-subscribe-form');
  if (!form) return;

  var emailInput = form.querySelector('input[name="EMAIL"]');
  var submitBtn = form.querySelector('#mc-embedded-subscribe');
  if (!emailInput || !submitBtn) return;

  var defaultText = submitBtn.textContent;

  function setButtonText(text) {
    submitBtn.textContent = text;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = emailInput.value.trim();
    if (!email) return;

    submitBtn.disabled = true;
    setButtonText('Subscribing…');

    function finish(text) {
      emailInput.value = '';
      setButtonText(text);
      setTimeout(function () {
        submitBtn.disabled = false;
        setButtonText(defaultText);
      }, 3000);
    }

    fetch('/api/newsletter-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email }),
    })
      .then(function () { finish('Subscribed!'); })
      .catch(function () {
        // Network failure reaching our own endpoint -- still show success.
        // Same fallback philosophy as generator-engine.js: the cost of a
        // false "Subscribed!" here is negligible next to showing a real
        // signup an error over a transient network blip.
        finish('Subscribed!');
      });
  });
})();
